# 第 10 章 上下文管理

## 10.1 为什么上下文管理是独立议题

LLM 的 context window 是有限资源。一个长对话、一次读取大文件、一次 bash 输出洪流，都可能让 context 快速耗尽。Pi 引擎不依赖"祈祷不会溢出"，而是实现了**四层防线**——每一层应对不同烈度的 context 压力。

## 10.2 四层防线全貌

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

## 10.3 第一层：Context Window Guard

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

## 10.4 第二层：Tool Result Context Guard

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

## 10.5 第三层：Compaction（历史压缩）

**文件：** `src/agents/compaction.ts`, `src/agents/pi-embedded-runner/compact.ts`

### 触发时机

1. LLM 返回 context overflow 错误（自动）
2. 用户执行 `/compact` 命令（手动）

Compaction 的本质：**用 LLM 对自己的对话历史做摘要，用摘要替换原始历史**。

### 核心算法

```
输入：完整的历史消息列表
输出：一段摘要文本（由 LLM 生成）

步骤：
1. estimateMessagesTokens()    — 粗估总 token 数
2. computeAdaptiveChunkRatio() — 动态调整分块比
3. chunkMessagesByMaxTokens()  — 按 maxTokens 切块
4. summarizeInStages()         — 分阶段压缩
5. 用摘要替换历史消息，重写 session 文件
```

### 自适应分块比

```typescript
export const BASE_CHUNK_RATIO = 0.4;   // 基础：40% context window
export const MIN_CHUNK_RATIO = 0.15;   // 最小：15% context window
export const SAFETY_MARGIN = 1.2;      // 安全系数

function computeAdaptiveChunkRatio(messages, contextWindow) {
  const avgMsgTokens = estimateMessagesTokens(messages) / messages.length;
  const bigMessagePenalty = avgMsgTokens / contextWindow;
  return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - bigMessagePenalty);
}
```

**设计动机**：有些对话包含少量但极大的消息（比如一次读取了整个代码文件）。固定比例分块会导致单块超过模型上限。自适应分块比在检测到大消息时自动缩小块大小。

### 渐进式压缩降级（summarizeWithFallback）

```
阶段 1：尝试整体压缩（一次处理所有 chunks）
  ↓ 失败（某条消息 > 50% context window）
阶段 2：移除超大消息后压缩
  ↓ 仍然失败
阶段 3：pruneHistoryForContextShare
         ——按 token 配额保留最近消息（硬截断）
```

```typescript
function isOversizedForSummary(msg, contextWindow): boolean {
  // 单条消息 > 50% context window → 无法安全压缩
  return estimateTokens(msg) > contextWindow * 0.5;
}
```

### Compaction 安全超时

**文件：** `src/agents/pi-embedded-runner/compaction-safety-timeout.ts`

Compaction 本身是一次 LLM 调用，历史很长时可能很慢。安全超时确保 Compaction 卡住时能强制退出，避免整个 Agent 被卡死。

### 自定义压缩指令

```typescript
type CompactionSummarizationInstructions = {
  identifierPolicy?: AgentCompactionIdentifierPolicy;
  identifierInstructions?: string;
};
```

`identifierPolicy` 控制摘要中如何处理特殊标识符（文件路径、session key、tool call ID），影响摘要的可读性和对后续 Agent 行为的指导效果。

---

## 10.6 第四层：Context Pruning（主动裁剪）

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

## 10.7 四层防线的触发时序

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

## 10.8 本章要点

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
| `src/agents/compaction.ts` | ★★★ | 第三层：历史压缩算法 |
| `src/agents/pi-embedded-runner/compact.ts` | ★★ | 第三层：Compaction 执行入口 |
| `src/agents/pi-extensions/context-pruning/pruner.ts` | ★★ | 第四层：Pruning 实现 |
| `src/agents/pi-extensions/context-pruning/settings.ts` | ★ | 第四层：配置与默认值 |
