# 第 19 章 Sub-agent 系统

## 19.1 设计动机

单个 Agent 在处理复杂任务时面临两个瓶颈：**token 上限**和**串行执行**。Sub-agent 系统解决这两个问题——父 Agent 可以把工作分解成多个子任务，并行派生子 Agent 执行，然后等待所有子 Agent 完成后汇总结果。

## 19.2 什么时候会用到 Sub-agent

Sub-agent **不会自动触发**——必须由 Agent 主动调用 `sessions_spawn` 工具，或者用户通过 Skill 引导 Agent 去派生子任务。

### 典型触发场景

**1. 大型代码任务（通过 coding-agent Skill）**

用户说"帮我重构这个项目"或"看一下这个 PR"，Agent 加载 `coding-agent` Skill，Skill 指导 Agent 调用 `sessions_spawn` 将任务委托给 Claude Code / Codex 等外部编码 Agent（`runtime: "acp"`）或内部 Pi Agent（`runtime: "subagent"`）。

**2. 并行拆分复杂任务**

Agent 判断一个任务可以并行化时（如"分别搜索三个话题并汇总"），主动派生多个子 Agent 同时执行，然后等待所有完成后合并结果。

**3. 隔离高风险操作**

主 Agent 不想污染自己的 context 或冒险执行某段代码，派生一个子 Agent 专门处理，失败了不影响主流程。

**4. Thread-bound 对话会话**

在 Discord 上，用户要求在一个独立线程里启动持久 coding session（`mode: "session"`），主 Agent 派生一个绑定到该 thread 的子 session，后续消息直接路由到子 session。

### 两种运行模式

```typescript
const SUBAGENT_SPAWN_MODES = ["run", "session"] as const;
```

| 模式 | 行为 |
|------|------|
| `"run"` | 一次性任务：执行完成后自动结束，通过广播（announce）回报结果 |
| `"session"` | 持久会话：类似线程，后续消息可继续路由进来 |

`"run"` 是最常见的模式，适合独立的分析或执行任务；`"session"` 适合需要多轮交互的 coding session（ACP Harness 默认用这个模式）。

---

## 19.3 架构文件组织

```
src/agents/
├── subagent-spawn.ts              # 派生入口（核心）
├── subagent-registry.ts           # 注册表（增删查）
├── subagent-registry.types.ts     # 注册表类型
├── subagent-registry.store.ts     # 持久化存储
├── subagent-registry-state.ts     # 运行状态管理
├── subagent-registry-runtime.ts   # 运行时操作（start/end）
├── subagent-registry-cleanup.ts   # 清理过期记录
├── subagent-registry-completion.ts # 完成处理
├── subagent-registry-queries.ts   # 查询接口
├── subagent-announce.ts           # 完成广播（核心）
├── subagent-announce-dispatch.ts  # 广播分发
├── subagent-announce-queue.ts     # 广播队列（幂等）
├── subagent-lifecycle-events.ts   # 生命周期事件定义
├── subagent-depth.ts              # 深度限制
└── subagent-attachments.ts        # 附件传递
```

---

## 19.4 派生（Spawn）

**文件：** `src/agents/subagent-spawn.ts`

### 两种模式

```typescript
const SUBAGENT_SPAWN_MODES = ["run", "session"] as const;
```

| 模式 | 语义 | 适用场景 |
|------|------|----------|
| `run` | 一次性任务：完成后 session 关闭 | 代码生成、文件分析、单次查询 |
| `session` | 持久 session：任务后保持活跃 | ACP harness、Discord 线程、持续对话 |

### SpawnSubagentParams 全解析

```typescript
type SpawnSubagentParams = {
  task: string;                    // 任务描述（子 Agent 的 system prompt 前缀）
  label?: string;                  // 可读标签（状态展示和日志用）
  agentId?: string;                // 指定 agent 身份（默认继承父 Agent）
  model?: string;                  // 指定模型（不指定则继承父 Agent）
  thinking?: string;               // 思考级别（high/medium/low）
  runTimeoutSeconds?: number;      // 超时（0 = 无限制）
  thread?: boolean;                // 是否绑定到当前 Discord/Slack 线程
  mode?: SpawnSubagentMode;        // run | session
  cleanup?: "delete" | "keep";    // 完成后是否删除 session 文件
  sandbox?: SpawnSubagentSandboxMode;   // inherit | require
  expectsCompletionMessage?: boolean;   // 子 Agent 是否会自己发完成消息
  attachments?: Array<{                 // 随任务传递的文件附件
    name: string;
    content: string;
    encoding?: "utf8" | "base64";
    mimeType?: string;
  }>;
  attachMountPath?: string;        // 附件在子 Agent workspace 的挂载路径
};
```

### 推送式完成（Push-based Completion）

这是 Sub-agent 系统最核心的设计原则。派生成功后，父 Agent 会收到一条系统注记：

```typescript
export const SUBAGENT_SPAWN_ACCEPTED_NOTE =
  "Auto-announce is push-based. After spawning children, do NOT call " +
  "sessions_list, sessions_history, exec sleep, or any polling tool. " +
  "Wait for completion events to arrive as user messages...";
```

**为什么不能轮询？**
1. 每次轮询消耗额外 token
2. 轮询期间占用 session lane，阻塞其他请求
3. `sleep` 在某些环境下行为不确定

子 Agent 完成时通过 announce 机制**主动推送**结果给父 Agent。父 Agent 只需等待，不需要主动查询。

---

## 19.5 注册表（Registry）

子 Agent 启动后立即注册到注册表中。注册表是持久化的 JSON 存储，每条记录是一个 `SubagentRunRecord`：

```typescript
type SubagentRunRecord = {
  // 基本标识
  runId: string;                    // 唯一运行 ID
  childSessionKey: string;          // 子 Agent 的 session key
  requesterSessionKey: string;      // 父 Agent 的 session key
  requesterOrigin?: DeliveryContext; // 父 Agent 的消息来源（渠道信息）
  task: string;                     // 任务描述
  label?: string;
  model?: string;
  workspaceDir?: string;
  cleanup: "delete" | "keep";
  spawnMode?: SpawnSubagentMode;

  // 时间戳
  createdAt: number;
  startedAt?: number;
  endedAt?: number;

  // 运行结果
  outcome?: SubagentRunOutcome;

  // Announce 重试状态
  announceRetryCount?: number;
  lastAnnounceRetryAt?: number;

  // 最终输出快照（核心字段）
  frozenResultText?: string | null;
  frozenResultCapturedAt?: number;
  fallbackFrozenResultText?: string | null;
  fallbackFrozenResultCapturedAt?: number;

  // 生命周期
  endedReason?: SubagentLifecycleEndedReason;
  wakeOnDescendantSettle?: boolean;  // 等子孙都完成后再广播

  // 附件
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
};
```

### frozenResultText 的设计目的

子 Agent 完成时，最终输出文本被立刻快照保存为 `frozenResultText`。

**为什么需要快照？** Announce 可能因为网络中断或父 Agent session 暂时不可用而失败，需要重试。但重试时子 Agent 的 session 可能已被清理（`cleanup: "delete"`）。有了 `frozenResultText`，重试时无需重新访问 session，直接重放快照即可。

`fallbackFrozenResultText` 是另一种场景：当子 Agent 进入 wake 继续（因依赖子孙任务完成而被唤醒），原始结果已经快照，但 wake 运行完成后回复了 `NO_REPLY`。此时 `fallbackFrozenResultText` 保存原始快照，确保父 Agent 仍然收到正确结果。

---

## 19.6 生命周期事件

```typescript
// 结束原因（发生了什么）
type SubagentLifecycleEndedReason =
  | "subagent-complete"   // 正常完成
  | "subagent-error"      // 执行出错
  | "subagent-killed"     // 被手动 kill
  | "session-reset"       // session 被重置
  | "session-delete";     // session 被删除

// 结束结果（最终状态）
type SubagentLifecycleEndedOutcome =
  | "ok"       // 成功
  | "error"    // 失败
  | "timeout"  // 超时
  | "killed"   // 被杀掉
  | "reset"    // session 重置
  | "deleted"; // session 删除
```

原因（reason）和结果（outcome）是不同层次的概念：同一个 reason 可以对应不同的 outcome，比如 `session-reset` 会产生 `reset` outcome，但 `subagent-killed` 产生 `killed` outcome。

---

## 19.7 完成广播（Announce）

**文件：** `src/agents/subagent-announce.ts`

### 广播流程

```
子 Agent 执行完毕
  → captureSubagentCompletionReply() 捕获最终输出文本
  → 写入 frozenResultText
  → runSubagentAnnounceFlow() 尝试发送给父 Agent
    → 成功：父 Agent session 收到完成消息，继续执行
    → 失败：加入 announce-queue，稍后重试
```

### runSubagentAnnounceFlow 参数

```typescript
{
  childSessionKey,
  childRunId,
  requesterSessionKey,
  requesterOrigin?,          // 父 Agent 在哪个渠道（确保回复到正确位置）
  task,
  timeoutMs,
  cleanup,
  roundOneReply?,            // 主要结果文本
  fallbackReply?,            // 备用文本（wake 继续场景）
  waitForCompletion?,        // 是否同步等待广播完成
  outcome?,
  announceType?,             // "subagent task" | "cron job"
  expectsCompletionMessage?, // 子 Agent 是否已自己发了完成消息
  spawnMode?,
  wakeOnDescendantSettle?,   // 是否等子孙完成后再广播
  signal?,                   // AbortSignal（超时控制）
  bestEffortDeliver?,        // 允许失败不报错
}
```

`requesterOrigin` 决定完成通知发到哪里。如果父 Agent 在 Discord 某个频道接收的任务，子 Agent 的完成通知也应该发到同一个频道，而不是发到父 Agent 默认的 session。

### 幂等广播

**文件：** `src/agents/subagent-announce-queue.ts`

同一条广播可能因重试被发送多次。幂等机制通过记录已广播的 `runId` 来确保父 Agent 只收到一次完成通知。

---

## 19.8 深度限制

**文件：** `src/agents/subagent-depth.ts`

每个 session 有一个 `spawnDepth` 字段，记录在派生链中的位置：

```
main session (depth=0)
  → subagent A (depth=1)
    → subagent B (depth=2)
      → subagent C (depth=3)  ← 超过 maxSpawnDepth → 拒绝
```

`getSubagentDepthFromSessionStore` 从 session store 读取深度，`buildSubagentSystemPrompt` 将 `childDepth` 和 `maxSpawnDepth` 注入到子 Agent 的 system prompt，让子 Agent 自己知道"还能再派生几层"。

---

## 19.9 附件传递

**文件：** `src/agents/subagent-attachments.ts`

父 Agent 可以随任务传递文件：

```typescript
attachments: [{
  name: "data.csv",
  content: "<base64 content>",
  encoding: "base64",
  mimeType: "text/csv"
}],
attachMountPath: "input/"  // 挂载到子 Agent workspace 的 input/ 目录
```

附件被复制到子 Agent 的工作目录，子 Agent 可以直接通过文件系统访问。`retainAttachmentsOnKeep` 决定 session 保留时是否一起保留附件。

---

## 19.10 父 Agent 管理子 Agent

父 Agent 通过 `subagents` 工具管理活跃的子 Agent：

```
subagents(action=list)
  → 列出当前 session 下所有活跃子 Agent
  → 展示 runId, label, status, task 摘要

subagents(action=steer, target="<runId>", message="...")
  → 向正在运行的子 Agent 注入新指令
  → 不中断当前执行，子 Agent 收到消息后自行调整

subagents(action=kill, target="<runId>")
  → 终止指定子 Agent
  → 触发 "subagent-killed" 生命周期事件
```

**`steer` 的设计**：不是重新启动，而是向运行中的子 Agent 发送一条新消息，让它调整方向。在子 Agent 执行时间很长（复杂代码任务）的场景下，这允许父 Agent 在中途修正目标，而不用浪费已经完成的工作。

---

## 19.11 ACP Harness 模式

`sessions_spawn` 支持 `runtime: "acp"`，用于启动 ACP（Agent Completion Protocol）harness 会话，对接 Claude Code、Codex 等外部 Coding Agent：

```typescript
// ACP 模式下的 thread-bound persistent session
sessions_spawn({
  task: "实现一个用户登录系统",
  runtime: "acp",
  agentId: "claude-code",  // ACP harness ID
  thread: true,            // 绑定到当前 Discord 线程
  mode: "session"          // 持久 session，任务完成后可继续交互
});
```

ACP session 和普通 subagent 共用同一个注册表和生命周期管理，但 system prompt 和路由逻辑有所不同（由 `acpEnabled` 参数控制）。

---

## 19.12 本章要点

- Sub-agent 核心是"推送式完成"——子 Agent 完成后主动广播，父 Agent 不轮询
- `frozenResultText` 快照机制确保 announce 可以可靠重试
- 深度限制防止无限递归派生
- `steer` 允许父 Agent 在不中断执行的情况下修正子 Agent 方向
- `cleanup: "keep"` 保留 session 文件，`"delete"` 完成后自动清理

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/agents/subagent-spawn.ts` | ★★★ | 派生入口 + 核心参数 |
| `src/agents/subagent-announce.ts` | ★★★ | 完成广播 + 重试机制 |
| `src/agents/subagent-registry.types.ts` | ★★★ | SubagentRunRecord 完整结构 |
| `src/agents/subagent-lifecycle-events.ts` | ★★ | 生命周期事件定义 |
| `src/agents/subagent-announce-queue.ts` | ★★ | 幂等广播队列 |
| `src/agents/subagent-depth.ts` | ★ | 深度限制 |
| `src/agents/subagent-attachments.ts` | ★ | 附件传递 |
