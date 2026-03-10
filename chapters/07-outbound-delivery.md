# 第 7 章 消息出境：Outbound Delivery 系统

## 7.1 入境与出境的对称性

第 6 章讲了消息如何进入系统、被处理、路由到 Agent。本章讲另一半：**Agent 的回复如何找到正确的目的地并可靠地送达**。

两者在职责上完全对称，但复杂度来自不同的地方：
- **入境**：信息提取、权限判断、路由匹配
- **出境**：目标解析、格式适配、可靠投递（失败重试、多 channel 路由）

---

## 7.2 出境系统全景

```
Agent 回复（ReplyPayload[]）
  ↓
ReplyPayload 规范化（normalize-reply）
  ↓
┌──────────────────────────────────────────────────────┐
│  SessionDeliveryTarget 解析                           │
│  决定：channel / to / accountId / threadId            │
└──────────────────────┬───────────────────────────────┘
                       │
         ┌─────────────▼──────────────┐
         │    直接投递路径             │  本进程内有对应 channel 插件
         │    executeOutboundSend()   │
         └─────────────┬──────────────┘
                       │ 失败 / cross-process
                       ▼
         ┌─────────────────────────────┐
         │    DeliveryQueue            │
         │    持久化 → 重试（最多 5 次）│
         └─────────────────────────────┘
                       │ 成功
                       ▼
         Channel Plugin（Discord / Telegram / ...）
                       │
                       ▼
         送达确认 / messageId
```

---

## 7.3 ReplyPayload：出境的数据单元

**文件：** `src/infra/outbound/payloads.ts`

所有出境消息最终都表达为 `ReplyPayload[]`——一个有序的消息块列表：

```typescript
// 来自 auto-reply/types.ts
type ReplyPayload =
  | { type: "text";    text: string }
  | { type: "media";   url: string; caption?: string; mime?: string }
  | { type: "file";    path: string; caption?: string }
  | { type: "action";  name: string; params: Record<string, unknown> }
  | ...;
```

`normalizeOutboundPayloads` 负责：
- 合并连续 text 块（减少 API 调用）
- 处理 plugin hook（`beforeSend` 等）让 channel 插件有机会改写内容
- 校验媒体 URL / 路径合法性

---

## 7.4 SessionDeliveryTarget：目标解析

**文件：** `src/infra/outbound/targets.ts`

"把回复发给谁"看似简单，实际上有多种来源需要合并：

```typescript
type SessionDeliveryTarget = {
  channel?: DeliverableMessageChannel; // "telegram" | "discord" | ...
  to?: string;              // 接收方（userId、chatId、channelId）
  accountId?: string;       // 多账号时指定哪个 bot
  threadId?: string | number; // 帖子/话题 ID
  threadIdExplicit?: boolean; // threadId 是显式指定还是从历史推断
  mode: ChannelOutboundTargetMode; // 投递模式
  // "last" fallback 字段
  lastChannel?: DeliverableMessageChannel;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};
```

`resolveSessionDeliveryTarget` 的解析优先级：

```
1. 显式传入的 channel / to / threadId（工具调用时直接指定）
2. session 文件记录的最后一次入境来源（lastChannel / lastTo）
3. 配置的默认 heartbeat 目标
4. 全局 fallback channel
```

**跨 channel 的 reply-to-turn-source 锁定：**

当多个 channel 共享同一 session（`dmScope: "main"`），且一条来自 Telegram 的消息触发了 Agent turn，此时 Discord 来了另一条消息更新了 `lastChannel`——如果不加保护，回复会路由到 Discord 而不是 Telegram。

系统通过在 turn 开始时快照 `turnSourceChannel` 并锁定，确保 turn 内的所有回复都路由回发起来源。

---

## 7.5 DeliveryQueue：可靠投递

**文件：** `src/infra/outbound/delivery-queue.ts`

网络抖动、channel 服务中断——任何出境请求都可能失败。`DeliveryQueue` 提供持久化的重试保障：

```typescript
interface QueuedDelivery {
  id: string;
  enqueuedAt: number;
  retryCount: number;        // 已重试次数
  lastAttemptAt?: number;
  lastError?: string;

  // 投递目标
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  payloads: ReplyPayload[];  // 存原始 payloads，重试时重新跑 plugin hooks
  threadId?: string | number | null;
  replyToId?: string | null;
  bestEffort?: boolean;
  silent?: boolean;
  mirror?: DeliveryMirrorPayload; // 镜像投递（同时发给另一个目标）
}

const MAX_RETRIES = 5;
```

**重试存原始 payloads 而非规范化后的结果**：因为 plugin hooks 是无状态变换（幂等），重放时重新跑能确保 hook 的副作用（如格式转换、媒体上传）按当时环境重新执行，而不是缓存旧结果。

**Recovery 机制：**

Gateway 重启时，`DeliveryQueue` 扫描磁盘上未完成的投递记录：

```typescript
type RecoverySummary = {
  recovered: number;          // 成功恢复并重新投递
  failed: number;             // 已超最大重试次数，放弃
  skippedMaxRetries: number;  // 重试次数用完的
  deferredBackoff: number;    // 延迟处理的（退避中）
};
```

---

## 7.6 Channel 路由与插件适配

**文件：** `src/infra/outbound/channel-resolution.ts`

出境路由通过两条路：

```typescript
// 路径一：直接调用
resolveOutboundChannelPlugin({ channel, cfg })
  → ChannelPlugin | undefined

// 路径二：通过 Gateway 发送（跨进程/跨节点）
executeSendAction({ ctx, to, message, ... })
  → { handledBy: "plugin" | "core" }
```

`handledBy: "plugin"` 意味着找到了对应的 channel 插件（Telegram、Discord 等）并直接调用。

`handledBy: "core"` 则走 Gateway HTTP API 中转。

**多账号投递：**

```typescript
type OutboundSendContext = {
  channel: ChannelId;
  accountId?: string | null; // 指定使用哪个 bot 账号
  ...
};
```

同一 channel 可配置多个 bot 账号（多个 Telegram bot、多个 Discord bot）。`accountId` 为空时使用 channel 配置中的 default 账号。

---

## 7.7 DeliveryMirror：镜像投递

某些场景需要将同一条回复同时投递给多个目标——例如，记录 Agent 的所有回复到一个监控 session，或向用户发送消息的同时向管理员 channel 同步副本：

```typescript
type DeliveryMirrorPayload = {
  sessionKey: string; // 镜像目标的 session
  agentId?: string;
  text?: string;       // 可以是裁剪后的摘要文本
  mediaUrls?: string[];
};
```

Mirror 与主投递同时进行，mirror 失败不影响主投递。

---

## 7.8 Session Binding Service

**文件：** `src/infra/outbound/session-binding-service.ts`（约 89 行）

`SessionBindingService` 维护 **session ↔ 频道对话** 的持久化绑定表。它是 ACP Persistent Bindings（第 20 章）和 thread binding 功能的底层存储：

```typescript
type SessionBindingRecord = {
  sessionKey: string;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  bindingSpec?: Record<string, unknown>; // 扩展数据（如 ACP 配置）
  createdAt: number;
  updatedAt: number;
};
```

绑定一旦创建，消息流水线在路由时会优先查询绑定表——如果一条 Discord 消息来自某个绑定了 ACP session 的 thread，它会跳过普通路由直接送往那个 session。

---

## 7.9 MessageAction 系统

**文件：** `src/infra/outbound/message-action-runner.ts`

"发消息"只是出境的一种形式。Agent 通过 `message` 工具发起的各类**消息动作**（react、edit、pin、poll、thread-create 等）走另一条路：

```typescript
type MessageActionSpec = {
  action: string;   // "react" | "edit" | "delete" | "pin" | "poll" | ...
  params: Record<string, unknown>;
};
```

`executeMessageAction` 将 action 分发到对应 channel 插件的 action handler，由插件负责将抽象 action 翻译为具体 API 调用（Discord slash reaction、Telegram editMessageText 等）。

---

## 7.10 出境链路全景

```
Agent 产出回复
  ↓
normalize-reply（合并 text 块、运行 beforeSend hook）
  ↓
resolveSessionDeliveryTarget（解析 channel / to / threadId）
  ↓
    ┌──────── 有对应 channel 插件？ ────────┐
   YES                                    NO
    ↓                                     ↓
plugin.send()                     gateway HTTP API
    ↓                                     ↓
  成功？                              成功？
  YES → done                          YES → done
  NO ↓                                NO ↓
DeliveryQueue.enqueue()           DeliveryQueue.enqueue()
    ↓ 
指数退避重试（最多 5 次）
    ↓
最终失败 → 记录错误日志 + bestEffort 跳过
```

---

## 7.11 本章要点

| 问题 | 解决方案 |
|------|---------|
| 发往哪里？ | SessionDeliveryTarget 多来源优先级合并 |
| 用哪个 bot？ | accountId + channel 插件多账号支持 |
| 失败怎么办？ | DeliveryQueue 持久化重试（最多 5 次）|
| 重启丢消息？ | 队列磁盘持久化 + Recovery |
| turn 中途切 channel？ | turnSourceChannel 锁定，回到来源 |
| 发给多目标？ | DeliveryMirror |

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/infra/outbound/targets.ts` | ★★★ | SessionDeliveryTarget 解析逻辑 |
| `src/infra/outbound/delivery-queue.ts` | ★★★ | 持久化重试队列 |
| `src/infra/outbound/outbound-send-service.ts` | ★★ | 发送服务主入口 |
| `src/infra/outbound/payloads.ts` | ★★ | ReplyPayload 规范化 |
| `src/infra/outbound/session-binding-service.ts` | ★★ | session 绑定存储 |
| `src/infra/outbound/message-action-runner.ts` | ★ | 消息动作（react/edit/pin）|
| `src/infra/outbound/channel-resolution.ts` | ★ | channel 插件路由 |
