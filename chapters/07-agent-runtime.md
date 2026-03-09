# 第 7 章 Agent 运行时与 Pi 引擎（深度展开版）

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
├── context-window-guard.ts / compaction.ts      # Context 管理（本章重点）
├── pi-extensions/context-pruning/               # Context 裁剪扩展
├── pi-embedded-runner/tool-result-context-guard.ts  # 工具结果截断
├── tool-policy.ts / tool-policy-pipeline.ts     # 工具策略（本章重点）
├── sandbox.ts / sandbox/                        # Docker 沙箱
├── skills.ts / skills/                          # Skills 平台（本章重点）
└── subagent-*.ts（10+ 文件）                    # 子 Agent 系统（本章重点）
```

---

## 7.3 上下文管理（Context Management）

这是 Pi 引擎最精密的部分之一。上下文管理不是一个单点机制，而是**四层防线**的组合体，从"检测警告"到"强制裁剪"层层递进。

### 7.3.1 四层防线全貌

```
┌──────────────────────────────────────────────────────────────┐
│  第一层：Context Window Guard（入口检测）                      │
│  在调用 LLM 之前检查模型 context window 大小                   │
│  tokens < 16,000 → 直接拒绝（FailoverError → 切换模型）        │
│  tokens < 32,000 → 发出警告（继续执行但记录日志）               │
├──────────────────────────────────────────────────────────────┤
│  第二层：Tool Result Context Guard（工具结果截断）             │
│  在工具执行后，对超大 tool result 进行截断                      │
│  超出阈值 → 追加截断通知字符串，防止单次工具结果撑爆 context     │
├──────────────────────────────────────────────────────────────┤
│  第三层：Compaction（历史压缩，响应式）                        │
│  LLM 调用返回 context overflow 错误时触发                      │
│  用 LLM 自身对历史对话进行摘要压缩                              │
├──────────────────────────────────────────────────────────────┤
│  第四层：Context Pruning（定期裁剪，主动式）                   │
│  每次请求前检查工具结果缓存是否过期                              │
│  过期的 tool result 先 soft trim，再 hard clear                │
└──────────────────────────────────────────────────────────────┘
```

---

### 7.3.2 第一层：Context Window Guard

**文件：** `src/agents/context-window-guard.ts`

```typescript
export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;  // 硬性下限
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000; // 警告阈值

export type ContextWindowSource =
  | "model"           // 来自模型元数据
  | "modelsConfig"    // 来自 openclaw.json 的 models 配置
  | "agentContextTokens"  // 来自 agent 专项配置
  | "default";        // 兜底默认值
```

**解析优先级（高到低）：**

```
agentContextTokens（agent 级配置）
  → modelsConfig（全局 models 配置）
    → model（模型元数据自带）
      → default（兜底）
```

同一个模型在不同场景可以有不同的 context 配置——比如给 main session 分配 200k，给 subagent 只分配 32k，节省成本。

**Guard 结果的三种状态：**

```typescript
type ContextWindowGuardResult = {
  tokens: number;
  source: ContextWindowSource;
  shouldWarn: boolean;   // 32k 以下：记录警告但不阻止
  shouldBlock: boolean;  // 16k 以下：直接抛 FailoverError，触发模型切换
};
```

`shouldBlock = true` 时，Pi 引擎不会浪费这次 API 调用，而是立刻抛出 `FailoverError`，外循环的模型切换逻辑会尝试找一个 context window 更大的模型。

---

### 7.3.3 第二层：Tool Result Context Guard

**文件：** `src/agents/pi-embedded-runner/tool-result-context-guard.ts`

工具调用可能返回巨量数据（比如读取一个 10MB 的文件，或者 `exec` 输出了长篇日志）。如果这些数据原样追加到对话历史，下一轮 LLM 调用会立刻 overflow。

Guard 在每次工具调用完成后检查结果大小：

```typescript
const CONTEXT_LIMIT_TRUNCATION_NOTICE =
  "[truncated: output exceeded context limit]";

const PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER =
  "[compacted: tool output removed to free context]";
```

两个占位符代表两种处理方式：
- **截断**：保留前面的内容，截断后面的，追加 `[truncated...]` 通知。适合输出量适中的情况。
- **预先清除**：整个 tool result 用占位符替代，什么都不保留。在极端情况下使用，确保 context 不崩溃。

`installToolResultContextGuard` 通过拦截 agent 的工具结果写入路径来工作，返回一个 `uninstall` 函数，在当次运行结束后卸载拦截器，保证不影响下次运行。

---

### 7.3.4 第三层：Compaction（历史压缩）

**文件：** `src/agents/compaction.ts`, `src/agents/pi-embedded-runner/compact.ts`

当 LLM 返回 context overflow 错误，或者用户手动执行 `/compact` 命令时，触发 Compaction。它的本质是：**用 LLM 对自己的对话历史做摘要**。

#### Compaction 的核心算法

```
输入：完整的历史消息列表
输出：一段摘要文本（用 LLM 生成）

步骤：
1. estimateMessagesTokens()  — 粗估总 token 数
2. computeAdaptiveChunkRatio() — 根据消息平均大小动态调整分块比
3. chunkMessagesByMaxTokens() — 按 maxTokens 切块
4. summarizeInStages() — 分阶段压缩
5. 用摘要替换历史消息
```

#### 自适应分块比（Adaptive Chunk Ratio）

```typescript
export const BASE_CHUNK_RATIO = 0.4;    // 基础分块比（40% context window）
export const MIN_CHUNK_RATIO = 0.15;    // 最小分块比（15% context window）
export const SAFETY_MARGIN = 1.2;       // 安全系数

function computeAdaptiveChunkRatio(messages, contextWindow) {
  // 消息平均越大，分块比越小（避免单块超限）
  const avgMsgTokens = estimateMessagesTokens(messages) / messages.length;
  const bigMessagePenalty = avgMsgTokens / contextWindow;
  return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - bigMessagePenalty);
}
```

这个设计解决了一个常见问题：有些对话包含少量但极大的消息（比如一次 `read` 了整个代码文件），如果按固定比例分块会导致单块超过模型上限。自适应分块比在检测到大消息时自动缩小块大小。

#### 分阶段压缩（Summarize in Stages）

```
阶段 1：尝试整体压缩（一次调用 LLM 处理所有 chunks）
  ↓ 失败（某个 chunk 太大）
阶段 2：先移除超大消息（>50% context 的单条消息），再压缩
  ↓ 还是失败
阶段 3：pruneHistoryForContextShare（硬截断历史，按 token 配额保留最近的消息）
```

`summarizeWithFallback` 实现了这个渐进式降级：

```typescript
function isOversizedForSummary(msg, contextWindow) {
  // 单条消息 > 50% context window → 无法安全压缩
  return estimateTokens(msg) > contextWindow * 0.5;
}
```

#### Compaction 的安全超时

**文件：** `src/agents/pi-embedded-runner/compaction-safety-timeout.ts`

Compaction 本身是一次 LLM 调用，可能很慢（历史很长时）。如果 Compaction 卡住了，整个 Agent 就卡住了。安全超时机制确保 Compaction 在超时后强制退出，让 Agent 有机会用其他恢复策略继续。

#### 自定义 Compaction 指令

```typescript
type CompactionSummarizationInstructions = {
  identifierPolicy?: AgentCompactionIdentifierPolicy;
  identifierInstructions?: string;
};
```

用户可以配置 `identifierPolicy` 来控制 Compaction 摘要中如何处理特殊标识符（比如文件路径、session key、tool call ID）。这影响摘要的可读性和对后续 Agent 行为的影响。

---

### 7.3.5 第四层：Context Pruning（主动裁剪）

**文件：** `src/agents/pi-extensions/context-pruning/`

这是 Compaction 的轻量替代方案。区别在于：

| | Compaction | Context Pruning |
|--|--|--|
| 触发时机 | 响应式（overflow 后） | 主动式（每次请求前） |
| 操作方式 | LLM 摘要压缩 | 直接删除/截断旧工具结果 |
| 成本 | 高（额外 LLM 调用） | 低（纯内存操作） |
| 对磁盘的影响 | 重写 session 文件 | **不写磁盘**，只影响当次请求的内存 context |
| 适用场景 | 上下文真正快满了 | 定期清理已过期的工具缓存 |

**关键特性：只影响内存，不重写 session 文件。**

这意味着 pruning 是"对 LLM 说谎"——告诉 LLM 某些历史工具结果已经不存在了，但实际上磁盘里还有完整记录。这对需要精确 context 的场景（比如代码审查）可能有问题，所以是 opt-in 的。

#### Pruning 模式

```typescript
type ContextPruningMode = "off" | "cache-ttl";
```

目前只有 `cache-ttl` 一种启用模式：基于缓存过期时间来决定哪些工具结果应该被裁剪。

#### Pruning 的两级处理

```typescript
type EffectiveContextPruningSettings = {
  // 软裁剪：保留头尾，截断中间
  softTrim: {
    maxChars: number;   // 超过这个长度才软裁剪
    headChars: number;  // 保留开头多少字
    tailChars: number;  // 保留结尾多少字
  };
  // 硬清除：整个工具结果替换为占位符
  hardClear: {
    enabled: boolean;
    placeholder: string;  // 默认 "[compacted: tool output removed...]"
  };
  softTrimRatio: number;    // context 占用 softTrimRatio 以上 → 触发软裁剪
  hardClearRatio: number;   // context 占用 hardClearRatio 以上 → 触发硬清除
  keepLastAssistants: number; // 最近 N 个 assistant 回复永远保留
};
```

**决策流程：**

```
工具结果过期（TTL 超时）?
  → 是
  → 该结果占 context 的比例 > hardClearRatio?
    → 是 → 硬清除（整个替换为占位符）
    → 否 → 该结果字符数 > softTrim.maxChars?
      → 是 → 软裁剪（保留头尾）
      → 否 → 跳过（太小，不值得裁剪）
```

---

### 7.3.6 上下文管理的整体触发时序

```
用户消息到达
  ↓
[第一层] context window guard → tokens 太少 → FailoverError → 切换模型
  ↓
[第四层] context pruning（如果启用）→ 裁剪过期工具结果（仅内存）
  ↓
LLM 调用
  ↓
工具执行
  ↓
[第二层] tool result guard → 截断超大工具结果
  ↓
下一轮 LLM 调用
  ↓ 出现 context overflow 错误
[第三层] compaction → 压缩历史 → 重写 session 文件 → 重试
```

---

## 7.4 Sub-agent 系统

Sub-agent 是 Pi 引擎的并发执行能力的核心。父 Agent 可以在运行中派生子任务，子 Agent 在独立 session 中执行，完成后自动通知父 Agent。

### 7.4.1 架构文件组织

```
src/agents/
├── subagent-spawn.ts              # 派生入口
├── subagent-registry.ts           # 注册表（增删查）
├── subagent-registry.types.ts     # 注册表类型定义
├── subagent-registry.store.ts     # 持久化存储
├── subagent-registry-state.ts     # 运行状态管理
├── subagent-registry-runtime.ts   # 运行时操作（start/end）
├── subagent-registry-cleanup.ts   # 清理过期记录
├── subagent-registry-completion.ts # 完成处理
├── subagent-registry-queries.ts   # 查询接口
├── subagent-announce.ts           # 完成广播
├── subagent-announce-dispatch.ts  # 广播分发
├── subagent-announce-queue.ts     # 广播队列（幂等）
├── subagent-lifecycle-events.ts   # 生命周期事件定义
├── subagent-depth.ts              # 深度限制
└── subagent-attachments.ts        # 附件传递
```

---

### 7.4.2 派生（Spawn）

**文件：** `src/agents/subagent-spawn.ts`

#### 两种模式

```typescript
const SUBAGENT_SPAWN_MODES = ["run", "session"] as const;
```

| 模式 | 语义 | 适用场景 |
|------|------|----------|
| `run` | 一次性任务：执行完毕后 session 关闭 | 代码生成、文件分析、单次查询 |
| `session` | 持久 session：任务完成后保持活跃，可继续交互 | ACP harness、Discord 线程、持续对话 |

#### 沙箱继承

```typescript
const SUBAGENT_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
```

- `inherit`：跟随父 Agent 的沙箱配置（默认）
- `require`：强制启用 Docker 沙箱（适合执行不可信代码）

#### SpawnSubagentParams 全解析

```typescript
type SpawnSubagentParams = {
  task: string;                    // 任务描述（子 Agent 的 system prompt 前缀）
  label?: string;                  // 可读标签（日志和状态展示用）
  agentId?: string;                // 指定使用哪个 agent 身份（默认继承父 Agent）
  model?: string;                  // 指定模型（不指定则继承父 Agent）
  thinking?: string;               // 思考级别（high/medium/low）
  runTimeoutSeconds?: number;      // 超时（0 = 无限制）
  thread?: boolean;                // 是否绑定到当前 Discord/Slack 线程
  mode?: SpawnSubagentMode;        // run | session
  cleanup?: "delete" | "keep";    // 完成后是否删除 session 文件
  sandbox?: SpawnSubagentSandboxMode;  // inherit | require
  expectsCompletionMessage?: boolean;  // 是否期望子 Agent 发完成消息
  attachments?: Array<{...}>;      // 随任务传递的文件附件
  attachMountPath?: string;        // 附件在子 Agent workspace 的挂载路径
};
```

#### 关键设计：推送式完成（Push-based Completion）

```typescript
export const SUBAGENT_SPAWN_ACCEPTED_NOTE =
  "Auto-announce is push-based. After spawning children, do NOT call " +
  "sessions_list, sessions_history, exec sleep, or any polling tool. " +
  "Wait for completion events to arrive as user messages, track expected " +
  "child session keys, and only send your final answer after ALL expected " +
  "completions arrive.";
```

这个提示注入到父 Agent 的上下文中，告诉它**不要轮询**。这是 OpenClaw 的核心设计原则——子 Agent 完成后通过 announce 机制主动推送结果，父 Agent 只需等待，不需要主动查询。

违反这个原则（用 `sleep + sessions_list` 轮询）会造成：
1. 每次轮询消耗额外 token
2. 轮询期间阻塞当前 session lane
3. `sleep` 在某些环境下行为不确定

---

### 7.4.3 注册表（Registry）

子 Agent 启动后被记录到注册表中。注册表是一个持久化的 JSON 存储，每条记录是一个 `SubagentRunRecord`：

```typescript
type SubagentRunRecord = {
  runId: string;                    // 唯一运行 ID
  childSessionKey: string;          // 子 Agent 的 session key
  requesterSessionKey: string;      // 父 Agent 的 session key
  requesterOrigin?: DeliveryContext; // 父 Agent 的消息来源（渠道、群组等）
  task: string;                     // 任务描述
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  spawnMode?: SpawnSubagentMode;

  // 时间戳
  createdAt: number;
  startedAt?: number;
  endedAt?: number;

  // 结果
  outcome?: SubagentRunOutcome;

  // Announce 重试机制
  announceRetryCount?: number;
  lastAnnounceRetryAt?: number;

  // 最终输出快照（用于重试 announce）
  frozenResultText?: string | null;
  frozenResultCapturedAt?: number;
  fallbackFrozenResultText?: string | null;
  fallbackFrozenResultCapturedAt?: number;

  // Lifecycle
  endedReason?: SubagentLifecycleEndedReason;
  wakeOnDescendantSettle?: boolean;  // 等子孙都完成后再广播

  // 附件
  attachmentsDir?: string;
  attachmentsRootDir?: string;
};
```

#### frozenResultText 的设计目的

子 Agent 可能在 announce 成功之前就已经完成了。如果网络中断或父 Agent session 暂时不可用，announce 会失败并排入重试队列。`frozenResultText` 就是在子 Agent 完成时立刻捕获的最终输出快照，用于重试时重放——即使子 Agent 的 session 已经关闭或被清理，重试时仍然有结果可以广播。

---

### 7.4.4 生命周期事件

```typescript
// 结束原因（为什么这个子 Agent 停止了）
type SubagentLifecycleEndedReason =
  | "subagent-complete"   // 正常完成
  | "subagent-error"      // 执行出错
  | "subagent-killed"     // 被父 Agent 或用户手动 kill
  | "session-reset"       // session 被重置
  | "session-delete";     // session 被删除

// 结束结果（这次运行的最终状态）
type SubagentLifecycleEndedOutcome =
  | "ok"       // 成功
  | "error"    // 失败
  | "timeout"  // 超时
  | "killed"   // 被杀掉
  | "reset"    // session 重置
  | "deleted"; // session 删除
```

---

### 7.4.5 完成广播（Announce）

**文件：** `src/agents/subagent-announce.ts`

Announce 是子 Agent 完成后的"回调"机制。流程：

```
子 Agent 执行完毕
  → captureSubagentCompletionReply() 捕获最终输出文本
  → 写入 frozenResultText
  → runSubagentAnnounceFlow() 尝试发送给父 Agent
    → 成功：父 Agent session 收到完成消息，继续执行
    → 失败：加入 subagent-announce-queue，稍后重试
```

`runSubagentAnnounceFlow` 的参数展示了其复杂性：

```typescript
params = {
  childSessionKey,
  childRunId,
  requesterSessionKey,
  requesterOrigin?,          // 父 Agent 在哪个渠道（确保回复到正确的地方）
  task,
  timeoutMs,
  cleanup,
  roundOneReply?,            // 主要结果文本
  fallbackReply?,            // 备用文本（wake 继续场景）
  waitForCompletion?,        // 是否同步等待广播完成
  outcome?,                  // 最终状态
  announceType?,             // "subagent task" | "cron job"
  expectsCompletionMessage?, // 子 Agent 是否已自己发了完成消息
  spawnMode?,
  wakeOnDescendantSettle?,   // 是否等子孙完成后再广播
  signal?,                   // AbortSignal（超时控制）
  bestEffortDeliver?,        // 允许失败不报错
}
```

#### 幂等广播（Announce Idempotency）

**文件：** `src/agents/subagent-announce-queue.ts`

同一条广播可能因为重试被发送多次。`announce-idempotency` 通过记录已广播的 `runId` 来确保父 Agent 只收到一次完成通知，即使 announce 重试了多次。

---

### 7.4.6 深度限制

**文件：** `src/agents/subagent-depth.ts`

```typescript
function getSubagentDepthFromSessionStore(
  sessionKey: string | undefined | null,
  opts?: { cfg?: OpenClawConfig; store?: Record<string, SessionDepthEntry> }
): number;
```

每个 session 有一个 `spawnDepth` 字段，记录它在派生链中的深度：

```
main session (depth=0)
  → subagent A (depth=1)
    → subagent B (depth=2)
      → subagent C (depth=3)  ← 如果超过 maxSpawnDepth，直接拒绝
```

`maxSpawnDepth` 在 config 中配置，防止 Agent 陷入无限递归派生（一个 Agent 派生出无数 Agent 导致系统崩溃）。

---

### 7.4.7 附件传递（Attachments）

**文件：** `src/agents/subagent-attachments.ts`

父 Agent 可以在派生时附带文件：

```typescript
attachments?: Array<{
  name: string;
  content: string;      // base64 或 utf8
  encoding?: "utf8" | "base64";
  mimeType?: string;
}>;
attachMountPath?: string;  // 附件在子 Agent workspace 中的路径
```

附件会被复制到子 Agent 的工作目录，子 Agent 可以直接通过文件系统访问。完成后根据 `retainAttachmentsOnKeep` 决定是否保留。

---

### 7.4.8 父 Agent 如何管理子 Agent

父 Agent 通过 `subagents` 工具（`src/agents/tools/subagents-tool.ts`）管理子 Agent：

```
subagents(action=list)   → 列出当前 session 下所有活跃子 Agent
subagents(action=steer)  → 向指定子 Agent 注入新指令（不中断当前执行）
subagents(action=kill)   → 终止指定子 Agent
```

`steer` 是一个特别的操作：它不是重新启动子 Agent，而是向正在运行的子 Agent 发送一条新消息，让它调整方向。在子 Agent 执行时间很长（比如复杂的代码任务）的场景下，这允许父 Agent 在中途修正任务目标。

---

## 7.5 工具策略（Tool Policy）

工具策略决定了"在这个 session 里，Agent 可以使用哪些工具"。这不是一个简单的 allow/deny 列表，而是**多层策略叠加的管道（Pipeline）**。

### 7.5.1 工具来源

工具从六个来源汇聚：

```
Pi coding tools        → bash, read, write, edit, process, glob, search
OpenClaw core tools    → message, cron, gateway, canvas, nodes, session_status
Channel tools          → discord_*, slack_*, telegram_*, whatsapp_*
Plugin tools           → 插件提供的扩展工具
SDK tools              → sessions_*, subagents, memory_search, memory_get
Sub-agent tools        → subagents-tool（仅 main session 有）
```

---

### 7.5.2 工具组（Tool Groups）

**文件：** `src/agents/tool-policy-shared.ts`

工具按功能分组，策略可以引用组名而不是逐个列出工具名：

```typescript
const TOOL_GROUPS = {
  all: [...],           // 全部工具
  core: [...],          // Pi 核心工具（bash, read, write...）
  messaging: [...],     // 消息发送相关
  channels: [...],      // 各渠道特有工具
  memory: [...],        // 记忆相关
  sessions: [...],      // session 管理
  subagents: [...],     // 子 Agent 管理
  browser: [...],       // 浏览器
  canvas: [...],        // Canvas
  nodes: [...],         // 节点管理
  cron: [...],          // 定时任务
  gateway: [...],       // Gateway 管理
};
```

配置示例（`openclaw.json`）：

```json
{
  "toolPolicy": {
    "allow": ["core", "memory", "messaging"],
    "deny": ["gateway", "nodes"]
  }
}
```

---

### 7.5.3 策略管道（Policy Pipeline）

**文件：** `src/agents/tool-policy-pipeline.ts`

管道由多个步骤组成，每个步骤是一个 `ToolPolicyPipelineStep`：

```typescript
type ToolPolicyPipelineStep = {
  policy: ToolPolicyLike | undefined;  // { allow?, deny? }
  label: string;                        // 调试标识（如 "profile:default"）
  stripPluginOnlyAllowlist?: boolean;  // 是否剥离仅插件工具的白名单
};
```

**默认管道步骤（优先级从低到高）：**

```typescript
function buildDefaultToolPolicyPipelineSteps(params) {
  return [
    { label: "global",          policy: globalPolicy },
    { label: "globalProvider",  policy: globalProviderPolicy },
    { label: "agent",           policy: agentPolicy },
    { label: "agentProvider",   policy: agentProviderPolicy },
    { label: "group",           policy: groupPolicy },
    { label: "profile",         policy: profilePolicy },
    { label: "providerProfile", policy: providerProfilePolicy },
  ];
}
```

优先级最高的是 `profile`（auth profile 级别的策略），最低的是 `global`。这让运营者可以在全局设置宽松策略，然后对特定 auth profile 收紧。

**管道应用逻辑（applyToolPolicyPipeline）：**

```
初始：tools = 全量工具集

for each step in pipeline:
  if step.policy.allow exists:
    tools = expandGroups(step.policy.allow) 的交集
  if step.policy.deny exists:
    tools = 排除 expandGroups(step.policy.deny)
```

后续步骤的 allow/deny 会覆盖前面步骤的结果，而不是累加。这意味着高优先级策略可以完全推翻低优先级策略的结论。

---

### 7.5.4 插件工具组（Plugin Tool Groups）

插件注册的工具可以有自己的组：

```typescript
function buildPluginToolGroups(params: {
  tools: AnyAgentTool[];
  toolMeta: (tool) => { pluginId: string } | undefined;
}): PluginToolGroups {
  return {
    all: [...],                    // 所有插件工具名
    byPlugin: Map<string, string[]>  // 按插件 ID 分组
  };
}
```

策略中可以通过插件 ID 引用一个插件的所有工具：

```json
{
  "toolPolicy": {
    "allow": ["core", "plugin:my-discord-bot"]
  }
}
```

`stripPluginOnlyAllowlist` 用于一个边界情况：如果 allow 列表里只包含插件工具（没有核心工具），这通常是误配置——比如用户想允许某插件但忘记也允许核心工具。`strip` 后该步骤的 allow 策略变为 `undefined`（等同于"不限制"），避免意外封锁所有核心工具。

---

### 7.5.5 Owner-Only 工具

**文件：** `src/agents/tool-policy.ts`

某些工具只有 owner（机器拥有者）才能使用：

```typescript
function isOwnerOnlyToolName(name: string): boolean;

function applyOwnerOnlyToolPolicy(
  tools: AnyAgentTool[],
  senderIsOwner: boolean
): AnyAgentTool[];
```

如果 `senderIsOwner = false`（比如在 Discord 群里，消息来自非 owner 的用户），owner-only 工具会从工具集中移除。这些工具通常包括：
- `gateway`（修改 OpenClaw 配置）
- `exec` 高权限变体
- 某些 node 管理工具

---

### 7.5.6 沙箱工具策略

**文件：** `src/agents/sandbox/tool-policy.ts`

沙箱 session 有更严格的固定策略（不可被用户配置覆盖）：

```
允许：bash, process, read, write, edit,
      sessions_list, sessions_history, sessions_send, sessions_spawn
禁止：browser, canvas, nodes, cron, discord, gateway, 及所有渠道工具
```

沙箱的 `exec` 工具被替换为只能在 Docker 容器内执行的版本，无法访问宿主机文件系统（除了映射的 workspace 目录）。

---

## 7.6 Skill 平台

Skill 是 OpenClaw 的"即插即用"能力扩展机制。每个 Skill 是一个 Markdown 文件（`SKILL.md`），描述一项特定能力的使用方法。

### 7.6.1 Skill 的本质

Skill 不是代码插件，而是**给 Agent 看的操作手册**。Agent 读取 SKILL.md 后知道该调用哪些工具、用什么参数、按什么顺序操作。这是一种纯提示词层面的扩展，不需要改代码。

```
用户要求："帮我查天气"
  → Agent 扫描 system prompt 中的 <available_skills>
  → 发现 weather skill 匹配
  → 读取 ~/.openclaw/workspace/skills/weather/SKILL.md
  → 按 SKILL.md 的指引调用 web_fetch 获取天气数据
  → 格式化返回给用户
```

---

### 7.6.2 Skill 文件结构

一个完整的 Skill 目录：

```
skills/weather/
├── SKILL.md        # 主文件（必须）
├── assets/         # 可选：脚本、模板等辅助文件
└── scripts/        # 可选：可执行脚本
```

`SKILL.md` 的 frontmatter（YAML 头部）包含元数据：

```yaml
---
name: weather
description: Get current weather and forecasts via wttr.in or Open-Meteo.
always: false          # 是否始终注入（不需要显式触发）
skillKey: weather      # 唯一标识符
primaryEnv: WEATHER_API_KEY  # 主要依赖的环境变量
emoji: 🌤
homepage: https://clawhub.com/skills/weather
os: [darwin, linux]   # 支持的操作系统
requires:
  bins: [curl]          # 需要的命令行工具
  env: [OPENWEATHER_KEY]  # 可选：需要的环境变量
install:
  - kind: brew
    formula: wttr
  - kind: node
    package: weather-cli
---
```

---

### 7.6.3 Skill 类型定义

```typescript
type OpenClawSkillMetadata = {
  always?: boolean;       // true = 始终在 system prompt 中注入完整内容
  skillKey?: string;      // 唯一 key（用于过滤和引用）
  primaryEnv?: string;    // 主环境变量（用于 env 覆盖）
  emoji?: string;
  homepage?: string;
  os?: string[];          // ["darwin", "linux", "win32"]
  requires?: {
    bins?: string[];      // 全部都要有（AND）
    anyBins?: string[];   // 有一个就行（OR）
    env?: string[];       // 需要的环境变量
    config?: string[];    // 需要的 openclaw.json config 字段
  };
  install?: SkillInstallSpec[];
};
```

`SkillInstallSpec` 支持多种安装方式：

```typescript
type SkillInstallSpec = {
  kind: "brew" | "node" | "go" | "uv" | "download";
  label?: string;
  bins?: string[];         // 安装后提供的可执行文件
  os?: string[];           // 限定操作系统
  formula?: string;        // brew formula 名
  package?: string;        // npm/go/uv 包名
  module?: string;         // node 模块名（如果 package 和 module 不同）
  url?: string;            // 下载 URL（kind=download 用）
  archive?: string;        // 压缩包内的路径
  extract?: boolean;       // 是否解压
  stripComponents?: number; // tar --strip-components
  targetDir?: string;      // 安装目标目录
};
```

---

### 7.6.4 Skill 的四个来源

```typescript
// 1. 内置 Skill（随 OpenClaw 打包）
resolveBundledAllowlist()    // 按 config 的 allowlist 过滤
isBundledSkillAllowed()

// 2. Workspace Skill（用户自定义）
loadWorkspaceSkillEntries()  // 扫描 ~/workspace/skills/*/SKILL.md

// 3. 插件 Skill
plugin-skills.ts             // 插件注册的 Skill

// 4. 远程 Skill（通过 clawhub.com 安装）
syncSkillsToWorkspace()      // 同步到本地
```

**优先级（同名 Skill 时）：** Workspace > 插件 > 内置

---

### 7.6.5 Skills Prompt 的按需加载设计

Skills 不是全量预加载的，而是分两步：

**Step 1：只注入描述摘要（system prompt 构建时）**

```typescript
buildWorkspaceSkillsPrompt()  // 生成 <available_skills> XML 块
```

输出格式：
```xml
<available_skills>
  <skill>
    <name>weather</name>
    <description>Get current weather...</description>
    <location>/Users/claw/.openclaw/workspace/skills/weather/SKILL.md</location>
  </skill>
  ...
</available_skills>
```

这个 XML 只包含名称、描述、路径，不包含 SKILL.md 的完整内容。50 个 Skill 的描述摘要约 2,000 token。

**Step 2：Agent 按需读取（运行时）**

```
Agent 判断需要 weather skill
  → read("/Users/claw/.openclaw/workspace/skills/weather/SKILL.md")
  → 获得完整操作手册（约 500-2000 token）
  → 按手册操作
```

**节省效果：** 如果预加载所有 50 个 Skill 的完整内容，每次请求约消耗 50,000 token 的 context。按需加载后，通常只需要额外 500-2000 token。

---

### 7.6.6 always: true 的 Skill

某些 Skill 标记 `always: true`，表示它们应该在每次请求时自动注入完整内容，不需要 Agent 主动读取。适用场景：

- Skill 内容很短（< 500 token）
- Agent 几乎每次都需要它（比如 memory 相关 Skill）
- Skill 描述复杂、判断是否需要本身就需要读完整内容

---

### 7.6.7 Skill 命令（Skill Commands）

**文件：** `src/agents/skills/types.ts`

每个 Skill 可以注册"命令"，让用户通过 slash 命令直接调用：

```typescript
type SkillCommandSpec = {
  name: string;           // 命令名（如 "weather"）
  skillName: string;      // 对应的 Skill 名
  description: string;    // 命令描述
  dispatch?: SkillCommandDispatchSpec;  // 快捷 dispatch（可选）
};

type SkillCommandDispatchSpec = {
  kind: "tool";
  toolName: string;   // 直接调用这个工具，不经过 LLM
  argMode?: "raw";    // 将用户参数原样传给工具
};
```

`dispatch.kind = "tool"` + `argMode = "raw"` 实现了"绕过 LLM 直接调工具"的短路路径：

```
用户：/weather 北京
  → 直接调用 weather_fetch(args="北京")
  → 返回结果
  → 不消耗 LLM token
```

---

### 7.6.8 Skill 的调用策略

```typescript
type SkillInvocationPolicy = {
  userInvocable: boolean;       // 用户可以用 slash 命令触发
  disableModelInvocation: boolean;  // 禁止 Agent 自主触发（只能用户触发）
};
```

`disableModelInvocation = true` 用于一些高权限或高成本的 Skill（比如发邮件），确保只有用户明确要求时才执行，Agent 不会自作主张调用。

---

### 7.6.9 环境变量覆盖

**文件：** `src/agents/skills/env-overrides.ts`

Skill 可以声明自己需要的环境变量（通过 `primaryEnv`）。OpenClaw 支持在 config 中为特定 Skill 覆盖环境变量：

```json
{
  "skills": {
    "weather": {
      "env": {
        "OPENWEATHER_KEY": "xxxxx"
      }
    }
  }
}
```

在 Skill 执行时，`applySkillEnvOverrides` 将这些变量注入到工具的执行环境中，不污染全局环境。

---

## 7.7 Hook 系统

Hook 是 Pi 引擎的扩展点，允许插件在 Agent 运行的关键节点插入自定义逻辑。

### 7.7.1 Hook 类型

```
before_model_resolve   → 在模型解析之前（可覆盖模型选择）
before_agent_start     → Agent 开始前（旧版 hook，保持兼容）
tool_execution_start   → 工具执行前
tool_execution_end     → 工具执行后
agent_end              → Agent 运行结束后
```

### 7.7.2 模型覆盖 Hook

```typescript
// 新 hook（优先）
if (hookRunner?.hasHooks("before_model_resolve")) {
  modelResolveOverride = await hookRunner.runBeforeModelResolve(
    { prompt }, hookCtx
  );
}
// 旧 hook（兼容）
if (hookRunner?.hasHooks("before_agent_start")) {
  legacyResult = await hookRunner.runBeforeAgentStart(
    { prompt }, hookCtx
  );
  // 新 hook 的值优先于旧 hook
  modelResolveOverride = {
    providerOverride: modelResolveOverride?.providerOverride ?? legacyResult?.providerOverride,
    modelOverride:   modelResolveOverride?.modelOverride   ?? legacyResult?.modelOverride,
  };
}
```

**设计原则：** 新 hook 和旧 hook 并行触发，新值覆盖旧值。这让已有插件不需要修改就能继续工作，同时新插件可以使用更精确的 `before_model_resolve` hook。

### 7.7.3 工具执行 Hook 的异步处理

```typescript
// tool_execution_start 是 best-effort 的
handleToolExecutionStart(state, evt).catch(() => {}); // 静默失败

// tool_execution_end 同理
handleToolExecutionEnd(state, evt).catch(() => {});
```

工具执行的 hook 是异步且 best-effort 的：失败了也不阻塞 Agent 执行。这是有意为之的——typing indicator、进度通知、日志上报都是辅助性的，不应因为这些操作失败就中断核心任务。

---

## 7.8 Session 文件完整性

Pi 引擎对 session 文件（历史消息的持久化存储）有专门的保护机制。

### 7.8.1 写锁（Write Lock）

在构建 system prompt 之后，正式调用 LLM 之前，Pi 引擎会获取 session 文件的独占写锁。这防止两个并发请求同时修改同一个 session 文件。

Lane 队列（双层队列）在大多数情况下已经保证了串行，写锁是额外的保障：当 Lane 因为某些边界情况失效时，文件锁确保不会发生写冲突。

### 7.8.2 文件修复（Session Repair）

session 文件可能因为崩溃、断电等原因损坏（比如写到一半的 JSON）。Pi 引擎在加载 session 文件时会先尝试修复：

```
加载 session 文件
  → JSON 解析失败
  → 尝试截断到最后一个完整记录
  → 如果截断成功：继续（丢失最近一条消息，但 session 不崩溃）
  → 如果无法修复：创建新 session（丢失所有历史）
```

宁可丢失最近一条消息，也不让用户看到"session 损坏，无法继续"的错误。

---

## 7.9 Usage 追踪的精确性

Token 使用量追踪看似简单，实际有一个微妙的正确性问题。

### 问题：多轮 tool call 的 cache 膨胀

一次 Agent 运行可能包含多轮 LLM 调用（每调用一次工具就需要再次调用 LLM）。每轮 API 调用都报告 `cacheRead ≈ 当前上下文大小`。如果累加所有轮次：

```
轮次 1：cacheRead = 50,000
轮次 2：cacheRead = 55,000
轮次 3：cacheRead = 60,000
累加后：cacheRead = 165,000 ← 错误！实际上下文只有 60,000
```

### 解决方案：区分累加值和最新值

```typescript
type UsageAccumulator = {
  input: number;          // 累加（每轮新增的 input）
  output: number;         // 累加（总生成量）
  cacheRead: number;      // 累加（用于总成本统计）
  cacheWrite: number;     // 累加
  total: number;          // 累加
  lastCacheRead: number;  // 仅最新一轮（用于当前 context 大小计算）
  lastCacheWrite: number;
  lastInput: number;
};
```

`output` 用累加值（每轮都有新的生成），`cacheRead` 在计算 context 大小时用 `lastCacheRead`（只看最新一轮）。

---

## 7.10 外循环：run.ts 重试引擎

### 7.10.1 双层队列

```typescript
const sessionLane = resolveSessionLane(params.sessionKey);
const globalLane = resolveGlobalLane(params.lane);

return enqueueSession(() =>       // 第一层：session 级串行
  enqueueGlobal(async () => {     // 第二层：全局级并发控制
    // 实际执行逻辑
  })
);
```

**为什么需要双层？** 单层无法同时满足：（1）同 session 请求必须串行，（2）不同 session 应该并行。双层嵌套实现了"session 内串行、session 间并行"。

### 7.10.2 动态重试上限

```typescript
function resolveMaxRunRetryIterations(profileCandidateCount: number): number {
  const scaled = 24 + Math.max(1, profileCandidateCount) * 8;
  return Math.min(160, Math.max(32, scaled));
}
// 1 个 profile → max 32
// 3 个 profile → max 48
// 10 个 profile → max 104
// 任意 → 最多 160
```

### 7.10.3 六种错误恢复策略

| 错误类型 | 恢复策略 |
|---------|---------|
| Rate limit | 标记 profile cooldown → 切换 profile |
| Auth error | 刷新 token → 切换 profile |
| Context overflow | 截断 tool result → compaction（渐进，最多 3 次）|
| Overloaded | 指数退避 250-1500ms（带 jitter）|
| Billing error | 标记 cooldown → 切换 profile |
| Thinking level | 降级 high→medium→low→off |

### 7.10.4 Auth Profile 轮转与 Transient Probe

```
resolveAuthProfileOrder() → 按配置排序所有 profile
  → 跳过 cooldown 中的 profile
    → 激活选中 profile
      → 如果所有 profile 都在 cooldown：
        → 检查是否允许 transient probe
          → 允许：选 cooldown 最长的试一下（探测是否恢复）
          → 不允许：抛 FailoverError
```

**Transient Probe** 是微妙的：当所有 key 都被限速时，与其直接放弃，不如对最可能恢复的那个 key 做一次探测调用。探测失败继续等，探测成功则立刻切换过去。

### 7.10.5 GitHub Copilot Token 刷新

```typescript
// 提前 5 分钟自动刷新
const refreshAt = copilotTokenState.expiresAt - COPILOT_REFRESH_MARGIN_MS;
// 失败后 60 秒重试一次
setTimeout(() => refreshCopilotToken("scheduled-retry"), COPILOT_REFRESH_RETRY_MS);
```

---

## 7.11 Sandbox 隔离

非 main session 可以启用 Docker 沙箱：

```
src/agents/sandbox/
├── config.ts          # 沙箱配置解析
├── constants.ts       # 默认镜像名、安全常量
├── context.ts         # 沙箱上下文（工作空间映射）
├── docker.ts          # Docker 命令执行
├── manage.ts          # 容器管理（列出、删除）
├── runtime-status.ts  # 运行时状态
├── tool-policy.ts     # 工具白名单/黑名单（固定，不可覆盖）
└── types.ts           # 类型定义
```

每个非 main session 有自己的 Docker 容器，workspace 目录通过 volume 映射。容器在 session 不活跃时自动清理。

---

## 7.12 System Prompt 组装

### 7.12.1 组装结构

```
## Identity
  → "You are [name], a personal AI assistant"

## Skills (mandatory)
  → <available_skills> XML（技能描述摘要）

## Memory Recall
  → "Run memory_search before answering..."

## Authorized Senders
  → "Authorized: a1b2c3d4e5f6"（HMAC 哈希，不暴露真实 ID）

## Current Date & Time
  → 时区 + 当前时间

## Reply Tags
  → [[reply_to_current]] / [[reply_to:<id>]] 说明

## Messaging
  → 消息工具规则 + 渠道能力描述

[AGENTS.md 内容]
[SOUL.md 内容]
[TOOLS.md 内容]

## Runtime
  → channel / session key / agent ID / model 等
```

### 7.12.2 Owner 身份保护

```typescript
const digest = hasSecret
  ? createHmac("sha256", secret).update(ownerId).digest("hex")  // HMAC（更安全）
  : createHash("sha256").update(ownerId).digest("hex");          // 纯 hash
return digest.slice(0, 12);  // 12 位 hex
```

System prompt 中不暴露 owner 的真实手机号或 user ID，只显示 12 位哈希值。配置了 `ownerDisplaySecret` 时使用 HMAC——攻击者即使知道哈希值也无法反推原始 ID。

---

## 7.13 本章要点

Pi 引擎的核心架构特征总结：

| 模块 | 核心机制 | 设计目标 |
|------|---------|---------|
| 上下文管理 | 四层防线（Guard/截断/Compaction/Pruning）| 永远不让 context overflow 崩溃 |
| Sub-agent | 推送式完成 + 幂等 announce + 深度限制 | 并发执行 + 可靠通知 + 防无限递归 |
| 工具策略 | 多层管道 + 组展开 + owner 保护 | 精细授权 + 沙箱隔离 |
| Skill 平台 | 按需加载 + SKILL.md 操作手册 | 低 token 成本 + 零代码扩展 |
| 重试引擎 | 六种错误恢复 + Auth 轮转 + Transient Probe | 在多 key / 多模型环境中最大化可用性 |
| Hook 系统 | 新旧兼容 + best-effort 异步 | 插件可扩展 + 不影响核心稳定性 |

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/agents/pi-embedded-runner/run.ts` | ★★★ | 外循环重试引擎（1502 行）|
| `src/agents/pi-embedded-runner/run/attempt.ts` | ★★★ | 单次 LLM 调用全流程（2096 行）|
| `src/agents/compaction.ts` | ★★★ | Compaction 算法（自适应分块 + 渐进压缩）|
| `src/agents/pi-extensions/context-pruning/` | ★★ | Context Pruning 扩展（轻量主动裁剪）|
| `src/agents/subagent-spawn.ts` | ★★★ | Sub-agent 派生入口 |
| `src/agents/subagent-registry.types.ts` | ★★ | SubagentRunRecord 完整结构 |
| `src/agents/subagent-announce.ts` | ★★ | 完成广播 + 重试机制 |
| `src/agents/tool-policy-pipeline.ts` | ★★★ | 工具策略管道 |
| `src/agents/tool-policy-shared.ts` | ★★ | 工具组定义 |
| `src/agents/skills/types.ts` | ★★★ | Skill 元数据类型完整定义 |
| `src/agents/skills/workspace.ts` | ★★ | Skill 加载 + prompt 生成 |
| `src/agents/system-prompt.ts` | ★★★ | System prompt 组装（725 行）|
| `src/agents/pi-embedded-runner/tool-result-context-guard.ts` | ★★ | 工具结果截断 |
| `src/agents/context-window-guard.ts` | ★ | Context window 检测 |
