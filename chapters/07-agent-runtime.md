# 第 7 章 Agent 运行时与 Pi 引擎

## 7.1 Pi 引擎概述

OpenClaw 将 AI Agent 运行时称为 **Pi**。它不是一个简单的 API 调用包装——而是一个完整的 Agent 执行引擎。整个 `src/agents/` 目录（5.6MB, 210+ 文件）围绕 Pi 引擎构建，是整个项目中最大也最复杂的模块。

Pi 引擎的核心职责链：

```
接收用户消息
  → 解析并发 lane
    → 选择模型 + 解析 auth profile
      → 构建 system prompt + 工具集
        → 调用 LLM API（streaming）
          → 处理流式事件（文本/工具调用/推理）
            → 执行工具调用 → 将结果追加到消息 → 再次调用 LLM
              → 所有工具调用结束，返回最终文本
                → 追踪 token 使用量
                  → 如果失败，按错误类型选择恢复策略 → 重试
```

## 7.2 模块组织：三层架构

Pi 运行时的代码组织为三层：

### 第一层：运行控制（run.ts）

```
src/agents/pi-embedded-runner/
├── run.ts              # 外循环：重试、failover、auth 轮转（1502 行）
├── run/
│   ├── attempt.ts      # 中循环：单次 LLM 调用（2096 行 —— 最大单文件）
│   ├── params.ts       # 运行参数类型
│   └── payloads.ts     # API 请求 payload 构建
├── runs.ts             # 运行状态管理（abort, queue, active tracking）
├── lanes.ts            # 并发 lane 控制
└── types.ts            # 核心类型定义
```

### 第二层：流式订阅（subscribe）

```
src/agents/
├── pi-embedded-subscribe.ts               # 流式订阅入口 + 事件分发
├── pi-embedded-subscribe.handlers.ts      # 事件处理器注册（switch/case 路由）
├── pi-embedded-subscribe.handlers.messages.ts   # 文本消息处理
├── pi-embedded-subscribe.handlers.tools.ts      # 工具调用处理
├── pi-embedded-subscribe.handlers.lifecycle.ts  # 生命周期事件
├── pi-embedded-subscribe.handlers.compaction.ts # 自动 compaction
├── pi-embedded-subscribe.handlers.types.ts      # 事件类型定义
├── pi-embedded-subscribe.tools.ts         # 工具结果过滤
├── pi-embedded-subscribe.types.ts         # 订阅参数类型
└── pi-embedded-block-chunker.ts           # 流式文本分块
```

### 第三层：支撑模块

```
src/agents/
├── system-prompt.ts / system-prompt-params.ts   # System prompt 组装
├── model-selection.ts / model-fallback.ts       # 模型选择与 failover
├── auth-profiles.ts / auth-profiles/            # Auth profile 管理
├── context-window-guard.ts / compaction.ts      # Context 管理
├── tool-policy.ts / tool-policy-pipeline.ts     # 工具策略
├── sandbox.ts / sandbox/                        # Docker 沙箱
├── skills.ts / skills-install.ts                # Skills 平台
└── subagent-*.ts                                # 子 Agent 系统
```

## 7.3 外循环：`run.ts` 的重试引擎

`runEmbeddedPiAgent`（1502 行）是 Agent 的心脏。理解它的关键是认识到它是一个**多层重试引擎**，不是简单的"调用 API 返回结果"。

### Lane 并发控制：双层队列

```typescript
const sessionLane = resolveSessionLane(params.sessionKey || params.sessionId);
const globalLane = resolveGlobalLane(params.lane);

return enqueueSession(() =>       // 第一层：session 级串行
  enqueueGlobal(async () => {     // 第二层：全局级并发控制
    // 实际执行逻辑
  })
);
```

**为什么需要双层队列？** 单层队列无法同时满足两个约束：（1）同一 session 的请求必须串行（避免 session 文件竞争），（2）不同 session 应该并行（否则一个慢请求会阻塞所有人）。双层嵌套巧妙地实现了"session 内串行、session 间并行"的语义。

`server-lanes.ts` 中的 `applyGatewayLaneConcurrency` 设置全局 lane 的并发上限（默认值由配置控制），防止同时向 LLM API 发送过多请求导致 rate limit。

### Hook 系统介入

在模型解析之前，hook 系统有机会覆盖模型选择：

```typescript
// 新 hook（优先）
if (hookRunner?.hasHooks("before_model_resolve")) {
  modelResolveOverride = await hookRunner.runBeforeModelResolve({ prompt }, hookCtx);
}
// 旧 hook（兼容）
if (hookRunner?.hasHooks("before_agent_start")) {
  legacyResult = await hookRunner.runBeforeAgentStart({ prompt }, hookCtx);
  // 新 hook 的值优先于旧 hook
  modelResolveOverride = {
    providerOverride: modelResolveOverride?.providerOverride ?? legacyResult?.providerOverride,
    modelOverride: modelResolveOverride?.modelOverride ?? legacyResult?.modelOverride,
  };
}
```

这种"新旧 hook 共存、新优先"的设计让插件平滑迁移，不会因为 hook API 升级而破坏现有插件。

### Context Window Guard

```typescript
const ctxGuard = evaluateContextWindowGuard({
  info: ctxInfo,
  warnBelowTokens: CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  hardMinTokens: CONTEXT_WINDOW_HARD_MIN_TOKENS,
});
if (ctxGuard.shouldBlock) {
  throw new FailoverError(`Model context window too small (${ctxGuard.tokens} tokens)`);
}
```

如果 context window 低于硬性阈值，直接拒绝——避免浪费 API 调用在一个必然会 overflow 的模型上。

### Auth Profile 轮转

OpenClaw 支持多个认证凭证轮转使用，这是它的独特设计。轮转逻辑：

```
1. resolveAuthProfileOrder() — 按配置排序所有 profile
2. 遍历 candidates，跳过处于 cooldown 的
3. applyApiKeyInfo(candidate) — 激活选中的 profile
4. 如果所有 profile 都在 cooldown：
   a. 检查是否允许 transient probe（探测性重试）
   b. 如果允许，选一个 cooldown 时间最长的试一下
   c. 如果不允许，抛 FailoverError
```

**Transient Cooldown Probe** 是一个巧妙的机制：当所有 profile 都因 rate limit 进入 cooldown 时，某些场景（如非关键的 probe session）可以尝试探测某个 profile 是否已恢复，而不是直接放弃。

### 重试循环的动态上限

```typescript
function resolveMaxRunRetryIterations(profileCandidateCount: number): number {
  const scaled = 24 + Math.max(1, profileCandidateCount) * 8;
  return Math.min(160, Math.max(32, scaled));
}
```

profile 越多，允许的重试越多（每个 profile 可能需要几次尝试），但硬性上限 160 防止无限循环。3 个 profile → max 48 次；10 个 profile → max 104 次。

### 六种错误恢复策略

| 错误类型 | 检测方式 | 恢复策略 | 备注 |
|---------|---------|---------|------|
| Rate limit | `isRateLimitAssistantError` | 标记 cooldown → 切 profile | profile 间轮转 |
| Auth error | `isAuthAssistantError` | 刷新 token → 切 profile | Copilot 有特殊刷新 |
| Context overflow | `isLikelyContextOverflowError` | 截断 tool result → compaction | 渐进式，最多 3 次 |
| Overloaded | `classifyFailoverReason` | 指数退避（250-1500ms）| 带 jitter 防惊群 |
| Billing error | `isBillingAssistantError` | 标记 cooldown → 切 profile | 格式化用户友好消息 |
| Thinking level | 特定错误格式 | 降级 thinking level | high→medium→low→off |

#### 渐进式 Context Overflow 恢复

```
if (isLikelyContextOverflowError && overflowCompactionAttempts < 3) {
  step 1: 如果尚未尝试 → 截断过大的 tool result（代价低）
  step 2: 如果截断不够 → compaction（让 LLM 压缩上下文，代价高）
  step 3: 重试 LLM 调用
}
```

### GitHub Copilot Token 刷新

对 Copilot 提供商有特殊的 token 生命周期管理：

```typescript
const scheduleCopilotRefresh = (): void => {
  const refreshAt = copilotTokenState.expiresAt - COPILOT_REFRESH_MARGIN_MS; // 提前 5 分钟
  const timer = setTimeout(() => {
    refreshCopilotToken("scheduled")
      .then(() => scheduleCopilotRefresh())  // 成功后重新调度
      .catch(() => {
        // 失败后 60 秒重试一次
        setTimeout(() => refreshCopilotToken("scheduled-retry"), COPILOT_REFRESH_RETRY_MS);
      });
  }, Math.max(COPILOT_REFRESH_MIN_DELAY_MS, refreshAt - Date.now()));
};
```

Token 在过期前 5 分钟自动刷新，失败后 60 秒重试。这确保在长时间 Agent 运行中 token 不会过期。

## 7.4 中循环：`attempt.ts` 的单次调用

`runEmbeddedAttempt`（2096 行，项目最大单文件）执行一次完整的 LLM 调用。它的内部流程极其丰富：

### 阶段 1：准备

```
1.  解析 workspace + agent 目录
2.  加载 session 文件（历史消息）
3.  修复 session 文件（如果损坏）
4.  获取 session 写锁（防并发写入）
5.  加载 bootstrap 文件（AGENTS.md, SOUL.md, TOOLS.md）
6.  分析 bootstrap 预算（token 配额）
7.  构建 system prompt
8.  创建工具集
9.  应用工具策略（allow/deny）
10. 加载并注入技能
```

### 阶段 2：工具集构建

工具来自多个来源，经过策略管道过滤：

```
Pi coding tools（bash, read, write, edit, process）
  + OpenClaw tools（message, cron, gateway, canvas, nodes）
    + Channel tools（discord_*, slack_*, telegram_*, whatsapp_*）
      + Plugin tools（扩展提供的工具）
        + SDK tools（sessions_*, subagents, memory_search）
          → 工具策略管道过滤
            → owner-only 过滤
              → 模型兼容性过滤
                → 最终工具集
```

### 阶段 3：LLM API 调用

根据 provider 类型选择不同的 stream 函数：

```typescript
// Ollama 使用自定义 stream 函数（注入 num_ctx 参数）
if (shouldInjectOllamaCompatNumCtx(model)) {
  streamFn = wrapOllamaCompatNumCtx(baseFn, numCtx);
}
// OpenAI Realtime 使用 WebSocket stream
if (isOpenAIRealtimeModel) {
  streamFn = createOpenAIWebSocketStreamFn(...);
}
// 默认使用 pi-ai 的 streamSimple
```

### 阶段 4：Tool Call 名称修正

LLM 返回的工具名可能不完全匹配已注册的名称（如大小写不同、带 namespace 前缀）。`normalizeToolCallNameForDispatch` 做智能修正：

```typescript
function normalizeToolCallNameForDispatch(rawName: string, allowedToolNames?: Set<string>): string {
  // 尝试多种候选名称：
  // 1. 原始名称
  // 2. normalize 后的名称
  // 3. 去掉 namespace 前缀（如 "mcp.server.tool" → "tool"）
  // 4. 大小写不敏感匹配
  // 如果都不匹配，返回 trimmed 原始名称（让后续逻辑报告"未知工具"错误）
}
```

这种宽容的名称匹配提高了不同 LLM 提供商的兼容性——有些模型会在工具名前加命名空间，有些会改变大小写。

## 7.5 内循环：流式订阅事件处理

`subscribeEmbeddedPiSession` 是 LLM 响应的流式处理核心。它维护一个复杂的状态机：

### 状态对象

```typescript
const state: EmbeddedPiSubscribeState = {
  assistantTexts: [],              // 累积的 assistant 文本片段
  toolMetas: [],                   // 工具调用元信息
  toolMetaById: new Map(),         // 按 ID 索引的工具元信息
  toolSummaryById: new Set(),      // 已发送摘要的工具 ID
  deltaBuffer: "",                 // 流式 delta 缓冲
  blockBuffer: "",                 // 块缓冲（用于分块发送）
  blockState: {
    thinking: false,               // 是否在 <think> 标签内
    final: false,                  // 是否在 <final> 标签内
    inlineCode: createInlineCodeState(),  // 行内代码状态
  },
  reasoningStreamOpen: false,      // 推理流是否打开
  compactionInFlight: false,       // 是否正在执行 compaction
  messagingToolSentTexts: [],      // message 工具已发送的文本（去重用）
  // ... 还有更多字段
};
```

### 事件路由

```typescript
switch (evt.type) {
  case "message_start":      → handleMessageStart     // LLM 开始输出新消息
  case "message_update":     → handleMessageUpdate    // 文本 delta 到达
  case "message_end":        → handleMessageEnd       // 消息输出结束
  case "tool_execution_start": → handleToolExecutionStart  // 工具开始执行
  case "tool_execution_update": → handleToolExecutionUpdate // 工具执行进度
  case "tool_execution_end":   → handleToolExecutionEnd    // 工具执行完成
  case "agent_start":        → handleAgentStart       // Agent 运行开始
  case "agent_end":          → handleAgentEnd         // Agent 运行结束
  case "auto_compaction_start": → handleAutoCompactionStart
  case "auto_compaction_end":   → handleAutoCompactionEnd
}
```

注意 `tool_execution_start` 和 `tool_execution_end` 是**异步处理的**（`.catch` 静默错误），不阻塞主流。这很重要——typing indicator 和工具摘要是 best-effort 的，不应因为发送失败而阻塞 Agent 执行。

### Thinking 标签解析

LLM 可能在文本中输出 `<thinking>...</thinking>` 标签表示推理过程。流式处理中，这些标签可能跨多个 chunk 到达：

```typescript
const THINKING_TAG_SCAN_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
```

状态机 `blockState.thinking` 跟踪当前是否在推理块内。推理内容可以：
- 静默丢弃（`reasoningMode: "off"`）
- 发送到专门的推理流（`reasoningMode: "stream"`）
- 包含在最终回复中（`reasoningMode: "on"`）

### 消息去重

当 Agent 通过 `message` 工具发送了一条消息，然后在最终回复中又说了同样的话，就会产生重复。`messagingToolSentTexts` 和 `messagingToolSentTextsNormalized` 追踪 message 工具已发送的内容，`isMessagingToolDuplicateNormalized` 在最终回复发送前检测并去除重复。

## 7.6 System Prompt 组装

System prompt 的组装是一个精心设计的模块化过程（`system-prompt.ts`，725 行）。

### 组装结构

```
┌────────────────────────────────────────────┐
│ ## Identity                                │
│ "You are [name], a personal AI assistant"  │
│                                            │
│ ## Skills (mandatory)                      │
│ "Scan <available_skills>..."               │
│ [技能列表 XML]                              │
│                                            │
│ ## Memory Recall                           │
│ "Run memory_search on MEMORY.md..."        │
│                                            │
│ ## Authorized Senders                      │
│ "Authorized: a1b2c3d4e5f6"  (哈希化)       │
│                                            │
│ ## Current Date & Time                     │
│ "Time zone: America/New_York"              │
│                                            │
│ ## Reply Tags                              │
│ "[[reply_to_current]] / [[reply_to:<id>]]" │
│                                            │
│ ## Messaging                               │
│ 消息工具使用规则、渠道能力描述               │
│                                            │
│ [AGENTS.md 内容]                            │
│ [SOUL.md 内容]                              │
│ [TOOLS.md 内容]                             │
│                                            │
│ ## Runtime                                 │
│ 渠道、session key、Agent ID 等运行时信息    │
└────────────────────────────────────────────┘
```

### Owner 身份保护

```typescript
function formatOwnerDisplayId(ownerId: string, ownerDisplaySecret?: string) {
  const digest = hasSecret
    ? createHmac("sha256", secret).update(ownerId).digest("hex")  // HMAC
    : createHash("sha256").update(ownerId).digest("hex");          // 纯 hash
  return digest.slice(0, 12);  // 取前 12 个字符
}
```

System prompt 中不暴露 owner 的真实手机号或 ID，而是用 12 位 hex 哈希值。如果配置了 `ownerDisplaySecret`，使用 HMAC（更安全，因为攻击者无法从哈希反推）。

### Skills 按需加载

Skills 不预加载——只在 system prompt 中列出可用技能的描述，Agent 根据用户请求判断需要哪个，然后用 `read` 工具读取对应的 `SKILL.md`：

```
"Before replying: scan <available_skills> <description> entries.
- If exactly one skill clearly applies: read its SKILL.md, then follow it.
- If multiple could apply: choose the most specific one.
- Constraints: never read more than one skill up front."
```

这节省了大量 context token——50 个技能的完整 SKILL.md 可能占用上万 token，但只列出描述只需几百。

## 7.7 Usage 追踪的精确性问题

token 使用量追踪看似简单，实际有一个微妙的正确性问题：

### 问题：多轮 tool call 的 cache 膨胀

一次 Agent 运行可能包含多轮 LLM 调用（每调用一次工具就需要再次调用 LLM）。每轮 API 调用都报告 `cacheRead ≈ 当前上下文大小`。如果累加所有轮次：

```
轮次 1：cacheRead = 50,000
轮次 2：cacheRead = 55,000（上下文增长了工具结果）
轮次 3：cacheRead = 60,000
累加后：cacheRead = 165,000 ← 错误！实际上下文只有 60,000
```

### 解决方案：区分累加值和最新值

```typescript
type UsageAccumulator = {
  input: number;          // 累加
  output: number;         // 累加（总生成量）
  cacheRead: number;      // 累加（用于总使用量统计）
  cacheWrite: number;     // 累加
  total: number;          // 累加
  lastCacheRead: number;  // 仅最新一轮（用于上下文大小计算）
  lastCacheWrite: number; // 仅最新一轮
  lastInput: number;      // 仅最新一轮
};
```

`output` 用累加值（因为每轮都有新的生成输出），但 `cacheRead/cacheWrite/input` 在计算上下文大小时使用 `last*`（最新一轮的值）。

## 7.8 子 Agent 系统

OpenClaw 支持 Agent 在运行中派生子 Agent：

```
src/agents/subagent-*.ts（10+ 文件）
```

**派生**（`subagent-spawn.ts`）：创建独立 session 的子 Agent，使用 `minimal` 模式的 system prompt，减少 token 消耗。

**注册表**（`subagent-registry.ts` + `*-state.ts` + `*-runtime.ts`）：追踪所有活跃子 Agent 的状态、进度、结果。父 Agent 可以通过 `subagents(action=list|steer|kill)` 工具管理子 Agent。

**结果广播**（`subagent-announce.ts`）：子 Agent 完成后，结果通过 announce 机制广播给父 Agent 或指定的 session。有去重机制（`announce-idempotency.ts`）确保不重复广播。

**深度限制**（`subagent-depth.ts`）：防止无限递归派生。

## 7.9 Sandbox 隔离

非 main session 可以启用 Docker 沙箱：

```
src/agents/sandbox/
├── config.ts          # 沙箱配置解析
├── constants.ts       # 默认镜像名、安全常量
├── context.ts         # 沙箱上下文（工作空间映射）
├── docker.ts          # Docker 命令执行
├── manage.ts          # 容器管理（列出、删除）
├── runtime-status.ts  # 运行时状态
├── tool-policy.ts     # 工具白名单/黑名单
└── types.ts           # 类型定义
```

沙箱的工具策略：
- **允许**：bash, process, read, write, edit, sessions_list, sessions_history, sessions_send, sessions_spawn
- **禁止**：browser, canvas, nodes, cron, discord, gateway

每个非 main session 有自己的 Docker 容器，工作空间目录通过 volume 映射。容器在 session 不活跃时自动清理（`sandbox-prune`）。

## 7.10 本章要点

Pi 引擎的核心架构特征：

1. **三层循环**：外循环（重试引擎）→ 中循环（单次 LLM 调用）→ 内循环（流式事件处理）
2. **双层队列**：session 内串行 + session 间并行
3. **六种错误恢复策略**：每种错误对应不同的恢复路径
4. **Auth Profile 轮转**：多凭证自动切换 + cooldown + transient probe
5. **宽容的工具名匹配**：兼容不同 LLM 的命名风格
6. **流式状态机**：跟踪 thinking 标签、代码块、消息去重
7. **精确的 Usage 追踪**：区分累加值和最新值
8. **模块化 System Prompt**：分 section 组装、按需技能加载、Owner 哈希化

### 推荐阅读的源文件

| 文件 | 优先级 | 行数 | 说明 |
|------|--------|------|------|
| `src/agents/pi-embedded-runner/run.ts` | ★★★ | 1502 | 外循环——重试引擎 |
| `src/agents/pi-embedded-runner/run/attempt.ts` | ★★★ | 2096 | 中循环——单次 LLM 调用全流程 |
| `src/agents/pi-embedded-subscribe.ts` | ★★★ | - | 内循环——流式事件处理 |
| `src/agents/system-prompt.ts` | ★★★ | 725 | System prompt 组装 |
| `src/agents/pi-embedded-subscribe.handlers.ts` | ★★ | - | 事件路由（理解所有事件类型） |
| `src/agents/pi-embedded-subscribe.handlers.tools.ts` | ★★ | - | 工具调用事件处理 |
| `src/agents/auth-profiles.ts` | ★★ | - | Auth profile 轮转与 cooldown |
| `src/agents/context-window-guard.ts` | ★ | - | Context window 管理 |
| `src/agents/subagent-spawn.ts` | ★ | - | 子 Agent 派生 |
| `src/agents/sandbox/context.ts` | ★ | - | Docker 沙箱上下文 |
