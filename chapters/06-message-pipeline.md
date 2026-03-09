# 第 6 章 消息流水线：从接收到回复

这是全书最关键的一章。理解消息如何从用户的聊天 App 流经 OpenClaw 并返回 AI 回复，是理解整个系统的钥匙。

## 6.1 消息全链路概览

```
用户在 Telegram 发送 "今天天气怎么样"
        │
        ▼
[渠道适配器] 收到平台原始消息（Telegram Update）
        │ 转换为统一的 WebInboundMsg
        ▼
[媒体理解] 有附件？→ 下载 + 识别（图片/音频/文档）
        │
        ▼
[MsgContext 构建] 填充 60+ 字段的上下文对象
        │
        ▼
[finalizeInboundContext] 安全清洗 + 规范化 + 字段推断
        │
        ▼
[echo-tracker] 检测 echo（自己发的消息，跳过）
        │
        ▼
[command-detection] 检测斜杠命令（/status, /new 等）
        │  (是 → 执行命令，不进入 AI)
        ▼  (否 → 继续)
[group-gating] 群组激活检查（@mention？关键词？）
        │  (群组未激活 → 丢弃)
        ▼  (通过 → 继续)
[resolve-route] 路由解析（七层匹配）→ 确定 Agent + Session
        │
        ▼
[dispatchInboundMessage] 消息分发入口
        │
        ├─ shouldSkipDuplicateInbound() 去重
        ├─ resolveSendPolicy() 发送策略检查
        ├─ fireHook("message_received") fire-and-forget
        ├─ tryDispatchAcpReply() 尝试 ACP 路径
        │
        ▼  (走 embedded Agent 路径)
[getReplyFromConfig] 调用 AI 生成回复
        │
        ▼
[ReplyDispatcher] 回复调度器（Promise 链 + 人类延迟）
        │
        ├─ sendToolResult()  工具中间结果（可选）
        ├─ sendBlockReply()  流式文本块
        └─ sendFinalReply()  最终回复
        │
        ▼
[deliver / route-reply] 渠道发送函数（跨渠道路由）
        │
        ▼
回复出现在用户的 Telegram 聊天中
```

---

## 6.2 消息上下文对象：`MsgContext`

每条进入系统的消息都被构建为一个 `MsgContext`（`auto-reply/templating.ts`）。它包含 60+ 个字段，是整个消息流水线的"中枢数据结构"。

### Body 的多个视图（关键设计）

```typescript
Body?: string;              // 完整消息体（可能含历史上下文）
BodyForAgent?: string;      // 给 Agent 的 prompt（含 envelope/history）
RawBody?: string;           // 裸文本（无结构化上下文）
CommandBody?: string;       // 用于命令检测的文本
BodyForCommands?: string;   // 最优先的命令检测文本（覆盖 CommandBody）
```

**为什么需要多个 Body 变体？** 不同消费者需要不同的文本视图：
- 命令检测需要"干净"的文本（不含历史上下文）
- Agent 需要完整 prompt（含历史、envelope、媒体转录）
- 媒体理解需要转录文本而非原始消息体

### 路由字段

```typescript
From?: string;               // 发送者 ID（E.164 手机号/用户 ID/频道 ID）
To?: string;                 // 接收目标（当前 Bot 的 ID）
SessionKey?: string;         // 路由到的 session key
AccountId?: string;          // 多账号时的 provider 账号 ID
ChatType?: string;           // "direct" | "group" | "channel" | "supergroup"
Surface?: string;            // 当前渠道（"telegram" / "discord" / ...）
Provider?: string;           // provider 标识
OriginatingChannel?: string; // 消息原始来源渠道（跨渠道路由时）
OriginatingTo?: string;      // 消息原始接收目标
ConversationId?: string;     // 渠道层的对话 ID（群 ID / 频道 ID）
```

### 群组相关字段

```typescript
GroupId?: string;            // 群组 ID
GroupName?: string;          // 群组名称
GroupSubject?: string;       // 群组主题（WhatsApp 特有）
GroupParticipants?: string[]; // 成员列表
SenderName?: string;         // 发送者显示名
Mentioned?: boolean;         // 是否被 @mention
```

### 媒体附件字段

```typescript
MediaUrl?: string;           // 单个媒体 URL
MediaUrls?: string[];        // 多个媒体 URL
MediaPath?: string;          // 本地临时文件路径
MediaPaths?: string[];
MediaType?: string;          // MIME type（"image/jpeg" / "audio/ogg" 等）
MediaTypes?: string[];
Transcript?: string;         // 音频/视频转录结果（调用 Whisper 或平台 API）
Caption?: string;            // 媒体附件的文字说明
```

### 消息元数据

```typescript
MessageId?: string;          // 平台消息 ID（用于回复、引用）
QuotedMessageId?: string;    // 被引用的消息 ID
QuotedBody?: string;         // 被引用的消息内容
ThreadId?: string;           // 线程 ID（Discord 线程、Slack 线程）
IsReplyToBot?: boolean;      // 是否在回复 Bot 的消息
Timestamp?: number;          // 消息时间戳（ms）
```

---

## 6.3 媒体理解（Media Understanding）

**文件：** `src/media-understanding/`

在构建 MsgContext 之前，附件消息会经过媒体理解流程：

```
有媒体附件？
  ↓
下载到临时文件（受 maxMediaBytes 限制）
  ↓
识别 MIME type
  ↓
  ├─ image/* → 可选 OCR / 视觉描述（交给 LLM image vision）
  ├─ audio/* → Whisper 转录（本地或 API）
  ├─ video/* → 提取关键帧 + 音轨转录
  └─ document/* → 文本提取（PDF → 文本 / Office → 文本）
  ↓
转录/描述结果写入 MsgContext.Transcript
```

媒体理解是**异步且有条件的**：如果配置中没有配置媒体处理器，附件会被跳过（只传 URL，让 Agent 决定是否处理）。

---

## 6.4 入站文本安全清洗

**文件：** `src/auto-reply/reply/inbound-context.ts`

所有文本字段在进入任何处理逻辑之前，经过两步安全处理：

### 步骤 1：换行符规范化（normalizeInboundTextNewlines）

将 `\r\n`、`\r` 统一为 `\n`。对 prompt 工程至关重要——LLM 对换行符敏感，不一致的换行可能导致意想不到的行为。

### 步骤 2：系统标签清洗（sanitizeInboundSystemTags）

**这是一道 prompt injection 防线。**

OpenClaw 的 system prompt 使用特定标签（`## Tooling`、`## Runtime`、`<available_skills>` 等）。用户消息中如果包含这些标签，可能混淆 LLM 对 system prompt 和用户消息的边界认知，诱导 LLM 执行非预期行为。

清洗函数转义或移除这些潜在的注入标签，确保 LLM 能正确区分"指令"和"数据"。

### 步骤 3：字段推断（finalizeInboundContext）

自动补全可以从现有字段推断的字段：
- 有 `GroupId` 但缺 `ChatType` → 推断为 "group"
- 有 `ThreadId` → 补全线程上下文
- 生成 `ConversationLabel`（用于日志和显示的人类可读描述）

---

## 6.5 群组消息处理

群组消息有特殊的处理路径，涉及三个子系统。

### Echo Tracker（`echo.d.ts`）

```typescript
type EchoTracker = {
  rememberText: (text: string | undefined, opts: {
    combinedBody?: string;
    combinedBodySessionKey?: string;
  }) => void;
  has: (key: string) => boolean;
  forget: (key: string) => void;
};

const echoTracker = createEchoTracker({ maxItems: 500 });
```

**设计目的：** 防止 Bot 回复自己的消息触发死循环。某些平台（如 WhatsApp）会把 Bot 发出的消息也投递给监听者。Echo Tracker 记录最近发出的消息文本，收到消息时先检查是否是自己刚发的。`maxItems: 500` 防止无限增长。

### Group Gating（`group-gating.d.ts`）

群组消息不是所有都需要处理，Gate 决定是否响应：

```typescript
function applyGroupGating(params: ApplyGroupGatingParams):
  | { readonly shouldProcess: false }
  | { shouldProcess: boolean }
```

**激活模式（GroupActivationMode）：**

| 模式 | 处理条件 |
|------|---------|
| `mention` | 只响应 @mention（默认）|
| `all` | 响应群组所有消息 |
| `keyword` | 消息包含配置的关键词才响应 |
| `reply` | 只响应对 Bot 消息的回复 |

`resolveGroupRequireMentionFor` 根据配置和群组 ID 决定具体模式。

### Group History（群组上下文）

群组消息处理时维护一个本地历史队列（`GroupHistoryEntry[]`），用于：
- 群组消息广播（多个 Agent 监听同一群组）
- 为 Agent 提供近期群组对话上下文

`groupHistoryLimit` 控制保留多少条历史。上下文通过 `BodyForAgent` 注入：

```
[GroupHistory]
User1: 你们觉得这个方案怎么样?
User2: 感觉可以，但需要验证
[CurrentMessage]
User3: @Bot 帮我们分析一下
```

---

## 6.6 路由解析：七层匹配 + 三层缓存

**文件：** `src/routing/resolve-route.ts`（804 行）

### 七层匹配优先级

`resolveAgentRoute` 按优先级从高到低尝试：

| 层级 | matchedBy | 匹配条件 | 示例 |
|------|-----------|---------|------|
| 1 | `binding.peer` | peer ID + kind 精确匹配 | 特定 Telegram 用户 / Discord 频道 |
| 2 | `binding.peer.parent` | 父线程的 peer 匹配 | Discord 线程继承父频道路由 |
| 3 | `binding.guild+roles` | Guild ID + 角色列表 | Discord server 中特定角色 |
| 4 | `binding.guild` | 仅 Guild ID | Discord 整个 server |
| 5 | `binding.team` | Team ID | Teams workspace |
| 6 | `binding.account` | Provider 账号 | 多 Bot 账号中的某个 |
| 7 | `binding.channel` | 仅渠道名 | 所有 Telegram 消息 |
| — | default | 无匹配 | 使用默认 Agent |

**宽窄规则组合示例：**

```json
{
  "bindings": [
    { "match": { "channel": "telegram" }, "agentId": "main-agent" },
    { "match": { "channel": "telegram", "peer": { "id": "+8613800001234" } }, "agentId": "vip-agent" }
  ]
}
```

所有 Telegram 消息走 `main-agent`，但特定 VIP 用户走 `vip-agent`——窄规则（peer）覆盖宽规则（channel）。

### 三层缓存优化

路由解析是**热路径**，每条消息都必须执行，缓存是性能关键：

**Layer 1：Evaluated Bindings Cache（WeakMap）**

```typescript
const evaluatedBindingsCacheByCfg = new WeakMap<OpenClawConfig, EvaluatedBindingsCache>();
```

将配置中的 binding 列表预处理为按 `channel + accountId` 索引的结构。以 config 对象为 WeakMap key——配置热重载创建新 config 对象后，旧缓存自动被 GC 回收，不需要手动清理。

**Layer 2：Binding Index（按类型分桶）**

```typescript
type EvaluatedBindingsIndex = {
  byPeer:           Map<string, EvaluatedBinding[]>;  // O(1) peer 查找
  byGuildWithRoles: Map<string, EvaluatedBinding[]>;
  byGuild:          Map<string, EvaluatedBinding[]>;
  byTeam:           Map<string, EvaluatedBinding[]>;
  byAccount:        EvaluatedBinding[];
  byChannel:        EvaluatedBinding[];
};
```

peer 匹配直接 Map lookup，O(1) 完成，无需遍历所有 binding。

**Layer 3：Resolved Route Cache（LRU-like）**

```typescript
const MAX_RESOLVED_ROUTE_CACHE_KEYS = 4000;
```

完整路由结果缓存。key 由所有路由参数（channel、accountId、peerId、guildId、roles 等）组合生成。超过 4000 个 key 后全量清除——路由参数的组合空间通常有限，全量清除简单有效。

### Session Key 构建

路由确定 Agent 后，构建 session key：

```
DM（dmScope="main"，默认）：
  "agent-default:main"

DM（dmScope="per-peer"）：
  "agent-default:telegram:default:direct:user123"

群组消息：
  "agent-default:telegram:default:group:groupid456"

多 Agent + 多账号：
  "work-agent:discord:bot1:channel:channelid789"

Discord 线程（绑定到线程）：
  "agent-default:discord:default:thread:threadid123"
```

`identityLinks` 允许跨渠道身份关联——同一个人在 Telegram 和 Discord 上的不同 ID 可以映射到同一个 session。

---

## 6.7 ReplyDispatcher：回复调度的核心设计

**文件：** `src/auto-reply/reply/reply-dispatcher.ts`（246 行）

### 三个设计约束

1. **有序性**：tool result → block reply → final reply，不能乱序
2. **节奏感**：连续的 block reply 之间需要随机延迟，避免机器人感
3. **生命周期追踪**：Gateway 优雅关闭时需要等待所有 pending 回复发完

### Promise 链串行化

```typescript
export function createReplyDispatcher(options): ReplyDispatcher {
  let sendChain: Promise<void> = Promise.resolve();
  let pending = 1;              // 初始 = 1（预留位）
  let completeCalled = false;
  let sentFirstBlock = false;

  const enqueue = (kind, payload) => {
    // 规范化 payload（加响应前缀、过滤心跳、跳过空回复）
    const normalized = normalizeReplyPayloadInternal(payload);
    if (!normalized) return false;

    pending += 1;
    const shouldDelay = kind === "block" && sentFirstBlock;

    // 串到 Promise 链尾部
    sendChain = sendChain
      .then(async () => {
        if (shouldDelay) await sleep(getHumanDelay(options.humanDelay));
        await options.deliver(normalized, { kind });
        if (kind === "block") sentFirstBlock = true;
      })
      .catch(err => options.onError?.(err, { kind }))
      .finally(() => {
        pending -= 1;
        if (pending === 0) {
          unregister();       // 从全局注册表移除
          options.onIdle?.(); // 通知 idle
        }
      });
    return true;
  };
```

所有回复通过同一条 `sendChain` 顺序发送。即使 Agent 并发产生多个结果，用户看到的消息顺序始终正确。

### 预留 pending 计数（防竞态）

`pending` 初始为 `1` 是"预留位"（reservation），解决一个微妙的竞态：

```
场景：Agent 运行结束，markComplete() 被调用，
      但最后一个 enqueue() 还在执行中

没有预留位时：
  最后一个 finally() 执行 → pending = 0 → 触发 idle
  markComplete() 执行 → 已经 idle，不再减一
  ✗ 但 markComplete 实际上还没减那个"1"

有预留位时：
  最后一个 finally() → pending = 1（还剩预留位）
  markComplete() 通过 microtask 延迟执行 → pending = 0 → idle
  ✓ 正确
```

`markComplete()` 用 `Promise.resolve().then(...)` 延迟释放预留位——让最后的 enqueue 调用有一个 microtask 的窗口先执行 `.finally()`。

### 人类延迟（Human Delay）

```typescript
getHumanDelay(options.humanDelay)
// mode="off" → 0ms（无延迟）
// mode="on"  → random(800ms, 2500ms)（默认）
// mode="custom" → random(cfg.min, cfg.max)
```

在连续的 block reply 之间添加随机延迟，使回复节奏更自然。**第一个 block 不延迟**——用户已经等了 AI 思考的时间，不应再等额外延迟。

### 全局 Dispatcher 注册表

```typescript
// dispatcher-registry.ts
const activeDispatchers = new Set<ReplyDispatcher>();

function register(d: ReplyDispatcher) { activeDispatchers.add(d); }
function unregister(d: ReplyDispatcher) { activeDispatchers.delete(d); }

// Gateway 优雅关闭时：
function getTotalPendingReplies(): number {
  return sum(activeDispatchers, d => d.getPendingCount());
}
```

Gateway 在关闭时等待 `getTotalPendingReplies() === 0`，确保所有用户消息都被完整发出。

### 带 Typing Indicator 的变体

`createReplyDispatcherWithTyping` 在基础 dispatcher 上叠加 typing indicator 控制：
- 收到第一个 tool result / block reply 之前：显示"正在输入..."
- 第一个 block reply 发出后：停止 typing indicator（用户开始看到回复）
- 渠道不支持 typing indicator 时：静默跳过

---

## 6.8 dispatchReplyFromConfig：分发核心

**文件：** `src/auto-reply/reply/dispatch-from-config.ts`（590 行）

### 步骤 1：Echo 去重

```typescript
if (shouldSkipDuplicateInbound(ctx)) return { queuedFinal: false };
```

通过 `MessageSid`（平台消息 ID）检测重复投递（某些渠道如 WhatsApp Baileys 会重复投递同一条消息）。

### 步骤 2：Hook 触发（fire-and-forget）

```typescript
// 插件 hook
if (hookRunner?.hasHooks("message_received")) {
  fireAndForgetHook(hookRunner.runMessageReceived(...));
}
// 内部 HOOK.md 系统
triggerInternalHook(createInternalHookEvent("message", "received", ...));
```

**Fire-and-forget 是有意为之的：** 插件 hook 失败不应阻塞消息处理。这是一个关键的设计选择——插件是辅助性的，不应成为单点故障。

### 步骤 3：Ack 反应（Ack Reaction）

```typescript
// 某些渠道支持用 emoji 反应确认消息已收到
maybeSendAckReaction({ cfg, msg, agentId, sessionKey });
```

在 Discord/Slack 等支持 reaction 的渠道，可以配置一个 emoji 作为"消息已收到"的确认，让用户知道 Bot 正在处理，而不是没有看到消息。

### 步骤 4：跨渠道路由判断

```typescript
const shouldRouteToOriginating = Boolean(
  !isInternalWebchatTurn &&
  isRoutableChannel(originatingChannel) &&
  originatingTo &&
  originatingChannel !== currentSurface,
);
```

**场景：** 一个 session 绑定了多个渠道。用户从 Telegram 发消息，但这个 session 的 "surface" 配置是 Slack。此时回复应路由到 `OriginatingChannel`（Telegram），而不是 `currentSurface`（Slack）。

### 步骤 5：发送策略

```typescript
const sendPolicy = resolveSendPolicy({ cfg, entry, sessionKey, channel, chatType });
if (sendPolicy === "deny") return { queuedFinal: false };
```

允许在配置中静音特定 session 或渠道（调试用），或限制 Agent 只能收消息不能发消息。

### 步骤 6：ACP vs Embedded 路径选择

```typescript
const acpDispatch = await tryDispatchAcpReply({ ctx, cfg, dispatcher });
if (acpDispatch) return acpDispatch;
```

ACP（Agent Control Protocol）是连接外部 Agent 系统（Claude Code、Codex）的路径。如果当前 session 是 ACP session，消息路由到对应的 ACP harness，而不进入内置 Pi 引擎。这体现了 OpenClaw 向更开放 Agent 生态演进的设计意图。

### 步骤 7：AI 回复生成与三路回调

```typescript
const replyResult = await getReplyFromConfig(ctx, {
  onToolResult: (payload) => {
    // tool summary 是否发给用户
    // 群聊通常静默（shouldSendToolSummaries）
    // DM 可以展示工具调用进度
  },
  onBlockReply: (payload, context) => {
    // 过滤推理内容（通用渠道没有 reasoning 展示区）
    // 累积文本用于 TTS 合成
    // Telegram 有专用 reasoning 展示路径
  },
}, cfg);
```

三个回调对应 AI 回复的三个阶段：

| 回调 | 触发时机 | 是否必发给用户 |
|------|---------|-------------|
| `onToolResult` | 工具调用完成 | 取决于 `shouldSendToolSummaries` |
| `onBlockReply` | 流式文本 chunk | 通常发（但 reasoning 内容会过滤）|
| 最终 `replyResult` | Agent 回复完成 | 总是发 |

### 步骤 8：TTS 边界情况处理

```typescript
// block 已流式发送，但 replies 为空时，TTS 需要从 block 文本合成
if (ttsMode === "final" && replies.length === 0 && blockCount > 0) {
  const ttsReply = await maybeApplyTtsToPayload({ text: accumulatedBlockText });
  if (ttsReply.mediaUrl) {
    // 只发音频，不重复发文本
    dispatcher.sendFinalReply({ mediaUrl: ttsReply.mediaUrl, audioAsVoice: true });
  }
}
```

---

## 6.9 命令系统

**文件：** `src/auto-reply/commands-registry.data.ts`

命令检测在 AI 调用之前执行，拦截 `/` 开头的控制指令。

### 声明式命令定义

命令以声明式数据定义（不是硬编码逻辑），包含：

```typescript
type CommandDefinition = {
  name: string;          // 主命令名（"new"）
  aliases?: string[];    // 别名（["reset", "clear"]）
  args?: string[];       // 参数定义（["model?", "level?"]）
  ownerOnly?: boolean;   // 是否仅 owner 可用
  groupAllowed?: boolean; // 群组中是否可用
  description: string;
};
```

典型命令：

| 命令 | 别名 | 功能 |
|------|------|------|
| `/new` | `/reset`, `/clear` | 重置 session 历史 |
| `/status` | `/stat` | 展示 session 状态（token 使用等）|
| `/compact` | — | 手动压缩历史 |
| `/model <name>` | — | 切换模型 |
| `/think <level>` | — | 切换思考级别 |
| `/verbose` | — | 开关详细输出 |
| `/subagents` | — | 列出子 Agent |
| `/restart` | — | 重启 Gateway（owner only）|

### 命令 Body 的清洗

群组消息中，用户可能写 `/status@BotName`（Telegram 群组格式）。`stripMentionsForCommand` 移除命令文本中的 `@mention` 部分，让命令解析器只看到 `/status`。

---

## 6.10 心跳系统（Heartbeat）

**文件：** `src/web/auto-reply/heartbeat-runner.d.ts`

心跳 Runner 定期向 main session 注入系统事件（heartbeat 消息），让 Agent 执行定期检查任务：

```
定时触发（默认 30 分钟）
  ↓
生成 heartbeat systemEvent 注入 main session
  ↓
Agent 收到 → 读取 HEARTBEAT.md → 按任务列表检查
  ↓
有需要处理的事项 → 发送通知
没有 → 回复 HEARTBEAT_OK
```

心跳 Runner 与 Cron 的区别：
- 心跳走 main session（有历史上下文），适合需要联系上下文的检查
- Cron 走独立 isolated session，适合精确定时、无上下文的任务

---

## 6.11 消息广播（Group Broadcast）

**文件：** `src/web/auto-reply/monitor/broadcast.d.ts`

在某些配置中，一条群组消息需要广播给**多个** Agent 处理：

```typescript
function maybeBroadcastMessage(params: {
  cfg, msg, peerId, route,
  groupHistoryKey,
  groupHistories,
  processMessage,  // 处理单条消息的函数（对每个 Agent 调用）
}): Promise<boolean>
```

典型场景：一个群组同时关联了 main Agent 和 monitoring Agent，main Agent 负责回复，monitoring Agent 负责记录和分析。

---

## 6.12 本章要点

消息流水线的核心设计思想：

| 设计点 | 解决的问题 |
|-------|---------|
| 多视图 Body | 不同消费者（命令检测/Agent/TTS）需要不同的文本形式 |
| Prompt Injection 防护 | 清洗系统标签，防止用户消息污染 system prompt 边界 |
| 七层路由匹配 | 支持从"所有消息"到"特定用户"的精细路由规则 |
| 三层路由缓存 | WeakMap + Index + LRU，热路径接近 O(1) |
| Promise 链串行化 | 多个并发结果按顺序发出 |
| 预留 pending 防竞态 | markComplete 和最后 enqueue 之间的微妙时序 |
| 人类延迟 | 连续 block 之间随机延迟，节奏更自然 |
| Fire-and-forget Hook | 插件不阻塞主流程，失败静默处理 |
| ACP 路径 | 外部 Agent 系统可以接管消息处理 |
| Echo Tracker | 防止 Bot 自己的消息触发死循环 |
| Group Gating | 精细控制群组消息的激活条件 |

### 推荐阅读的源文件

| 文件 | 优先级 | 行数 | 说明 |
|------|--------|------|------|
| `src/auto-reply/reply/dispatch-from-config.ts` | ★★★ | 590 | 分发核心，完整回复流程 |
| `src/auto-reply/reply/reply-dispatcher.ts` | ★★★ | 246 | 回复顺序控制 + 生命周期 |
| `src/routing/resolve-route.ts` | ★★★ | 804 | 七层路由匹配 + 三层缓存 |
| `src/auto-reply/templating.ts` | ★★★ | — | MsgContext 完整定义（60+ 字段）|
| `src/auto-reply/reply/inbound-context.ts` | ★★ | — | 安全清洗 + prompt injection 防护 |
| `src/web/auto-reply/monitor/group-gating.ts` | ★★ | — | 群组激活策略 |
| `src/web/auto-reply/monitor/echo.ts` | ★★ | — | Echo Tracker |
| `src/auto-reply/reply/route-reply.ts` | ★★ | — | 跨渠道回复路由 |
| `src/auto-reply/commands-registry.data.ts` | ★ | — | 命令声明式定义 |
| `src/web/auto-reply/heartbeat-runner.ts` | ★ | — | 心跳 Runner |
