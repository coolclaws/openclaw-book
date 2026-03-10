# 第 7 章 Pi 引擎总览与三层架构

## 7.1 Pi 引擎概述

OpenClaw 将 AI Agent 运行时称为 **Pi**。它不是 API 调用的简单包装，而是一个完整的 Agent 执行引擎。整个 `src/agents/` 目录（5.6MB, 210+ 文件）围绕 Pi 引擎构建，是项目中最大也最复杂的模块。

Pi 引擎的核心职责链：

```
接收用户消息
  → 解析并发 lane
    → 选择模型 + 解析 auth profile
      → 构建 system prompt + 工具集
        → 调用 LLM API（streaming）
          → 处理流式事件（文本 / 工具调用 / 推理）
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
├── pi-embedded-subscribe.ts                     # 流式订阅入口 + 事件分发
├── pi-embedded-subscribe.handlers.ts            # 事件处理器注册（switch/case 路由）
├── pi-embedded-subscribe.handlers.messages.ts   # 文本消息处理
├── pi-embedded-subscribe.handlers.tools.ts      # 工具调用处理
├── pi-embedded-subscribe.handlers.lifecycle.ts  # 生命周期事件
├── pi-embedded-subscribe.handlers.compaction.ts # 自动 compaction
├── pi-embedded-subscribe.handlers.types.ts      # 事件类型定义
├── pi-embedded-subscribe.tools.ts               # 工具结果过滤
├── pi-embedded-subscribe.types.ts               # 订阅参数类型
└── pi-embedded-block-chunker.ts                 # 流式文本分块
```

### 第三层：支撑模块

```
src/agents/
├── system-prompt.ts / system-prompt-params.ts   # System prompt 组装
├── model-selection.ts / model-fallback.ts       # 模型选择与 failover
├── auth-profiles.ts / auth-profiles/            # Auth profile 管理
├── context-window-guard.ts / compaction.ts      # Context 管理
├── pi-extensions/context-pruning/               # Context 裁剪扩展
├── tool-policy.ts / tool-policy-pipeline.ts     # 工具策略
├── sandbox.ts / sandbox/                        # Docker 沙箱
├── skills.ts / skills/                          # Skills 平台
└── subagent-*.ts（10+ 文件）                    # 子 Agent 系统
```

## 7.3 Agent、Session 与三层循环：从安装到一次任务

在深入代码之前，先用一个真实场景把这些概念串起来。

### 7.3.1 安装后磁盘上有什么

你在 Mac 上装好 OpenClaw，连上 Telegram，配置了 Anthropic API key，什么都还没改。此时磁盘上的关键结构：

```
~/.openclaw/
├── config.yml          ← 全局配置（一个默认 agent "main"，模型 claude-sonnet-4-6）
└── workspace/          ← Agent 工作区
    ├── SOUL.md         ← Agent 的人格定义
    ├── USER.md         ← 关于用户的信息
    ├── AGENTS.md       ← 工作区约定
    └── MEMORY.md       ← 长期记忆（空）

~/.openclaw/agents/
└── main/               ← "main" agent 的私有目录
    └── sessions/       ← （此时空的，还没有对话）
```

**Agent 是什么？** 是一份配置——给它一个 id（`main`），告诉它用什么模型、哪些工具、哪个工作区。**它本身没有状态**，就像一份职位说明书。

**Session 是什么？** 是一次具体对话的持久化记录——消息历史、token 用量、最后一次路由信息，保存在 JSONL 文件里。**它是带状态的**。

### 7.3.2 第一条消息到来时，Session 如何诞生

你在 Telegram 发：

> 帮我搜索一下 Claude 最新的 API 定价，整理成表格发给我

消息进入流水线（第 6 章），路由解析后找到 `main` agent。此时 session 文件还不存在，系统根据路由参数推导出 session key：

```
dmScope = "main"（默认配置）
→ session key = "main:main"
→ 文件路径 = ~/.openclaw/agents/main/sessions/main.jsonl
→ 文件不存在 → 创建空文件，这是一个全新 session
```

`dmScope = "main"` 的含义：不管你从 Telegram、Discord 还是 Signal 发消息，只要是 DM，都归入同一个 `main` session。这让"你和你的 AI 助手"跨渠道共享同一个对话历史，像是一个持续进行中的对话。

如果你在配置里有两个 agent（`main` 和 `research`），同一条消息只进入**匹配路由规则**的那个 agent，另一个完全不知道这条消息的存在。

```
你的 Telegram DM
  ↓ 路由解析
main agent ← 消息进入这里
  session: "main:main"（~/.openclaw/agents/main/sessions/main.jsonl）

research agent ← 不知道这条消息存在（除非有专门的 binding 路由给它）
  session: "research:main"（独立文件，独立历史）
```

### 7.3.3 三层循环如何被触发

消息进入 `runEmbeddedPiAgent`，三层循环依次嵌套启动。下面用这个具体任务完整走一遍：

```
用户任务："帮我搜索一下 Claude 最新的 API 定价，整理成表格发给我"
Agent: main | Model: claude-sonnet-4-6 | Session: main:main（空）
```

---

**第一层：外循环（run.ts）**

外循环的职责是"保证这次任务最终能成功完成"，不是具体执行。

```
run.ts 启动
  │
  ├─ 1. 解析 auth profile
  │     → 从 config 读取 Anthropic API key
  │     → 只有 1 个 profile → maxRetries = 32
  │
  ├─ 2. session 级入队（enqueueSession）
  │     → 检查 "main:main" 这个 session 上有没有正在进行的请求
  │     → 没有 → 直接进入
  │     → （如果有 → 等待前一个完成，保证 session 文件不被并发写入）
  │
  ├─ 3. 全局入队（enqueueGlobal）
  │     → 检查全局并发数是否达到上限
  │     → 没有 → 开始执行
  │
  └─ 4. 调用中循环 runEmbeddedAttempt(...)
        （如果中循环失败 → 外循环根据错误类型决定是否重试）
```

此刻外循环处于"等待中循环返回"的状态，它的重试逻辑暂时还用不上——因为这是第一次尝试。

---

**第二层：中循环（attempt.ts）**

中循环负责"准备好一切，发一次 LLM API 请求"。

```
attempt.ts 启动
  │
  ├─ 1. 加载 session 文件
  │     → ~/.openclaw/agents/main/sessions/main.jsonl
  │     → 文件是空的 → 历史消息 = []
  │
  ├─ 2. 获取 session 写锁
  │     → 防止同一 session 的并发写入（文件级别的锁）
  │
  ├─ 3. 加载 bootstrap 文件
  │     → 读取 SOUL.md（"你是谁"）
  │     → 读取 USER.md（"用户是谁"）
  │     → 读取 AGENTS.md（"工作区约定"）
  │     → 估算 token 预算
  │
  ├─ 4. 构建 system prompt
  │     → 拼装：工具声明 + SOUL.md + USER.md + runtime 信息 + memory inject
  │     → 结果：约 3000-5000 tokens 的 system prompt
  │
  ├─ 5. 创建工具集 + 应用工具策略
  │     → 注册：web_search / exec / memory_search / memory_get / browser / ...
  │     → 七步策略管道过滤：这个 session 允许哪些工具？
  │     → main session + owner 身份 → 全工具可用
  │
  ├─ 6. 构建 API payload
  │     → model: "claude-sonnet-4-6"
  │     → system: [构建好的 system prompt]
  │     → messages: [
  │         { role: "user", content: "帮我搜索一下 Claude 最新的 API 定价..." }
  │       ]
  │     → tools: [web_search schema, exec schema, ...]
  │
  └─ 7. 发起 Anthropic Streaming API 调用
        → 进入内循环处理流式响应
```

---

**第三层：内循环（subscribe）**

内循环是最活跃的，随着 LLM 的流式响应实时处理每一个事件。

```
流式响应开始（API 返回 stream）

  事件 1: message_start
  → handleMessageStart：初始化 state，重置 deltaBuffer

  事件 2: message_update（LLM 决定调用 web_search 工具）
  → handleToolExecutionStart：
      通知 ReplyDispatcher："Agent 正在搜索..."（可选 tool summary）
      在 Telegram 上显示 typing indicator

  事件 3: tool_execution_end（web_search 工具执行完毕）
  → handleToolExecutionEnd：
      工具结果 = { results: [{ title: "Claude API Pricing", content: "..." }] }
      追加到消息历史 → 触发第二次 LLM 调用（回到中循环起点！）
```

**注意**：当工具调用完成后，**中循环会带着工具结果重新发起 API 请求**。这形成了"多轮工具调用"——内循环处理流式事件，遇到工具调用就让中循环用新的消息历史再调用一次 API。

```
第二次 LLM 调用（带 web_search 结果）：

  事件: message_update（text_delta，LLM 开始生成表格）
  → handleMessageUpdate → deltaBuffer 积累文字 →
      pi-embedded-block-chunker 判断是否该分块 →
      chunk 完整 → 调用 onBlockReply("| 模型 | 输入价格 | 输出价格 |\n|...")
      → ReplyDispatcher.sendBlockReply() → Telegram 收到第一段

  事件: message_update（更多 text_delta）
  → 继续积累 → 分块 → sendBlockReply("| claude-3-5-sonnet...")
  → Telegram 收到第二段

  事件: message_end
  → handleMessageEnd：
      停止 typing indicator
      调用 onFinalReply
      → ReplyDispatcher.sendFinalReply() → Telegram 收到完整回复

  事件: agent_end
  → handleAgentEnd：
      写入 session 文件（将这次对话追加到 main.jsonl）
      更新 token 用量统计
      释放 session 写锁
```

---

### 7.3.4 三层关系总结图

```
用户发消息
    │
    ▼
外循环（run.ts）
  "这次任务我来兜底"
  │ 管理 auth 轮转、失败重试
  │ 保证 session 串行访问
  │
  └─▶ 中循环（attempt.ts）
        "我来准备好一切，发一次请求"
        │ 加载 session、构建 system prompt
        │ 创建工具集、发 API 请求
        │
        └─▶ 内循环（subscribe）
              "我来处理 LLM 的每个回应"
              │ 文本 delta → 分块 → 发给用户
              │ 工具调用 → 执行 → 结果塞回历史
              │ 工具结果回来 → 触发新的中循环（再发一次请求）
              │
              └─▶ （工具调用完毕，无更多工具）
                    LLM 生成最终文字
                    → 文本事件 → 分块 → 发给用户
                    → agent_end → 写入 session 文件
                    → 返回中循环 → 返回外循环
                    → 任务完成
```

**三层各自的"时间尺度"：**

| 循环 | 生命周期 | 触发次数（本例）|
|------|---------|--------------|
| 外循环 | 整个任务（数秒到数分钟）| 1 次（无错误）|
| 中循环 | 单次 API 调用（数秒）| 2 次（1 次初始 + 1 次带工具结果）|
| 内循环 | 单次流式响应（实时）| 每个 API 调用都有一个 |

---

### 7.3.5 多轮对话：Session 文件如何增长

第一轮任务完成后，`main.jsonl` 里保存了：

```jsonl
{"role":"user","content":"帮我搜索一下 Claude 最新的 API 定价，整理成表格发给我"}
{"role":"assistant","content":null,"tool_calls":[{"name":"web_search","input":{"query":"Claude API pricing 2025"}}]}
{"role":"tool","content":[{"type":"text","text":"搜索结果..."}]}
{"role":"assistant","content":"根据最新信息，Claude API 定价如下：\n\n| 模型 | ..."}
```

用户紧接着发第二条消息：

> 帮我把这个表格保存到我的笔记

这次外循环启动时，**中循环加载 session 文件**，`messages` 数组里已经有上面四条记录。LLM 看到完整的对话历史，知道"上一条消息讨论了定价表格"，能无缝续接上下文。

这就是 session 的意义：**它是对话历史在磁盘上的持久化形态**，让 LLM 的无状态性（每次调用都是独立的）被应用层的 session 管理弥补，形成连续的对话体验。

---

## 7.4 外循环：run.ts 的重试引擎

`runEmbeddedPiAgent`（1502 行）是 Agent 的心脏。它是一个**多层重试引擎**，而非简单的"调用 API 返回结果"。

### 双层队列：session 内串行，session 间并行

```typescript
const sessionLane = resolveSessionLane(params.sessionKey);
const globalLane = resolveGlobalLane(params.lane);

return enqueueSession(() =>       // 第一层：session 级串行
  enqueueGlobal(async () => {     // 第二层：全局级并发控制
    // 实际执行逻辑
  })
);
```

**为什么需要双层？** 单层队列无法同时满足：（1）同一 session 的请求必须串行（避免 session 文件竞争），（2）不同 session 应该并行（否则一个慢请求会阻塞所有人）。双层嵌套巧妙地实现了"session 内串行、session 间并行"的语义。

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
  // 新 hook 值优先于旧 hook
  modelResolveOverride = {
    providerOverride: modelResolveOverride?.providerOverride ?? legacyResult?.providerOverride,
    modelOverride:   modelResolveOverride?.modelOverride   ?? legacyResult?.modelOverride,
  };
}
```

新旧 hook 并行触发、新值覆盖旧值，让已有插件不需要修改就能继续工作。

### 动态重试上限

```typescript
function resolveMaxRunRetryIterations(profileCandidateCount: number): number {
  const scaled = 24 + Math.max(1, profileCandidateCount) * 8;
  return Math.min(160, Math.max(32, scaled));
}
// 1 个 profile → max 32；3 个 → max 48；10 个 → max 104；任意 → 上限 160
```

### 六种错误恢复策略

| 错误类型 | 检测方式 | 恢复策略 |
|---------|---------|---------|
| Rate limit | `isRateLimitAssistantError` | 标记 cooldown → 切换 profile |
| Auth error | `isAuthAssistantError` | 刷新 token → 切换 profile |
| Context overflow | `isLikelyContextOverflowError` | 截断 tool result → compaction（最多 3 次）|
| Overloaded | `classifyFailoverReason` | 指数退避 250-1500ms（带 jitter）|
| Billing error | `isBillingAssistantError` | 标记 cooldown → 切换 profile |
| Thinking level | 特定错误格式 | 降级 high→medium→low→off |

### 渐进式 Context Overflow 恢复

```
if (isLikelyContextOverflowError && overflowCompactionAttempts < 3) {
  step 1: 截断过大的 tool result（代价低）
  step 2: 如果截断不够 → compaction（让 LLM 压缩上下文，代价高）
  step 3: 重试 LLM 调用
}
```

### GitHub Copilot Token 自动刷新

```typescript
// 提前 5 分钟刷新，失败后 60 秒重试
const refreshAt = copilotTokenState.expiresAt - COPILOT_REFRESH_MARGIN_MS;
setTimeout(() => {
  refreshCopilotToken("scheduled")
    .then(() => scheduleCopilotRefresh())
    .catch(() => setTimeout(() => refreshCopilotToken("scheduled-retry"),
                             COPILOT_REFRESH_RETRY_MS));
}, Math.max(COPILOT_REFRESH_MIN_DELAY_MS, refreshAt - Date.now()));
```

## 7.5 中循环：attempt.ts 的单次 LLM 调用

`runEmbeddedAttempt`（2096 行，项目最大单文件）执行一次完整的 LLM 调用。

### 阶段 1：准备

```
1.  解析 workspace + agent 目录
2.  加载 session 文件（历史消息）
3.  修复 session 文件（损坏时截断修复）
4.  获取 session 写锁（防并发写入）
5.  加载 bootstrap 文件（AGENTS.md, SOUL.md, TOOLS.md）
6.  分析 bootstrap 预算（token 配额）
7.  构建 system prompt
8.  创建工具集
9.  应用工具策略（allow/deny 管道）
10. 加载并注入 Skills
```

### 阶段 2：Provider 适配

根据 provider 类型选择不同的 stream 函数：

```typescript
// Ollama：注入 num_ctx 参数
if (shouldInjectOllamaCompatNumCtx(model)) {
  streamFn = wrapOllamaCompatNumCtx(baseFn, numCtx);
}
// OpenAI Realtime：使用 WebSocket stream
if (isOpenAIRealtimeModel) {
  streamFn = createOpenAIWebSocketStreamFn(...);
}
```

### 阶段 3：工具名修正

LLM 返回的工具名可能不完全匹配（大小写不同、带 namespace 前缀）。`normalizeToolCallNameForDispatch` 做智能修正：

```typescript
// 尝试候选名称：原始 → normalize 后 → 去 namespace 前缀 → 大小写不敏感匹配
// 都不匹配 → 返回原始（让后续逻辑报告"未知工具"错误）
```

## 7.6 内循环：流式订阅事件处理

`subscribeEmbeddedPiSession` 是 LLM 响应的流式处理核心，维护一个复杂的状态机。

### 状态对象核心字段

```typescript
const state = {
  assistantTexts: [],         // 累积的 assistant 文本片段
  toolMetas: [],              // 工具调用元信息
  toolMetaById: new Map(),    // 按 ID 索引
  deltaBuffer: "",            // 流式 delta 缓冲
  blockState: {
    thinking: false,          // 是否在 <think> 标签内
    final: false,             // 是否在 <final> 标签内
    inlineCode: ...,
  },
  reasoningStreamOpen: false,
  compactionInFlight: false,
  messagingToolSentTexts: [], // message 工具已发送的文本（去重用）
};
```

### 事件路由

```typescript
switch (evt.type) {
  case "message_start":          → handleMessageStart
  case "message_update":         → handleMessageUpdate
  case "message_end":            → handleMessageEnd
  case "tool_execution_start":   → handleToolExecutionStart  // 异步，best-effort
  case "tool_execution_update":  → handleToolExecutionUpdate // 异步，best-effort
  case "tool_execution_end":     → handleToolExecutionEnd    // 异步，best-effort
  case "agent_start":            → handleAgentStart
  case "agent_end":              → handleAgentEnd
  case "auto_compaction_start":  → handleAutoCompactionStart
  case "auto_compaction_end":    → handleAutoCompactionEnd
}
```

`tool_execution_*` 是**异步且 best-effort 的**（`.catch` 静默错误）——typing indicator 和进度通知是辅助性的，失败不应阻塞核心任务。

### Thinking 标签解析

```typescript
const THINKING_TAG_SCAN_RE =
  /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
```

推理内容支持三种模式：静默丢弃（`off`）/ 发到推理流（`stream`）/ 包含在最终回复（`on`）。

### 消息去重

当 Agent 通过 `message` 工具发送了消息，又在最终回复中重复了相同内容，`messagingToolSentTextsNormalized` 检测并去除重复，避免用户收到两次相同的文本。

## 7.7 Usage 追踪的精确性

### 问题：多轮 tool call 的 cache 膨胀

```
轮次 1：cacheRead = 50,000
轮次 2：cacheRead = 55,000
轮次 3：cacheRead = 60,000
简单累加：165,000 ← 错误！实际上下文只有 60,000
```

### 解决方案：区分累加值和最新值

```typescript
type UsageAccumulator = {
  input: number;          // 累加（每轮新增 input）
  output: number;         // 累加（总生成量）
  cacheRead: number;      // 累加（用于总成本统计）
  cacheWrite: number;     // 累加
  lastCacheRead: number;  // 仅最新一轮（用于当前 context 大小计算）
  lastCacheWrite: number;
  lastInput: number;
};
```

`output` 用累加（每轮都有新生成），context 大小计算用 `lastCacheRead`（仅看最新一轮）。

## 7.8 本章要点

Pi 引擎的三层架构各司其职：
- **外循环（run.ts）**：错误恢复、Auth 轮转、模型 failover，保证可用性
- **中循环（attempt.ts）**：单次调用的完整流程，工具集构建、Provider 适配
- **内循环（subscribe）**：流式事件状态机，文本分块、消息去重、推理标签

### 推荐阅读的源文件

| 文件 | 优先级 | 行数 | 说明 |
|------|--------|------|------|
| `src/agents/pi-embedded-runner/run.ts` | ★★★ | 1502 | 外循环重试引擎 |
| `src/agents/pi-embedded-runner/run/attempt.ts` | ★★★ | 2096 | 中循环单次调用 |
| `src/agents/pi-embedded-subscribe.ts` | ★★★ | — | 内循环流式事件处理 |
| `src/agents/pi-embedded-subscribe.handlers.ts` | ★★ | — | 事件路由 |
| `src/agents/pi-embedded-subscribe.handlers.tools.ts` | ★★ | — | 工具调用事件 |
