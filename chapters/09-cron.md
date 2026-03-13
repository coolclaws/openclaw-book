# 第 9 章 Cron 调度引擎

## 9.1 为什么需要独立的 Cron 引擎

OpenClaw 的 Cron 引擎不只是"定时发消息"——它是一个完整的**定时任务调度系统**，可以：
- 在指定时间运行独立的 Agent turn（有自己的模型、context 和工具）
- 向特定频道主动投递结果
- 触发心跳检查、定期巡查等后台任务
- 在 Gateway 重启后自动恢复所有定时任务

第 5 章提到 Gateway 内嵌 Cron 服务，本章深入其实现机制。

---

## 9.2 调度类型

**文件：** `src/cron/types.ts`

```typescript
type CronSchedule =
  | { kind: "at"; at: string }           // 一次性：ISO-8601 时间戳
  | { kind: "every"; everyMs: number; anchorMs?: number }  // 固定间隔（毫秒）
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }; // Cron 表达式
```

| 类型 | 用途示例 | 特点 |
|------|---------|------|
| `at` | "20 分钟后提醒我开会" | 一次性，到时自动删除 |
| `every` | "每 30 分钟检查一次邮件" | 间隔稳定，anchorMs 控制首次触发时间 |
| `cron` | "每周一早 9 点发日报" | 标准 cron 表达式，支持时区 |

### staggerMs：防调度风暴

多个 cron job 同时设置了相同的表达式（例如 `0 * * * *`，整点触发），它们会在同一秒内同时触发，形成"调度风暴"——大量 Agent turn 并发启动。

`staggerMs` 在调度时间点引入一个随机偏移（0 到 staggerMs 毫秒之间），将并发峰值打散：

```typescript
{ kind: "cron", expr: "0 * * * *", staggerMs: 60_000 }
// 每小时触发一次，但具体时间在 :00 到 :01 之间随机
```

---

## 9.3 Session Target：主会话 vs 独立 Agent

**文件：** `src/cron/types.ts`

```typescript
type CronSessionTarget = "main" | "isolated";
```

这是 Cron 最核心的设计决策，决定了任务在哪里运行：

```
┌─────────────────────────────────────────────────────┐
│ main                                                 │
│  → 向主会话注入 systemEvent（文本事件）               │
│  → 主会话的 Agent 看到这个事件并响应                  │
│  → 共享主会话的 context 历史                          │
│  → payload.kind 必须是 "systemEvent"                 │
└─────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────┐
│ isolated                                             │
│  → 启动一个全新的独立 Agent 会话                      │
│  → 使用 agentTurn payload，有独立 context            │
│  → 可以指定不同的模型和 thinking 级别                 │
│  → 任务完成后自动清理（session reaper）               │
│  → payload.kind 必须是 "agentTurn"                   │
└─────────────────────────────────────────────────────┘
```

`isolated` 是推荐用法——独立任务不污染主会话历史，失败也不影响主会话。`main` 适合需要"提醒主 Agent"的场景（例如"会议还有 5 分钟"）。

---

## 9.4 Payload 类型

```typescript
type CronPayload =
  | {
      kind: "systemEvent";
      text: string;           // 注入主会话的事件文本
    }
  | {
      kind: "agentTurn";
      message: string;        // 发给独立 Agent 的任务描述
      model?: string;         // 可以用不同的模型
      thinking?: string;      // 思考级别
      timeoutSeconds?: number; // 0 = 不超时
    };
```

---

## 9.5 isolated agentTurn 的执行机制

这是本章最核心的部分。当一个 `sessionTarget: "isolated"` 的 cron job 触发，实际发生的是什么？

### 9.5.1 触发入口：runIsolatedAgentJob

Cron service 的运行时依赖结构如下：

```typescript
type CronServiceDeps = {
  // ...调度、持久化等依赖...

  runIsolatedAgentJob: (params: {
    job: CronJob;
    message: string;
    abortSignal?: AbortSignal;
  }) => Promise<{
    summary?: string;
    outputText?: string;   // Agent 最后的完整文本输出
    delivered?: boolean;   // 是否由 Agent 自己完成了投递（用了 message 工具）
    deliveryAttempted?: boolean;
  } & CronRunOutcome & CronRunTelemetry>;
};
```

`runIsolatedAgentJob` 是**依赖注入**进来的——cron service 本身不知道如何运行 Agent，只负责调度和状态管理。Gateway 启动时将具体的 Agent 运行能力注入进来。这样 cron service 对 Pi 引擎没有直接依赖，可以独立测试。

### 9.5.2 从触发到 Agent 运行的完整链路

```
调度器触发（timer 到期）
  ↓
isJobDue(job, nowMs)  ← 确认 job 确实到期（防并发重复触发）
  ↓
locked(state, fn)     ← 串行锁，同一 job 不并发执行
  ↓
resolveCronJobTimeoutMs(job)   ← 计算超时上限
  ↓
runIsolatedAgentJob({
  job,
  message: job.payload.message,   ← 取 payload 中的任务描述
  abortSignal,                    ← 绑定超时的 AbortSignal
})
  ↓
内部调用 commands/agent 框架：
  resolveSession(opts)            ← 创建/定位 session
  runEmbeddedPiAgent(params)      ← 运行完整 Pi Agent
  updateSessionStoreAfterAgentRun ← 更新 session 状态
  deliverAgentCommandResult       ← 投递结果
  ↓
记录 CronRunOutcome + CronRunTelemetry
  ↓
触发 CronEvent("finished", ...)
```

### 9.5.3 超时策略

**文件：** `src/cron/service/timeout-policy.ts`

```typescript
// 普通 cron job 的安全上限（防止卡死）
const DEFAULT_JOB_TIMEOUT_MS: number;

// Agent turn 使用更大的安全上限
// 因为 Agent 可能需要多次工具调用、LLM 推理
const AGENT_TURN_SAFETY_TIMEOUT_MS: number;  // 远大于 DEFAULT_JOB_TIMEOUT_MS

function resolveCronJobTimeoutMs(job: CronJob): number | undefined {
  if (payload.kind === "agentTurn" && payload.timeoutSeconds === 0) {
    return undefined; // 0 = 不超时（用户显式选择）
  }
  if (payload.timeoutSeconds) {
    return payload.timeoutSeconds * 1000;
  }
  // agentTurn 默认用更大的安全上限
  return isAgentTurn ? AGENT_TURN_SAFETY_TIMEOUT_MS : DEFAULT_JOB_TIMEOUT_MS;
}
```

超时通过 `AbortSignal` 传递给 Agent 运行。Agent 在每次工具调用前检查 signal，超时后优雅退出而非强杀。

### 9.5.4 Session：全新的、隔离的

`resolveSession` 为 cron job 建立 session：

```typescript
resolveSession({
  cfg,
  agentId: job.agentId ?? defaultAgentId,
  sessionKey: job.sessionKey,  // job 可以指定固定 sessionKey（便于跨次续接）
})
```

**session key 来源：**

| job.sessionKey | 行为 |
|----------------|------|
| 未设置（默认）| 每次触发创建新 session，完全隔离 |
| 明确设置 | 复用同一 session，历史在每次触发间积累 |

**为什么推荐不设置 sessionKey（即每次全新）？**

- 避免 context 历史随时间累积，最终超出 token 限制
- 每次任务从"干净状态"开始，不受上次运行失败或异常状态影响
- Session Reaper 可以在任务完成后清理这个 session，不留垃圾

**隔离的含义：** 这个 session 与主 session（`main`）完全不共享历史。从 LLM 视角看，这是一个全新的对话，没有任何之前的上下文包袱。

### 9.5.5 模型：继承、覆盖、回退

**文件：** `src/agents/model-selection.ts`

```typescript
// payload 中的 model 字段
normalizeModelSelection(job.payload.model)
// → undefined / "claude-sonnet-4-6" / "openrouter/google/gemini-2.5-pro" / ...
```

模型选择的优先级链：

```
payload.model（cron job 级别指定）
  ↓ 未指定
agent config 中的 model（该 agentId 的默认模型）
  ↓ 未指定
agents.defaults.model（全局默认）
  ↓ 未指定
config 顶层 model
```

这让不同的 cron job 可以使用不同的模型：

```json
{
  "payload": {
    "kind": "agentTurn",
    "message": "分析今天的日志并总结异常模式",
    "model": "openrouter/deepseek/deepseek-r1-0528",  // 用推理模型做分析
    "thinking": "high"
  }
}
```

而日常的邮件检查任务可以用廉价的快速模型：

```json
{
  "payload": {
    "kind": "agentTurn",
    "message": "检查未读邮件，有重要邮件则发通知",
    "model": "openrouter/google/gemini-2.5-pro"
  }
}
```

**thinking 级别** 同样可以在 payload 中指定，让计算密集型任务使用更深的推理链，常规任务保持轻量。

### 9.5.6 Context：System Prompt + 空历史

Agent turn 执行时，Pi 引擎构建如下 context：

```
┌─────────────────────────────────────────────────────┐
│ System Prompt                                        │
│  （完整构建，与常规 turn 无差异）                     │
│  包含：SOUL.md / USER.md / AGENTS.md / 工具声明 /    │
│        memory inject / skills / runtime 信息          │
├─────────────────────────────────────────────────────┘
│ 历史消息                                             │
│  （空，或 job.sessionKey 指定了固定 session 时有历史）│
├─────────────────────────────────────────────────────┘
│ 用户消息                                             │
│  payload.message                                     │
│  例如："检查今天的日历，有 2 小时内的会议则发提醒"     │
└─────────────────────────────────────────────────────┘
```

**System Prompt 是完整的**——这意味着：
- Agent 知道自己是谁（SOUL.md）
- Agent 知道用户是谁（USER.md）
- 如果 memory 系统有相关内容，会被注入（memory_search 的自动注入部分）
- 所有声明了的工具都可用

**空历史的含义：** Agent 没有"上次我们聊了什么"的记忆，但有"我是谁、我的用户是谁"的身份认知，以及通过 `memory_search` 工具访问长期记忆的能力。

### 9.5.7 工具：与常规 turn 完全相同

这是最关键的设计选择：**cron isolated turn 使用与普通对话完全相同的工具集**。

```
工具集 = 该 agentId 的 agent config 中配置的所有工具
       + 工具策略管道（policy pipeline）过滤
       - senderIsOwner 影响的高权限工具
```

`AgentCommandOpts` 中的 `senderIsOwner` 字段：

```typescript
senderIsOwner: true  // cron 任务默认以 owner 身份运行
```

这意味着 cron Agent 拥有 **owner 级别的完整工具权限**，包括：
- `exec` / `bash`（执行 shell 命令）
- `memory_search` / `memory_get`（读取记忆）
- `message`（向任意频道发消息）
- `browser`（控制浏览器）
- `cron`（可以创建新的 cron job！）
- `sessions_spawn`（可以创建 sub-agent）

一个每天早上 8 点运行的"日报"任务，其实可以做到：

```
1. memory_search("今天的待办") → 读取记忆
2. exec("git log --since=yesterday") → 查看昨天的提交
3. web_fetch("https://...") → 抓取相关页面
4. message(to=用户, channel=telegram) → 发送日报
5. memory_get + edit MEMORY.md → 更新长期记忆
```

### 9.5.8 结果收集与投递判断

Agent run 完成后，`runIsolatedAgentJob` 收集结果：

```typescript
type IsolatedJobResult = {
  summary?: string;       // Agent 最后输出的摘要文本（用于 announce 模式）
  outputText?: string;    // 最后一段完整文本（未截断，用于调试）
  delivered?: boolean;    // Agent 自己调用了 message 工具发送了结果？
  deliveryAttempted?: boolean; // 是否尝试过投递
} & CronRunOutcome & CronRunTelemetry;
```

**`delivered` 的语义（关键设计）：**

```
delivered = true：
  Agent 在 turn 过程中主动用 message 工具发了消息
  → cron service 跳过自动投递，避免重复发送

delivered = false：
  Agent 没有用 message 工具
  → 根据 job.delivery 配置决定是否自动投递 outputText
```

这个设计让有主动投递能力的 Agent 和纯计算型 Agent 都能正确工作——前者自己发消息，后者由 cron 框架统一投递。

**遥测记录：**

```typescript
CronRunTelemetry = {
  model: string;     // 实际使用的模型
  provider: string;  // 实际使用的 provider
  usage: {
    input_tokens, output_tokens, total_tokens,
    cache_read_tokens, cache_write_tokens
  }
}
```

每次运行的 token 消耗都被记录，可通过 `cron runs` 命令查看历史。

### 9.5.9 一个完整示例的执行轨迹

```
每天 9:00 触发 job "daily-summary":
  payload:
    message: "读取 MEMORY.md，总结最近一周的项目进展，以 Markdown 格式发到 #daily 频道"
    model: "anthropic/claude-sonnet-4-6"
    timeoutSeconds: 120

执行：
  1. resolveSession → 创建新 session "cron-daily-summary-xxxx"
  2. 构建 system prompt（含 SOUL.md / USER.md / runtime 信息）
  3. 发送 payload.message 给 Pi 引擎
  4. Pi 引擎开始 tool loop：
       → memory_get("MEMORY.md") → 读取长期记忆
       → sessions_list(activeMinutes=10080) → 看看过去一周有哪些会话
       → [思考：整理内容]
       → message(channel="discord", target="#daily", message="## 本周进展\n...")
  5. Agent 用 message 工具发了消息 → delivered = true
  6. CronRunOutcome = { status: "ok", summary: "已发送周报" }
  7. job.delivery 配置了 announce，但 delivered=true → 跳过重复投递
  8. 更新 session store，记录遥测
  9. session reaper 后续清理 "cron-daily-summary-xxxx"
```

---

## 9.5.10 隔离投递收紧（Breaking Change）

> **📦 v2026.3.11 新增**

自 v2026.3.11 起，cron job 的隔离投递策略发生了**破坏性变更**：`isolated` 模式下的 cron job **不再允许**通过临时 agent send 或 fallback main-session 汇总投递结果。此前书中描述的 `notify` fallback 路径已失效。

**影响范围：**
- 如果你的 cron job 依赖 fallback 到 main session 来汇总投递，需要改为显式配置 `delivery.mode: "announce"` 或在 Agent prompt 中使用 `message` 工具主动发送。
- 旧版存储格式需要迁移，运行 `openclaw doctor --fix` 会自动完成格式升级。

**迁移命令：**

```bash
openclaw doctor --fix
# 自动检测并迁移旧版 cron 存储格式
```

---

## 9.5.11 隔离直投不再进入重发队列

> **📦 v2026.3.12 新增**

v2026.3.12 修复了隔离直投（isolated direct send）的一个重要问题：此前隔离直投会被写入 write-ahead 重发队列，导致 Gateway 重启后重复发送已投递的结果。

修复后，隔离直投完成即标记为已投递，不再进入 write-ahead 重发队列，从根本上消除了重启后重复发送的风险。

---

## 9.6 投递模式

**文件：** `src/cron/delivery.ts`

任务完成后，结果如何送达用户？

```typescript
type CronDelivery = {
  mode: "none" | "announce" | "webhook";
  channel?: CronMessageChannel;   // "telegram" | "discord" | "last" | ...
  to?: string;                    // 目标用户/频道
  accountId?: string;
  bestEffort?: boolean;
  failureDestination?: CronFailureDestination; // 失败时单独通知哪里
};
```

| 模式 | 说明 |
|------|------|
| `none` | 只运行，不主动投递（心跳任务常用）|
| `announce` | 将任务结果/摘要发送到指定 channel |
| `webhook` | 将完成事件以 HTTP POST 发送到指定 URL |

**failureDestination** 允许成功通知去用户的 Telegram，而失败告警去管理员的 Discord——一个任务两个目的地。

---

## 9.7 运行时遥测

**文件：** `src/cron/types.ts`

每次 job 运行都记录完整的遥测数据：

```typescript
type CronRunOutcome = {
  status: "ok" | "error" | "skipped";
  error?: string;
  errorKind?: "delivery-target"; // 区分执行错误 vs 投递错误
  summary?: string;              // 结果摘要（announce 模式用）
  sessionKey?: string;           // 使用了哪个 session
  sessionId?: string;
};

type CronRunTelemetry = {
  model?: string;
  provider?: string;
  usage?: CronUsageSummary;      // token 用量
};
```

`errorKind: "delivery-target"` 区分了任务本身执行成功但投递失败的场景——后者不应触发 alert，只需要重试投递。

---

## 9.8 持久化与恢复

**文件：** `src/cron/store.ts`, `src/cron/service/state.ts`

所有 cron job 持久化到磁盘（JSON 文件），Gateway 重启后自动恢复：

```
Gateway 启动
  → loadCronStore()：读取磁盘上的 job 列表
  → 遍历每个 job：
      → 计算下次触发时间（考虑重启期间跳过的次数）
      → 注册到调度器
  → 调度器开始运行
```

**跳过逻辑：** `at` 类型任务如果在 Gateway 停机期间"过了时间"，重启后直接删除（不补发）。`every` 和 `cron` 类型任务跳过错过的触发点，从下个周期继续。

---

## 9.9 Session Reaper

**文件：** `src/cron/session-reaper.ts`

`isolated` 模式的 cron 任务会创建新 session，任务完成后这些 session 不会立即消失——如果累积太多会占用磁盘。Session Reaper 是一个内置 cron job（Gateway 自动注册），定期清理已完成的孤立 session。

同样负责清理过期的 ACP session（第 20 章）——idle 太久且未绑定活跃频道的 ACP session 会被自动关闭和清理。

---

## 9.10 初始投递（Initial Delivery）

**文件：** `src/cron/service/initial-delivery.ts`

当一个新 job 被创建时，是否立刻触发一次？

- `at` 类型：只在指定时间触发，不提前
- `every` 类型：`anchorMs` 为 0 或未设置时，创建即立刻触发一次
- `cron` 类型：等待下一个 cron 触发点

用户创建 `every: 3600000`（每小时一次）的邮件检查任务时，通常希望立刻就检查一次，而不是等整整一小时——`anchorMs: 0` 满足这个需求。

---

## 9.11 与心跳系统的关系

第 5 章提到的心跳系统（heartbeat）和 Cron 有相似的外表，但本质不同：

| | 心跳 | Cron |
|--|--|--|
| 触发机制 | Gateway 内部定时 poll | 独立调度引擎 |
| 执行环境 | 主会话（main session）| main 或 isolated |
| 持久化 | 不持久化 | 磁盘持久化 |
| 重启恢复 | 重启后重置 | 重启后自动恢复 |
| 适合任务 | 批量周期检查（邮件+日历+天气）| 精确定时、独立任务 |

心跳是低开销的"检查一下有没有事"；Cron 是"在精确时间做某件独立的事"。

---

## 9.12 本章要点

Cron 引擎的三个核心设计原则：

1. **持久化优先**：所有 job 磁盘持久化，Gateway 重启不丢任务
2. **隔离执行**：`isolated` 模式不污染主会话，推荐默认
3. **灵活投递**：announce / webhook 两种送达方式 + 独立 failureDestination

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/cron/types.ts` | ★★★ | 全部核心类型（调度、payload、投递、遥测）|
| `src/cron/service/state.ts` | ★★★ | CronServiceDeps 定义（含 runIsolatedAgentJob 签名）|
| `src/cron/service.ts` | ★★★ | Cron 服务主入口 |
| `src/cron/service/timeout-policy.ts` | ★★ | 超时策略：DEFAULT vs AGENT_TURN_SAFETY |
| `src/cron/service/jobs.ts` | ★★ | job CRUD + isJobDue + 锁 |
| `src/commands/agent/types.ts` | ★★ | AgentCommandOpts（isolated run 的参数结构）|
| `src/commands/agent/delivery.ts` | ★★ | deliverAgentCommandResult（结果投递）|
| `src/cron/delivery.ts` | ★★ | 投递实现 |
| `src/agents/model-selection.ts` | ★ | normalizeModelSelection（模型参数规范化）|
| `src/cron/store.ts` | ★ | 磁盘持久化 |
| `src/cron/session-reaper.ts` | ★ | session 清理 |
| `src/cron/stagger.ts` | ★ | 防调度风暴算法 |
