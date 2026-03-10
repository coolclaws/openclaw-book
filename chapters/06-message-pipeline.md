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

路由解析是消息流水线的核心决策点：**这条消息属于哪个 Agent？归入哪个 Session？**

### 输入参数

`resolveAgentRoute` 接收来自渠道适配器提供的路由维度：

```typescript
type ResolveAgentRouteInput = {
  cfg: OpenClawConfig;
  channel: string;       // "telegram" | "discord" | "slack" | ...
  accountId?: string;    // 多账号时的 bot 账号 ID
  peer?: RoutePeer;      // 发送者 { kind: "direct"|"group"|"channel", id }
  parentPeer?: RoutePeer; // 父对话（用于 Discord thread 继承）
  guildId?: string;      // Discord server ID
  teamId?: string;       // MS Teams workspace ID
  memberRoleIds?: string[]; // Discord 用户当前持有的角色 ID 列表
};
```

### 七层匹配：从最窄到最宽

`resolveAgentRoute` 按优先级从高到低依次尝试，**第一个命中的层返回结果，后续层不再评估**：

```
binding 列表
  │
  ├─ 第 1 层：byPeer[peer.kind:peer.id]
  │     最精确匹配：peer kind + ID 完全相同
  │     示例："direct:+8613800001234" / "channel:C1234ABCD"
  │
  ├─ 第 2 层：byPeer[parentPeer.kind:parentPeer.id]
  │     线程继承：当前消息是线程，父对话命中了 peer binding
  │     示例：Discord 子线程消息，父频道有 peer binding → 继承父配置
  │
  ├─ 第 3 层：byGuildWithRoles[guildId]（角色交集过滤）
  │     guild ID 匹配，且 binding.roles ⊆ memberRoleIds
  │     即：用户必须持有 binding 要求的全部角色
  │     示例：Discord server 中只有 @Moderator 角色的消息走特定 Agent
  │
  ├─ 第 4 层：byGuild[guildId]
  │     仅 guild ID 匹配（无角色要求）
  │     示例：Discord server 内所有消息统一路由
  │
  ├─ 第 5 层：byTeam[teamId]
  │     MS Teams workspace 匹配
  │
  ├─ 第 6 层：byAccount（accountId 过滤）
  │     有 accountId 限定但无 peer/guild 的宽泛 binding
  │     示例：特定 Telegram bot 账号的所有消息
  │
  ├─ 第 7 层：byChannel（仅渠道名匹配）
  │     最宽泛，命中该渠道的所有未被前面层命中的消息
  │     示例："channel": "telegram" 匹配所有 Telegram 消息
  │
  └─ default：无任何 binding 命中 → 使用 cfg.agents.list[0] 的 default agent
```

**输出的 `matchedBy` 字段**记录实际命中的层级，可用于调试日志：

```
"binding.peer" | "binding.peer.parent" | "binding.guild+roles"
| "binding.guild" | "binding.team" | "binding.account"
| "binding.channel" | "default"
```

### binding 结构与窄覆盖宽

每条 binding 的配置结构：

```typescript
type AgentBindingMatch = {
  channel: string;       // 必填（渠道名）
  accountId?: string;    // 选填（多账号区分）
  peer?: { kind: ChatType; id: string }; // 选填（特定对话）
  guildId?: string;      // 选填（Discord server）
  teamId?: string;       // 选填（Teams workspace）
  roles?: string[];      // 选填（Discord 角色，仅与 guildId 配合）
};
```

窄覆盖宽的实际配置示例：

```json
{
  "bindings": [
    {
      "match": { "channel": "telegram" },
      "agentId": "general-agent"
    },
    {
      "match": { "channel": "telegram", "peer": { "kind": "direct", "id": "+8613800001234" } },
      "agentId": "vip-agent"
    },
    {
      "match": { "channel": "discord", "guildId": "1234567890" },
      "agentId": "discord-agent"
    },
    {
      "match": { "channel": "discord", "guildId": "1234567890", "roles": ["987654321"] },
      "agentId": "admin-agent"
    }
  ]
}
```

结果：
- 普通 Telegram 消息 → `general-agent`（第 7 层）
- VIP 用户 Telegram DM → `vip-agent`（第 1 层，覆盖第 7 层）
- Discord server 普通成员 → `discord-agent`（第 4 层）
- Discord server 拥有 `987654321` 角色的成员 → `admin-agent`（第 3 层，覆盖第 4 层）

### Session Key 构建

路由确定 Agent 后，`buildAgentSessionKey` 根据 `dmScope` 决定 session 的粒度：

```
dmScope = "main"（默认）:
  所有 DM 合并进同一个主 session
  "{agentId}:main"
  → "general-agent:main"

dmScope = "per-peer":
  每个对话方独立 session
  "{agentId}:{channel}:{accountId}:{peerKind}:{peerId}"
  → "general-agent:telegram:default:direct:user123"

dmScope = "per-channel-peer":
  channel 也参与 session 隔离（多 channel 同 peer 时）

群组消息（不受 dmScope 影响，始终 per-group）:
  "{agentId}:{channel}:{accountId}:{groupKind}:{groupId}"
  → "discord-agent:discord:bot1:channel:channelid789"

Discord 线程（resolveThreadSessionKeys）:
  基础 session key + thread suffix
  → "discord-agent:discord:default:channel:channelid:thread:threadid"
```

**`identityLinks`：跨渠道身份归并**

```typescript
identityLinks?: Record<string, string[]>
// 示例：{ "+8613800001234": ["discord:user:987654321"] }
```

当用户在 Telegram 和 Discord 上是同一个人时，`identityLinks` 将两个不同的 peer ID 映射到同一个 session key，实现跨渠道上下文连续。

---

### 三层缓存：热路径接近 O(1)

路由解析是**每条消息必经的热路径**。三层缓存确保绝大多数消息不需要重新计算：

#### Layer 1：WeakMap（配置级缓存）

```typescript
const evaluatedBindingsCacheByCfg =
  new WeakMap<OpenClawConfig, EvaluatedBindingsCache>();
```

**缓存内容**：将配置中的原始 binding 列表预处理为按 `channel + accountId` 分桶的索引结构。

**Key 为 config 对象引用而非内容哈希**，这是精妙的设计：
- 配置不变时，同一个 config 对象反复复用，WeakMap 直接命中
- 配置热重载（`config.patch`）会创建新的 config 对象，WeakMap key 变了 → 旧缓存自动失效
- WeakMap 不阻止 GC——旧 config 对象没有其他引用时，旧缓存整体被回收
- **零手动失效逻辑**：没有 `invalidateCache()`，没有版本号，没有 TTL

#### Layer 2：Binding Index（类型分桶索引）

Layer 1 的预处理结果：

```typescript
type EvaluatedBindingsIndex = {
  byPeer:           Map<string, EvaluatedBinding[]>;  // key: "kind:id"
  byGuildWithRoles: Map<string, EvaluatedBinding[]>;  // key: guildId
  byGuild:          Map<string, EvaluatedBinding[]>;  // key: guildId
  byTeam:           Map<string, EvaluatedBinding[]>;  // key: teamId
  byAccount:        EvaluatedBinding[];               // 线性扫描
  byChannel:        EvaluatedBinding[];               // 线性扫描
};
```

第 1–5 层（peer / parentPeer / guild+roles / guild / team）都是 `Map.get(key)` → O(1)。

只有第 6、7 层（account、channel）需要线性扫描，但这两层通常只有少量 binding（运维层面配置不会配几百条）。

构建 Index 的过程（Layer 1 预处理时执行，之后缓存）：

```
遍历所有 binding：
  有 peer → byPeer["kind:id"].push(binding)
  有 guildId 且有 roles → byGuildWithRoles[guildId].push(binding)
  有 guildId 无 roles  → byGuild[guildId].push(binding)
  有 teamId → byTeam[teamId].push(binding)
  有 accountId 无以上 → byAccount.push(binding)
  否则 → byChannel.push(binding)
```

#### Layer 3：Resolved Route Cache（结果级缓存）

```typescript
const MAX_RESOLVED_ROUTE_CACHE_KEYS = 4000;
```

缓存的是最终的 `ResolvedAgentRoute`（已包含 agentId、sessionKey、matchedBy 等）。

**Cache Key 构建**：将所有路由维度序列化为字符串：

```
"{channel}:{accountId}:{peerKind}:{peerId}:{parentKind}:{parentId}:{guildId}:{teamId}:{roles_sorted}"
```

角色列表排序后参与 key，确保 `["A","B"]` 和 `["B","A"]` 产生相同的 key。

**淘汰策略：全量清除（不是 LRU）**

```typescript
if (cache.size >= MAX_RESOLVED_ROUTE_CACHE_KEYS) {
  cache.clear();  // 全清，而非 LRU evict
}
```

选择全量清除而非 LRU 的原因：路由参数的组合空间通常是固定的（用户数量 × 渠道数量），在实际部署中几乎不会达到 4000 个不同组合。即使清除，下次请求只需重新计算一次便再次命中，代价极低。LRU 需要维护访问顺序，增加了复杂度和内存开销，不值得。

**三层缓存命中路径总结：**

```
消息到达
  → Layer 3 命中？→ 直接返回已解析路由（最常见）
  → Layer 3 miss →
      Layer 1 命中？→ 使用已有 Index 做七层匹配
      Layer 1 miss →
          预处理所有 binding → 构建 Index → 存入 Layer 1
          → 七层匹配 → 结果存入 Layer 3
```

---

## 6.7 ReplyDispatcher：回复调度的核心设计

**文件：** `src/auto-reply/reply/reply-dispatcher.ts`（246 行）

ReplyDispatcher 是 OpenClaw 消息输出侧的核心结构，承担三个职责：
1. **有序性保证**：tool result → block reply → final reply，绝不乱序
2. **节奏控制**：连续 block 之间随机延迟，避免机器人感
3. **生命周期追踪**：Gateway 优雅关闭时等待所有 pending 回复发完

### Promise 链串行化

ReplyDispatcher 的实现核心是一条**不断向后延伸的 Promise 链**：

```typescript
function createReplyDispatcher(options): ReplyDispatcher {
  let sendChain: Promise<void> = Promise.resolve(); // 链的起点
  let pending = 1;              // 初始 = 1（预留位，下文详述）
  let sentFirstBlock = false;

  const enqueue = (kind, payload) => {
    const normalized = normalizeReplyPayloadInternal(payload);
    if (!normalized) return false;  // 空 payload / 心跳 → 跳过

    pending += 1;
    const shouldDelay = (kind === "block") && sentFirstBlock;

    // 将新任务串接到链尾
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
          unregister();        // 从全局注册表移除
          options.onIdle?.();  // 通知 idle
        }
      });
    return true;
  };

  return {
    sendToolResult: (p) => enqueue("tool", p),
    sendBlockReply: (p) => enqueue("block", p),
    sendFinalReply: (p) => enqueue("final", p),
    markComplete: () => {
      // 延迟释放预留位（详见下节）
      Promise.resolve().then(() => {
        pending -= 1;
        if (pending === 0) { unregister(); options.onIdle?.(); }
      });
    },
    waitForIdle: () => sendChain,
    getQueuedCounts: () => ({ ... }),
  };
}
```

每次 `enqueue` 都把新任务接在 `sendChain` 末尾。前一个任务未完成，后一个绝不开始。即使 Agent 并发产出 tool result 和 block reply，用户看到的消息顺序始终正确。

---

### 预留 pending 防竞态（核心设计）

`pending` 初始值为 `1` 而非 `0`，这个"预留位"（reservation）专门解决一个微妙的竞态窗口。

**场景还原：**

Agent 的主运行循环和 ReplyDispatcher 的发送链是**两条并发路径**。考虑这个时序：

```
时刻 T1：Agent 最后一个 tool 执行完毕
时刻 T2：enqueue("block", lastReply) 被调用
            → pending 从 1 变成 2
时刻 T3：Agent 主循环退出，调用 markComplete()
时刻 T4：sendChain 的 .finally() 执行
            → pending 从 2 减回 1
时刻 T5：markComplete() 内部逻辑执行
            → pending 从 1 减到 0 → 触发 idle ✓
```

如果没有预留位（pending 初始为 0），时序变成：

```
时刻 T1：Agent 最后一个 tool 执行完毕
时刻 T2：sendChain .finally() 恰好在此刻执行
            → pending 从 0 减到 -1 → pending = 0 → 触发 idle ← ✗ 过早！
时刻 T3：enqueue("block", lastReply) 被调用
            → pending 从 -1 变成 0 → 再次触发 idle ← ✗ 重复！
时刻 T4：markComplete() 调用
            → 已无意义，状态已混乱
```

**预留位的语义**：

```
pending = 1  →  "Agent 主流程尚未结束"
               （即使当前发送链为空，也不能宣布 idle）

markComplete() →  Agent 主流程正式结束
                  → 释放预留位
                  → 如果此时 sendChain 也空了 → idle
```

**为什么 markComplete 用 microtask 延迟？**

```typescript
markComplete: () => {
  Promise.resolve().then(() => {   // ← 延迟一个 microtask
    pending -= 1;
    if (pending === 0) { ... onIdle(); }
  });
}
```

假设调用栈是：

```
Agent 主循环退出
  → markComplete() 同步调用
  → 但此刻 enqueue 的 .then() 可能还在微任务队列中排队
```

`Promise.resolve().then(...)` 将"减预留位"的操作推入微任务队列尾部，让当前排队的所有 `.then()` 先执行完毕——也就是说，已经入队的 enqueue 任务至少能先开始，再由 markComplete 判断是否 idle。

这是经典的**"让出当前微任务队列"**技巧，避免了在错误的时间点触发 idle。

**waitForIdle 的使用：**

```typescript
// Gateway 优雅关闭序列
await Promise.all(
  activeDispatchers.map(d => d.waitForIdle())
);
// 此时所有 pending 回复已发出，可以安全关闭
```

`waitForIdle()` 返回的就是 `sendChain`——等待这条链走到终点，即等待所有已入队的回复发送完毕。

---

### 人类延迟（Human Delay）

```typescript
getHumanDelay(options.humanDelay)
// mode="off"    → 0ms（无延迟）
// mode="on"     → random(800ms, 2500ms)（默认）
// mode="custom" → random(cfg.min, cfg.max)
```

在**非首个** block reply 之前插入随机延迟：

```
Block 1 → 立即发出（用户等了 AI 已够久）
Block 2 → 等待 random(800, 2500)ms 后发出
Block 3 → 等待 random(800, 2500)ms 后发出
...
```

`sentFirstBlock` flag 在第一个 block 发出后置 true，后续 block 才启用延迟。这个设计让连续消息看起来像人在打字，而不是瞬间刷出一墙字。

---

### 全局 Dispatcher 注册表

**文件：** `src/auto-reply/reply/dispatcher-registry.ts`

```typescript
// 每个 dispatcher 创建时向注册表登记
registerDispatcher({
  pending: () => pending,
  waitForIdle: () => sendChain,
});
// → 返回 { id, unregister }

// idle 时（pending === 0）调用 unregister() 自动移除

// Gateway 优雅关闭时查询
getTotalPendingReplies()
// → 遍历所有活跃 dispatcher，求 pending 之和
```

注册表是 Gateway 优雅关闭的最后一道门：只有 `getTotalPendingReplies() === 0`，关闭流程才能继续。确保任何正在进行的 Agent turn 的最后一条回复都能被完整发出，不因 Gateway 关闭而截断。

---

### 带 Typing Indicator 的变体

`createReplyDispatcherWithTyping` 在基础 dispatcher 上叠加 typing indicator 生命周期：

```typescript
type ReplyDispatcherWithTypingResult = {
  dispatcher: ReplyDispatcher;
  replyOptions: Pick<GetReplyOptions, "onReplyStart" | "onTypingController" | "onTypingCleanup">;
  markDispatchIdle: () => void;
  markRunComplete: () => void;  // Agent 运行完成信号（区别于 dispatcher.markComplete）
};
```

状态机：
```
Agent 开始运行 → 显示 typing indicator（"正在输入..."）
  ↓
第一个 block reply 发出 → 停止 typing indicator
  ↓
（用户已开始收到回复，不再需要"等待"提示）
  ↓
Agent 运行完成（markRunComplete）+ dispatcher idle（markDispatchIdle）
  → 清理 typing 资源（onCleanup）
```

渠道不支持 typing indicator 时（webchat 等），相关调用静默无操作。

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
