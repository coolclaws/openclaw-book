# 第 6 章 消息流水线：从接收到回复

这是全书最关键的一章。理解消息如何从用户的聊天 App 流经 OpenClaw 并返回 AI 回复，是理解整个系统的钥匙。

## 6.1 消息全链路概览

```
用户在 Telegram 发送 "今天天气怎么样"
        │
        ▼
[渠道适配器] 收到平台原始消息
        │
        ▼
[MsgContext 构建] 填充 60+ 字段的上下文对象
        │
        ▼
[finalizeInboundContext] 安全清洗 + 规范化
        │
        ▼
[command-detection] 检测斜杠命令（/status, /new 等）
        │  (是 → 执行命令，不进入 AI)
        ▼  (否 → 继续)
[dispatchInboundMessage] 消息分发入口
        │
        ├─ [shouldSkipDuplicateInbound] 去重检查
        ├─ [resolveSendPolicy] 发送策略检查
        ├─ [tryDispatchAcpReply] 尝试 ACP 路径
        │
        ▼  (走 embedded 路径)
[getReplyFromConfig] 调用 AI 生成回复
        │
        ▼
[ReplyDispatcher] 回复调度器
        │
        ├─ sendToolResult()  工具中间结果
        ├─ sendBlockReply()  流式文本块
        └─ sendFinalReply()  最终回复
        │
        ▼
[deliver] 渠道发送函数
        │
        ▼
回复出现在用户的 Telegram 聊天中
```

## 6.2 消息上下文对象：`MsgContext`

每条进入系统的消息都被构建为一个 `MsgContext` 对象（定义在 `auto-reply/templating.ts`）。这不是一个简单的 DTO——它包含 60+ 个字段，承载着消息的全部元信息。以下是按类别整理的关键字段：

**消息正文（有多个变体，这是关键设计）**：

```typescript
Body?: string;              // 完整消息体（可能含历史上下文）
BodyForAgent?: string;       // 给 Agent 的 prompt（可能含 envelope/history）
RawBody?: string;            // 裸文本（无结构化上下文），CommandBody 的遗留别名
CommandBody?: string;        // 用于命令检测的文本
BodyForCommands?: string;    // 最优先的命令检测文本
```

为什么需要这么多 Body 变体？因为不同的下游消费者需要不同的文本视图：命令检测需要"干净"的文本（不含历史上下文），Agent 需要完整的 prompt（含历史），媒体理解需要转录文本。这种多视图设计避免了在单个字段上做复杂的判断。

**路由信息**：

```typescript
From?: string;               // 发送者 ID
To?: string;                 // 接收目标
SessionKey?: string;         // 路由到的 session
AccountId?: string;          // 多账号时的 provider 账号 ID
ChatType?: string;           // "direct" | "group" | "channel"
Surface?: string;            // 当前渠道（如 "telegram"）
Provider?: string;           // provider 标识
OriginatingChannel?: string; // 消息原始来源渠道（跨渠道路由时有用）
OriginatingTo?: string;      // 原始目标
```

**媒体附件**：

```typescript
MediaUrl?: string;           // 单个媒体 URL
MediaUrls?: string[];        // 多个媒体 URL
MediaPath?: string;          // 本地文件路径
MediaPaths?: string[];       // 多个本地路径
MediaType?: string;          // MIME type
MediaTypes?: string[];
Transcript?: string;         // 音频转录结果
```

## 6.3 入站文本安全清洗

在进入任何处理逻辑之前，所有文本字段都经过安全清洗（`finalizeInboundContext`）。这包含两个关键步骤：

**1. 换行符规范化**（`normalizeInboundTextNewlines`）：将各种换行符变体（`\r\n`、`\r`）统一为 `\n`。这看似简单，但对 prompt 工程至关重要——LLM 对换行符敏感，不一致的换行可能导致意想不到的行为。

**2. 系统标签清洗**（`sanitizeInboundSystemTags`）：这是一道 **prompt injection 防线**。OpenClaw 在 system prompt 中使用特定的标签结构（如 `## Tooling`、`## Runtime` 等），如果用户消息中包含这些标签，可能会混淆 LLM 对 system prompt 和用户消息的边界认知。清洗函数会转义或移除这些潜在的注入标签。

`finalizeInboundContext` 还负责推断缺失字段：如果 `ChatType` 未设置但可以从其他字段推断（如存在 `GroupId`），会自动补全。`ConversationLabel`（用于日志和显示的会话描述）也在此步骤生成。

## 6.4 ReplyDispatcher：回复调度的核心设计

`ReplyDispatcher` 是整个消息流水线中最精巧的设计之一。它解决了一个棘手的问题：**AI 回复不是一次性返回的，而是一个流式过程，中间可能穿插工具调用结果、流式文本块和最终回复**。

### 设计约束

1. **回复必须有序**：tool result → block reply → final reply，不能乱序到达用户
2. **人类节奏感**：连续的 block reply 之间需要延迟，避免机器人感
3. **生命周期追踪**：Gateway 重启时需要等待所有 pending 回复发送完毕
4. **跨渠道路由**：如果消息来自 Telegram 但 session 在 Slack 上处理，回复需要路由回 Telegram

### 核心实现

```typescript
export function createReplyDispatcher(options: ReplyDispatcherOptions): ReplyDispatcher {
  let sendChain: Promise<void> = Promise.resolve();  // 串行 Promise 链
  let pending = 1;       // 1 是"预留位"，防止过早 idle
  let completeCalled = false;
  let sentFirstBlock = false;

  const enqueue = (kind: ReplyDispatchKind, payload: ReplyPayload) => {
    // 1. 规范化 payload（加响应前缀、过滤心跳、跳过空回复）
    const normalized = normalizeReplyPayloadInternal(payload, ...);
    if (!normalized) return false;

    pending += 1;

    // 2. 人类延迟判断（仅在非首个 block 之间）
    const shouldDelay = kind === "block" && sentFirstBlock;

    // 3. 串到 Promise 链上保证顺序
    sendChain = sendChain
      .then(async () => {
        if (shouldDelay) {
          await sleep(getHumanDelay(options.humanDelay)); // 800-2500ms 随机
        }
        await options.deliver(normalized, { kind });
      })
      .catch(err => options.onError?.(err, { kind }))
      .finally(() => {
        pending -= 1;
        if (pending === 1 && completeCalled) pending -= 1; // 清除预留位
        if (pending === 0) {
          unregister();        // 从全局注册表移除
          options.onIdle?.();  // 通知 idle
        }
      });
    return true;
  };
```

#### 关键设计点解读

**Promise 链串行化**：所有回复通过同一条 `sendChain` 顺序发送。每个 `enqueue` 调用都将一个新的 `.then()` 追加到链尾。这保证了即使 AI 并发产生多个结果，用户看到的消息顺序始终正确。

**预留 pending 计数**：初始 `pending = 1` 是一个"预留位"（reservation）。这防止了一种竞态条件——如果 Agent 运行结束（`markComplete` 被调用）但最后一个 enqueue 还在执行中，没有预留位的话 pending 会归零触发 idle，但实际上还有回复在路上。`markComplete()` 会通过 microtask（`Promise.resolve().then(...)`）延迟释放预留位，给最后的 enqueue 调用一个执行窗口。

**人类延迟**（Human Delay）：`getHumanDelay()` 在连续 block reply 之间添加 800-2500ms 的随机延迟，使节奏更自然。但第一个 block 不延迟——因为用户已经等了 AI 思考的时间。可通过 `humanDelay` 配置为 `off`（禁用）、`on`（默认范围）、`custom`（自定义 min/max）。

**全局 Dispatcher 注册表**：每个 ReplyDispatcher 在创建时注册到全局注册表（`dispatcher-registry.ts`）。Gateway 在优雅关闭时遍历注册表，等待所有 pending dispatcher 完成。这避免了用户看到"消息被截断"的体验。

### 带 Typing Indicator 的变体

`createReplyDispatcherWithTyping` 在基础 dispatcher 上叠加了 typing indicator 控制。当 Agent 在"思考"时，聊天界面会显示"正在输入..."。typing controller 在第一个 block reply 发出后停止显示，因为此时用户已经开始看到回复了。

## 6.5 dispatchReplyFromConfig：调度核心

`dispatch-from-config.ts` 是消息分发的核心函数（590 行），它协调整个回复生成过程。以下是其关键决策路径：

### 步骤 1：去重检查

```typescript
if (shouldSkipDuplicateInbound(ctx)) {
  recordProcessed("skipped", { reason: "duplicate" });
  return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
}
```

某些渠道（如 WhatsApp 使用的 Baileys 库）可能重复投递同一条消息。去重机制通过 `MessageSid`（消息 ID）检测并跳过重复。

### 步骤 2：触发 Hook（fire-and-forget）

```typescript
// 插件 hook
if (hookRunner?.hasHooks("message_received")) {
  fireAndForgetHook(hookRunner.runMessageReceived(...));
}
// 内部 hook（HOOK.md 发现系统）
triggerInternalHook(createInternalHookEvent("message", "received", sessionKey, ...));
```

Hook 是 fire-and-forget 的——失败不影响主流程。这是一个重要的设计选择：**插件不应该有能力阻塞消息处理**。如果某个插件的 hook 崩溃了，消息仍然正常处理。

### 步骤 3：跨渠道路由判断

```typescript
const shouldRouteToOriginating = Boolean(
  !isInternalWebchatTurn &&
  isRoutableChannel(originatingChannel) &&
  originatingTo &&
  originatingChannel !== currentSurface,
);
```

这段逻辑处理一个关键场景：**跨渠道路由**。假设配置了多 Agent binding，一条 Telegram 消息被路由到一个 session，但这个 session 的 "surface" 是 Slack（比如之前 Slack 上也有消息进入了同一个 session）。此时回复不应发到 Slack，而应路由回 Telegram——消息原始来源的渠道。`OriginatingChannel` 和 `OriginatingTo` 字段就是为此设计的。

### 步骤 4：发送策略

```typescript
const sendPolicy = resolveSendPolicy({ cfg, entry, sessionKey, channel, chatType });
if (sendPolicy === "deny" && !bypassAcpForCommand) {
  return { queuedFinal: false, ... };
}
```

发送策略允许在配置中阻止某些 session 的回复（如临时静音某个群组），或限制 Agent 在特定渠道上只能接收不能发送。

### 步骤 5：ACP vs Embedded 路径选择

```typescript
const acpDispatch = await tryDispatchAcpReply({ ctx, cfg, dispatcher, ... });
if (acpDispatch) return acpDispatch;
```

ACP（Agent Control Protocol）是一个较新的替代路径，用于与外部 Agent 系统集成。如果 ACP 路径处理了消息，就不走内置的 embedded Agent。这体现了 OpenClaw 向更开放的 Agent 生态演进的设计意图——你可以用自己的 Agent 系统替代内置的 Pi。

### 步骤 6：调用 AI 并处理回复流

```typescript
const replyResult = await getReplyFromConfig(ctx, {
  onToolResult: (payload) => {
    // 1. 可能附加 TTS 音频
    // 2. 判断是否需要发送（群聊通常不发 tool summaries）
    // 3. 跨渠道路由或本地 dispatch
  },
  onBlockReply: (payload, context) => {
    // 1. 过滤推理内容（通用渠道不展示 reasoning）
    // 2. 累积文本用于后续 TTS 合成
    // 3. 可能附加 TTS
    // 4. 路由或 dispatch
  },
}, cfg);
```

三个回调的设计反映了 AI 回复的三个阶段：

- **`onToolResult`**：Agent 调用了工具（如搜索），工具返回了结果。是否发送给用户取决于 `shouldSendToolSummaries`——群聊中通常静默，DM 中可以展示。
- **`onBlockReply`**：Agent 在流式输出文本。会**过滤掉 reasoning payload**（推理过程），因为通用渠道没有专门的推理展示区。Telegram 有自己的分发路径，可以将 reasoning 和回复分开展示。
- 最终 `replyResult` 是完整回复数组。

### 步骤 7：Block 流式后的 TTS 补偿

一个精巧的边界情况处理：当 block streaming 成功发送了所有文本，但没有 final reply 时（`replies.length === 0 && blockCount > 0`），累积的 block 文本仍然需要 TTS：

```typescript
if (ttsMode === "final" && replies.length === 0 && blockCount > 0) {
  const ttsReply = await maybeApplyTtsToPayload({ text: accumulatedBlockText, kind: "final" });
  if (ttsReply.mediaUrl) {
    // 发送仅音频的 payload（无文本，避免与已发的 block 文本重复）
    dispatcher.sendFinalReply({ mediaUrl: ttsReply.mediaUrl, audioAsVoice: true });
  }
}
```

## 6.6 路由解析：resolve-route.ts 的多层匹配

路由解析（804 行）决定消息由哪个 Agent 的哪个 Session 处理。这是一个复杂的多层匹配系统，为多 Agent 场景设计。

### Binding 机制

用户可以在配置中定义 bindings，将特定渠道/群组/用户路由到特定 Agent：

```json
{
  "bindings": [
    { "match": { "channel": "discord", "peer": { "kind": "group", "id": "123" } }, "agentId": "work-agent" },
    { "match": { "channel": "telegram", "accountId": "bot1" }, "agentId": "personal-agent" },
    { "match": { "channel": "discord", "guildId": "456", "roles": ["admin"] }, "agentId": "admin-agent" }
  ]
}
```

### 七层匹配优先级

`resolveAgentRoute` 函数按优先级从高到低尝试七个匹配层级：

| 层级 | matchedBy | 匹配条件 | 说明 |
|------|-----------|---------|------|
| 1 | `binding.peer` | 精确匹配 peer ID + kind | 最精确：指定群组或用户 |
| 2 | `binding.peer.parent` | 匹配父线程的 peer | 线程继承父级的路由 |
| 3 | `binding.guild+roles` | Guild ID + 角色 | Discord 特有：某 server 的特定角色 |
| 4 | `binding.guild` | 仅 Guild ID | Discord 特有：整个 server |
| 5 | `binding.team` | Team ID | Teams 特有 |
| 6 | `binding.account` | Provider 账号 | 多 bot 账号场景 |
| 7 | `binding.channel` | 仅渠道名 | 最宽泛：所有 Telegram 消息 |
| - | `default` | 无匹配 | 使用默认 Agent |

这个优先级设计让用户可以设置"宽规则"然后用"窄规则"覆盖。例如：所有 Discord 消息走 Agent A（channel 级），但某个特定频道走 Agent B（peer 级）。

### 性能优化：三层缓存

路由解析是热路径——每条消息都要走一遍。OpenClaw 使用了三层缓存来避免重复计算：

**Layer 1：Evaluated Bindings Cache**

```typescript
const evaluatedBindingsCacheByCfg = new WeakMap<OpenClawConfig, EvaluatedBindingsCache>();
```

将配置中的 binding 列表预处理为按 `channel + accountId` 索引的结构。使用 `WeakMap` 以 config 对象为 key——config 热重载创建新的 config 对象后，旧缓存自动被 GC 回收。

**Layer 2：Binding Index**（按匹配类型分桶）

```typescript
type EvaluatedBindingsIndex = {
  byPeer: Map<string, EvaluatedBinding[]>;
  byGuildWithRoles: Map<string, EvaluatedBinding[]>;
  byGuild: Map<string, EvaluatedBinding[]>;
  byTeam: Map<string, EvaluatedBinding[]>;
  byAccount: EvaluatedBinding[];
  byChannel: EvaluatedBinding[];
};
```

这避免了每次匹配时遍历所有 bindings。peer 匹配直接通过 Map lookup O(1) 完成。

**Layer 3：Resolved Route Cache**

```typescript
const MAX_RESOLVED_ROUTE_CACHE_KEYS = 4000;
```

完整的路由结果缓存。key 由所有路由参数组合生成，超过 4000 个 key 后全量清除（简单但有效的淘汰策略——路由参数的组合空间通常有限）。

### Session Key 构建

确定 Agent 后，构建 session key。key 的格式取决于消息类型和 `dmScope` 配置：

```
DM（默认 dmScope="main"）：
  "agent-default:main"

DM（dmScope="per-peer"）：
  "agent-default:telegram:default:direct:user123"

群组消息：
  "agent-default:telegram:default:group:groupid456"

多 Agent + 多账号：
  "work-agent:discord:bot1:channel:channelid789"
```

`identityLinks` 配置允许跨渠道身份关联——同一个人在 Telegram 和 Discord 上使用不同 ID，但可以映射到同一个 session。

## 6.7 命令系统

命令检测在 AI 调用之前执行，拦截以 `/` 开头的控制指令。

### 命令注册表

命令以声明式数据定义在 `commands-registry.data.ts`，由 `commands-registry.ts` 加载为运行时注册表。支持别名（`/new` 和 `/reset` 是同一个命令）和参数解析（`/think high`）。

### 命令认证

`command-auth.ts` 实现分层权限：某些命令所有人可用（`/status`），某些仅 owner 可用（`/restart`），某些在群组中有额外限制。

## 6.8 本章要点

消息流水线的核心设计思想：

1. **多视图 Body**：同一消息为不同消费者提供不同的文本视图，避免复杂的字段复用
2. **安全清洗前置**：所有文本在进入逻辑之前先经过 injection 防护
3. **Promise 链串行化**：ReplyDispatcher 通过 Promise 链保证回复有序
4. **预留计数防竞态**：pending reservation 机制避免生命周期管理的竞态条件
5. **七层路由匹配**：从精确到宽泛的层级匹配，辅以三层缓存优化
6. **Fire-and-forget Hook**：插件不阻塞主流程，失败静默处理
7. **跨渠道路由**：OriginatingChannel 机制确保回复回到正确的渠道

### 推荐阅读的源文件

| 文件 | 优先级 | 行数 | 说明 |
|------|--------|------|------|
| `src/auto-reply/reply/dispatch-from-config.ts` | ★★★ | 590 | 调度核心，理解整个回复流程 |
| `src/auto-reply/reply/reply-dispatcher.ts` | ★★★ | 246 | ReplyDispatcher 实现，理解回复顺序控制 |
| `src/routing/resolve-route.ts` | ★★★ | 804 | 路由解析，理解多层匹配和缓存设计 |
| `src/auto-reply/templating.ts` | ★★ | - | MsgContext 类型定义（60+ 字段） |
| `src/auto-reply/reply/inbound-context.ts` | ★★ | - | 入站上下文安全清洗 |
| `src/auto-reply/reply/route-reply.ts` | ★ | - | 跨渠道回复路由 |
| `src/auto-reply/commands-registry.data.ts` | ★ | - | 命令定义 |
