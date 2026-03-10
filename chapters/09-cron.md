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

## 9.5 投递模式

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

## 9.6 运行时遥测

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

## 9.7 持久化与恢复

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

## 9.8 Session Reaper

**文件：** `src/cron/session-reaper.ts`

`isolated` 模式的 cron 任务会创建新 session，任务完成后这些 session 不会立即消失——如果累积太多会占用磁盘。Session Reaper 是一个内置 cron job（Gateway 自动注册），定期清理已完成的孤立 session。

同样负责清理过期的 ACP session（第 20 章）——idle 太久且未绑定活跃频道的 ACP session 会被自动关闭和清理。

---

## 9.9 初始投递（Initial Delivery）

**文件：** `src/cron/service/initial-delivery.ts`

当一个新 job 被创建时，是否立刻触发一次？

- `at` 类型：只在指定时间触发，不提前
- `every` 类型：`anchorMs` 为 0 或未设置时，创建即立刻触发一次
- `cron` 类型：等待下一个 cron 触发点

用户创建 `every: 3600000`（每小时一次）的邮件检查任务时，通常希望立刻就检查一次，而不是等整整一小时——`anchorMs: 0` 满足这个需求。

---

## 9.10 与心跳系统的关系

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

## 9.11 本章要点

Cron 引擎的三个核心设计原则：

1. **持久化优先**：所有 job 磁盘持久化，Gateway 重启不丢任务
2. **隔离执行**：`isolated` 模式不污染主会话，推荐默认
3. **灵活投递**：announce / webhook 两种送达方式 + 独立 failureDestination

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/cron/types.ts` | ★★★ | 全部核心类型（调度、payload、投递、遥测）|
| `src/cron/service.ts` | ★★★ | Cron 服务主入口 |
| `src/cron/service/state.ts` | ★★ | 调度状态管理 |
| `src/cron/service/jobs.ts` | ★★ | job CRUD 操作 |
| `src/cron/delivery.ts` | ★★ | 投递实现 |
| `src/cron/store.ts` | ★ | 磁盘持久化 |
| `src/cron/session-reaper.ts` | ★ | session 清理 |
| `src/cron/stagger.ts` | ★ | 防调度风暴算法 |
