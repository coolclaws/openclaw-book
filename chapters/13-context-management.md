# 第 13 章 上下文管理

## 13.1 为什么上下文管理是独立议题

LLM 的 context window 是有限资源。一个长对话、一次读取大文件、一次 bash 输出洪流，都可能让 context 快速耗尽。Pi 引擎不依赖"祈祷不会溢出"，而是实现了**四层防线**——每一层应对不同烈度的 context 压力。

## 13.2 四层防线全貌

```
┌─────────────────────────────────────────────────────────┐
│ 第一层：Context Window Guard（入口检测）                  │
│   在调用 LLM 之前检查模型 context window 大小             │
│   tokens < 16k → 拒绝（FailoverError → 触发模型切换）     │
│   tokens < 32k → 警告（继续但记录日志）                   │
├─────────────────────────────────────────────────────────┤
│ 第二层：Tool Result Context Guard（工具结果截断）         │
│   工具执行后，对超大结果进行截断或清除                     │
│   防止单次工具调用撑爆整个 context                        │
├─────────────────────────────────────────────────────────┤
│ 第三层：Compaction（历史压缩，响应式）                    │
│   LLM 返回 context overflow 错误时触发                    │
│   用 LLM 对历史对话做摘要压缩，并重写 session 文件         │
├─────────────────────────────────────────────────────────┤
│ 第四层：Context Pruning（主动裁剪，主动式）               │
│   每次请求前检查工具结果缓存是否过期                       │
│   过期的 tool result 先 soft trim，再 hard clear          │
│   只影响内存，不重写磁盘                                  │
└─────────────────────────────────────────────────────────┘
```

---

## 13.3 第一层：Context Window Guard

**文件：** `src/agents/context-window-guard.ts`

```typescript
export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;

export type ContextWindowSource =
  | "model"             // 模型元数据自带
  | "modelsConfig"      // openclaw.json 的 models 配置
  | "agentContextTokens" // agent 专项配置
  | "default";          // 兜底默认值
```

### 解析优先级（高 → 低）

```
agentContextTokens（agent 级，最精细）
  → modelsConfig（全局 models 配置）
    → model（模型元数据自带）
      → default（兜底）
```

同一个模型在不同场景可以配置不同的 context——main session 用 200k，subagent 只用 32k，节省成本。

### Guard 的三种结果

```typescript
type ContextWindowGuardResult = {
  tokens: number;
  source: ContextWindowSource;
  shouldWarn: boolean;   // < 32k：记录日志，继续执行
  shouldBlock: boolean;  // < 16k：直接抛 FailoverError，触发模型切换
};
```

`shouldBlock = true` 时，Pi 引擎不浪费这次 API 调用，立刻抛出 `FailoverError`，外循环的模型切换逻辑会找一个 context window 更大的模型。

---

## 13.4 第二层：Tool Result Context Guard

**文件：** `src/agents/pi-embedded-runner/tool-result-context-guard.ts`

工具可能返回巨量数据（读取 10MB 文件、长篇日志输出）。Guard 在每次工具执行完成后检查结果大小，超限时应用两种处理：

```typescript
// 方式一：截断（保留前段内容）
const CONTEXT_LIMIT_TRUNCATION_NOTICE =
  "[truncated: output exceeded context limit]";

// 方式二：预先清除（整个结果用占位符替代）
const PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER =
  "[compacted: tool output removed to free context]";
```

| 场景 | 处理方式 |
|------|---------|
| 结果大但未超临界值 | 截断（保留前段 + 通知） |
| 单个结果已占 context 的相当比例 | 预先清除（整个替换为占位符）|

`installToolResultContextGuard` 通过拦截 agent 的工具结果写入路径来工作，返回 `uninstall` 函数，在运行结束后卸载拦截器。

---

## 13.5 第三层：Compaction（历史压缩）

**文件：** `src/agents/compaction.ts`、`src/agents/pi-embedded-runner/compact.ts`、`src/agents/pi-embedded-runner/compaction-safety-timeout.ts`

Compaction 的本质：**用一次专门的 LLM 调用，将当前对话历史压缩成摘要，用摘要替换原始历史，并重写 session 文件**。代价较高但效果彻底，是 context overflow 后的主力恢复手段。

### 13.5.1 触发路径

```
外循环（run.ts）捕获到 context overflow 错误
  → isLikelyContextOverflowError() = true
  → overflowCompactionAttempts < 3（最多尝试 3 次）
  → 先执行步骤 1：截断过大的 tool result（代价低）
  → 重试 LLM 调用
  → 仍然失败
  → 步骤 2：调用 compactEmbeddedPiSessionDirect(...)
  → overflowCompactionAttempts += 1
  → 重试 LLM 调用
  → 仍然失败 → 再次 compaction（最多 3 次）
  → 3 次都失败 → 返回 error: "compaction_failure"

或：用户执行 /compact 命令
  → 调用 compactEmbeddedPiSession(...)（带 Lane 排队）
  → trigger: "manual"
```

**两个入口的区别（关键）：**

```typescript
// 入口 A：带 Lane 排队（外部调用）
compactEmbeddedPiSession(params)
  → enqueueSession(() => enqueueGlobal(() => compactEmbeddedPiSessionDirect(params)))

// 入口 B：直接执行（已在 Lane 内部时使用）
compactEmbeddedPiSessionDirect(params)
```

外循环在 overflow 时调用 Compaction，此时**已经在 session lane 和 global lane 内部**。如果再调用 `compactEmbeddedPiSession`，会在同一个 lane 上再次入队，形成死锁（等待自己释放锁）。因此 overflow 触发时必须用 `Direct` 版本。用户手动 `/compact` 从 lane 外部触发，用带排队版本，保证和正在进行的其他请求串行。

---

### 13.5.2 核心参数

`compactEmbeddedPiSessionDirect` 接收的关键参数：

```typescript
type CompactEmbeddedPiSessionParams = {
  sessionFile: string;    // session JSONL 文件路径
  workspaceDir: string;   // 工作区目录
  provider?: string;      // 用于压缩的模型 provider
  model?: string;         // 用于压缩的模型（可与对话模型不同）
  tokenBudget?: number;   // 目标压缩后 token 上限
  force?: boolean;        // 强制压缩（即使 session 不大）
  trigger?: "overflow" | "manual";
  attempt?: number;       // 当前是第几次尝试（最多 maxAttempts）
  maxAttempts?: number;
  customInstructions?: string; // 用户自定义的压缩指令
  summarizationInstructions?: CompactionSummarizationInstructions; // 标识符处理策略
};
```

`model` 可以与对话中使用的模型**不同**——压缩任务计算量大但不需要最新知识，可以选择一个高 context、低成本的模型专门做压缩。

---

### 13.5.3 执行流程全貌

```
compactEmbeddedPiSessionDirect
  │
  ├─ 1. 加载并解析 session JSONL
  │     → messages: AgentMessage[]
  │
  ├─ 2. estimateMessagesTokens(messages)
  │     → 粗估全部历史的 token 总量（字符数 / 4 近似估算）
  │
  ├─ 3. computeAdaptiveChunkRatio(messages, contextWindow)
  │     → 计算每块最多占 context 的比例
  │     → maxChunkTokens = contextWindow × chunkRatio
  │
  ├─ 4. chunkMessagesByMaxTokens(messages, maxChunkTokens)
  │     → 将 messages 按 token 上限贪心分块
  │     → 得到 chunks: AgentMessage[][]
  │
  ├─ 5. summarizeInStages(chunks, ...)
  │     → 对每个 chunk 依次调用 LLM 生成摘要
  │     → 前一个 chunk 的摘要作为下一个的 previousSummary 传入
  │     → 最终合并为一段完整摘要文本
  │
  ├─ 6. 用摘要重写 session 文件
  │     → 新 session = [单条 "summary" 消息 + 最近 N 条保留消息]
  │     → 记录 firstKeptEntryId
  │
  └─ 7. 返回 EmbeddedPiCompactResult
        { ok, compacted, result: { summary, firstKeptEntryId, tokensBefore, tokensAfter } }
```

压缩完成后 Pi 引擎用新的（更短的）session 文件重新发起 LLM 调用，context overflow 被解除。

---

### 13.5.4 分块算法：chunkMessagesByMaxTokens

```
输入：messages（完整历史）, maxTokens（单块 token 上限）

greedy 贪心分块：
  currentChunk = []
  currentTokens = 0

  for msg in messages:
    msgTokens = estimateMessagesTokens([msg]) × SAFETY_MARGIN（× 1.2）
    if currentTokens + msgTokens > maxTokens AND currentChunk 非空:
      → 封口当前 chunk，push 到结果
      → 开始新 chunk
    currentChunk.push(msg)
    currentTokens += msgTokens

  → 最后一个 chunk 追加到结果
```

`SAFETY_MARGIN = 1.2`：token 估算本身是近似值（字符数 / 4），乘以 1.2 相当于给估算加 20% 缓冲，避免实际发送时因估算偏低超出模型限制。

**边界情况**：单条消息本身超过 `maxTokens` 时，贪心算法允许它独占一个 chunk（否则永远无法处理这条消息）。这个 chunk 在 `summarizeWithFallback` 中会被标记为 `isOversizedForSummary`，走特殊降级处理。

---

### 13.5.5 自适应分块比：computeAdaptiveChunkRatio

```typescript
const BASE_CHUNK_RATIO = 0.4;    // 基础：每块最多占 40% context window
const MIN_CHUNK_RATIO = 0.15;    // 最小：每块最多占 15% context window
const SAFETY_MARGIN = 1.2;

function computeAdaptiveChunkRatio(
  messages: AgentMessage[],
  contextWindow: number
): number {
  const totalEstimate = estimateMessagesTokens(messages);
  const avgMsgTokens = totalEstimate / messages.length;

  // 平均消息越大，惩罚越重，块越小
  const bigMessagePenalty = avgMsgTokens / contextWindow;

  return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - bigMessagePenalty);
}
```

**为什么需要自适应？** 考虑两种极端情况：

| 场景 | 典型消息大小 | 固定 40% 分块的问题 |
|------|------------|-------------------|
| 普通聊天 | ~100 tokens/条 | 没问题，每块约 80k tokens |
| 读取了大文件 | ~20k tokens/条 | 一条消息可能 > 40%，分块失效 |

自适应分块比检测到"平均消息大"时自动缩小 chunkRatio，让每块容纳更少消息，避免单块超出模型限制。

**计算示例：**
- contextWindow = 200 000 tokens
- 对话有 5 条消息，共 80 000 tokens，avgMsgTokens = 16 000
- bigMessagePenalty = 16 000 / 200 000 = 0.08
- chunkRatio = max(0.15, 0.4 - 0.08) = **0.32**
- maxChunkTokens = 200 000 × 0.32 = **64 000 tokens/块**

---

### 13.5.6 分阶段压缩：summarizeInStages

```typescript
export const SUMMARIZATION_OVERHEAD_TOKENS = 4096;

async function summarizeInStages(params: {
  messages: AgentMessage[];
  model, apiKey, signal,
  reserveTokens: number;   // 为摘要输出预留的 token（防止截断）
  maxChunkTokens: number;
  contextWindow: number;
  previousSummary?: string; // 如果之前有过一次 compaction，传入上次的摘要
  parts?: number;           // 分几段处理（大量消息时并行或串行）
  minMessagesForSplit?: number;
}): Promise<string>
```

**核心思路：滚动压缩**

```
previousSummary = ""（或上次 compaction 的摘要）

for chunk in chunks:
  调用 LLM:
    system: "你是一个对话历史压缩助手，请将以下对话历史压缩为简洁摘要..."
    user:
      [如果有 previousSummary] "先前已有摘要：\n{previousSummary}\n\n"
      "请继续压缩以下对话：\n{chunk 消息序列化}"
  → 得到新摘要文本
  previousSummary = 新摘要

最终 previousSummary 即为完整压缩结果
```

**为什么要"滚动"而不是把所有历史一次发给 LLM？**

如果历史总量是 context window 的 3 倍，一次无法放入。分块 + 滚动的方式让每次 LLM 调用只处理一块（maxChunkTokens），但通过 `previousSummary` 保持上下文连贯：LLM 在压缩第 3 块时，知道第 1、2 块的摘要内容，生成的摘要才有完整的故事线。

`SUMMARIZATION_OVERHEAD_TOKENS = 4096`：每次 LLM 调用中，需要为 LLM 的输出（摘要本身）预留空间。这 4096 tokens 从 `maxChunkTokens` 中扣除，确保摘要不会被截断。

---

### 13.5.7 渐进降级：summarizeWithFallback

当某个 chunk 包含 oversized 消息时，`summarizeWithFallback` 依次尝试三个策略：

```
策略 1：全量压缩（尝试把 chunk 原样发给 LLM）
  ↓ 失败（isOversizedForSummary = true，单条消息 > 50% context window）

策略 2：剔除 oversized 消息后压缩
  → filter out isOversizedForSummary(msg) 的消息
  → 只压缩剩余消息
  → 在摘要中注明"[部分大消息因超限被省略]"
  ↓ 仍然失败（例如剩余消息也超限）

策略 3：pruneHistoryForContextShare（硬截断兜底）
  → 不再尝试 LLM 压缩
  → 直接按 token 配额保留最近消息
  → 丢弃最老的消息
```

```typescript
function isOversizedForSummary(msg: AgentMessage, contextWindow: number): boolean {
  // 单条消息 token > 50% context window → 无法安全压缩
  // （因为仅这一条就超过了 maxChunkTokens，无论怎么分块都会超限）
  return estimateMessagesTokens([msg]) * SAFETY_MARGIN > contextWindow * 0.5;
}
```

---

### 13.5.8 硬截断兜底：pruneHistoryForContextShare

这是 Compaction 体系中代价最低、但效果也最粗暴的最后防线：

```typescript
function pruneHistoryForContextShare(params: {
  messages: AgentMessage[];
  maxContextTokens: number;   // context window 总量
  maxHistoryShare?: number;   // 历史可占 context 的最大比例（默认 ~0.8）
  parts?: number;             // 分几段（用于 splitMessagesByTokenShare）
}): {
  messages: AgentMessage[];    // 保留的消息
  droppedMessagesList: AgentMessage[];
  droppedChunks: number;
  droppedMessages: number;
  droppedTokens: number;
  keptTokens: number;
  budgetTokens: number;
}
```

**算法：**

```
budgetTokens = maxContextTokens × maxHistoryShare
             （例如 200k × 0.8 = 160k tokens 用于历史）

从最新消息往前累加：
  for msg in messages（reversed）:
    msgTokens = estimateMessagesTokens([msg]) × SAFETY_MARGIN
    if keptTokens + msgTokens <= budgetTokens:
      keep(msg)
      keptTokens += msgTokens
    else:
      drop(msg)  ← 直接丢弃，没有摘要
```

**返回的统计信息**让调用方知道丢了多少：
- `droppedTokens`：丢掉了多少 token 的历史
- `keptTokens`：保留了多少
- `droppedMessages`：丢弃了几条消息

这些数据会写入 `EmbeddedPiCompactResult.result.details`，可在日志中查看。

---

### 13.5.9 结果与 session 文件重写

Compaction 成功后：

```typescript
type EmbeddedPiCompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;   // 失败时的原因
  result?: {
    summary: string;          // 压缩后的摘要文本
    firstKeptEntryId: string; // 摘要之后第一条被保留的原始消息 ID
    tokensBefore: number;     // 压缩前 token 数
    tokensAfter?: number;     // 压缩后 token 数
    details?: unknown;        // pruneHistoryForContextShare 的统计（如果走了硬截断）
  };
};
```

**session 文件重写：**

```
旧 session 文件（JSONL）：
  [user: 消息1]
  [assistant: 回复1]
  [tool_use: exec(...)]
  [tool_result: ...]
  ... (几十条消息)

新 session 文件（压缩后）：
  [assistant: "以下是对话历史摘要：\n用户询问了 X，我执行了 Y..."]  ← 单条摘要消息
  [user: 最近一条用户消息]   ← firstKeptEntryId 之后的消息被保留
  [assistant: 最近的回复]
```

`firstKeptEntryId` 标记了"摘要之后哪些原始消息被原样保留"——通常是最近 2-3 轮对话，让 LLM 在摘要之后仍有完整的近期上下文。

---

### 13.5.10 安全超时与重试上限

**安全超时：**

```typescript
const EMBEDDED_COMPACTION_TIMEOUT_MS = 300_000;  // 5 分钟

async function compactWithSafetyTimeout<T>(
  compact: () => Promise<T>,
  timeoutMs = EMBEDDED_COMPACTION_TIMEOUT_MS
): Promise<T>
```

Compaction 本身是一次 LLM 调用，历史很长时可能极慢（分块多、轮次多）。5 分钟上限确保卡住时能强制退出，不让整个 Agent 因 Compaction 永久挂起。超时后 Compaction 被视为失败，外循环记录 `"compaction_failure"` 错误。

**重试上限：**

外循环最多尝试 Compaction **3 次**（`overflowCompactionAttempts < 3`）。3 次全部失败后：

```typescript
meta.error = {
  kind: "compaction_failure",
  message: "Failed to compact session after 3 attempts"
}
```

Agent 退出，将错误信息反馈给用户。3 次上限防止在极端情况下（比如 session 文件本身损坏）陷入无限重试循环。

---

### 13.5.11 自定义压缩指令

```typescript
type CompactionSummarizationInstructions = {
  identifierPolicy?: AgentCompactionIdentifierPolicy;
  identifierInstructions?: string;
};
```

`identifierPolicy` 控制摘要中如何处理特殊标识符：

| 策略 | 效果 |
|------|------|
| `"preserve"` | 保留原始 ID（文件路径、tool call ID），摘要可精确回溯 |
| `"anonymize"` | 匿名化 ID，减少摘要大小，但无法精确回溯 |

`identifierInstructions` 允许注入自定义指令，例如"压缩时请特别保留所有涉及文件路径的信息"，影响 LLM 在生成摘要时的侧重点。

---

## 13.6 第四层：Context Pruning（主动裁剪）

**文件：** `src/agents/pi-extensions/context-pruning/`

### 与 Compaction 的区别

| | Compaction | Context Pruning |
|--|--|--|
| 触发时机 | 响应式（overflow 后）| 主动式（每次请求前）|
| 操作方式 | LLM 摘要压缩 | 直接删除/截断旧工具结果 |
| 成本 | 高（额外 LLM 调用）| 低（纯内存操作）|
| 磁盘影响 | 重写 session 文件 | **不写磁盘**，只影响当次请求 |
| 默认状态 | 自动触发 | opt-in |

**核心特性：只影响内存，不重写 session 文件。**

Pruning 是"对 LLM 说谎"——告诉 LLM 某些历史工具结果已不存在了，但磁盘里还有完整记录。这对需要精确 context 的场景（代码审查、精确回溯）可能有影响，因此默认关闭。

### Pruning 模式

```typescript
type ContextPruningMode = "off" | "cache-ttl";
```

`cache-ttl`：基于缓存过期时间决定哪些工具结果应被裁剪。

### 两级处理

```typescript
type EffectiveContextPruningSettings = {
  ttlMs: number;              // 工具结果的 TTL（超时后视为可裁剪）
  keepLastAssistants: number; // 最近 N 个 assistant 回复永远保留

  softTrimRatio: number;      // context 占用 > 此比例 → 触发软裁剪
  hardClearRatio: number;     // context 占用 > 此比例 → 触发硬清除

  softTrim: {
    maxChars: number;   // 超过此长度才裁剪
    headChars: number;  // 保留开头多少字
    tailChars: number;  // 保留结尾多少字
  };
  hardClear: {
    enabled: boolean;
    placeholder: string;  // "[compacted: tool output removed...]"
  };
};
```

**决策流程：**

```
工具结果过期（超过 TTL）?
  → 是
  → 该结果占 context 比例 > hardClearRatio?
    → 是 → 硬清除（整个替换为占位符）
    → 否 → 该结果字符数 > softTrim.maxChars?
      → 是 → 软裁剪（保留头尾）
      → 否 → 跳过（太小，不值得裁剪）
```

---

## 13.7 四层防线的触发时序

```
用户消息到达
  ↓
[第一层] Context Window Guard
  → 模型 context window < 16k → FailoverError → 模型切换
  → 继续
  ↓
[第四层] Context Pruning（如果启用）
  → 裁剪过期工具结果（仅内存）
  ↓
构建 system prompt + 工具集
  ↓
LLM 调用（streaming）
  ↓
工具执行循环
  ↓
[第二层] Tool Result Guard
  → 截断 / 清除超大工具结果
  ↓
下一轮 LLM 调用
  ↓ 出现 context overflow 错误
[第三层] Compaction
  → 分阶段压缩历史 → 重写 session 文件 → 重试
```

---

## 13.8 本章要点

四层防线的设计哲学：**不同烈度的 context 压力由不同层次应对**。

| 防线 | 应对的压力 | 代价 |
|------|---------|------|
| Context Window Guard | 模型根本不够用 | 零（拒绝，触发模型切换）|
| Tool Result Guard | 单次工具输出过大 | 极低（截断字符串）|
| Compaction | 历史对话累积过多 | 高（额外 LLM 调用 + 磁盘写入）|
| Context Pruning | 工具缓存过期占位 | 低（内存操作）|

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/agents/context-window-guard.ts` | ★★★ | 第一层：入口检测 |
| `src/agents/pi-embedded-runner/tool-result-context-guard.ts` | ★★ | 第二层：工具结果截断 |
| `src/agents/compaction.ts` | ★★★ | 第三层：分块、自适应比、summarizeInStages、pruneHistoryForContextShare |
| `src/agents/pi-embedded-runner/compact.ts` | ★★★ | 第三层：两个入口（带/不带 Lane 排队）+ 完整执行流程 |
| `src/agents/pi-embedded-runner/compaction-safety-timeout.ts` | ★★ | 第三层：5 分钟安全超时 |
| `src/agents/pi-extensions/context-pruning/pruner.ts` | ★★ | 第四层：Pruning 实现 |
| `src/agents/pi-extensions/context-pruning/settings.ts` | ★ | 第四层：配置与默认值 |
