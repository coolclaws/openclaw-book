# 第 10 章 Plugin SDK 与渠道抽象

## 10.1 为什么需要 Plugin SDK

OpenClaw 支持十几种消息渠道，每种有不同的 API、消息格式和能力特性。Plugin SDK 定义了一套统一的接口（Adapters），实现了**渠道代码与核心逻辑的解耦**。没有 SDK 的话，添加一个新渠道就需要修改核心代码的十几处；有了 SDK，只需要实现几个接口。

## 10.2 Adapter 接口体系

`plugin-sdk/core.ts` 导出了 15+ 种 Adapter 接口，每种对应渠道能力的一个维度。渠道插件只需实现需要的接口——这是**接口隔离原则**的典型应用。

### 必须实现的接口

**`ChannelSetupAdapter`**：渠道初始化和销毁
```typescript
interface ChannelSetupAdapter {
  setup(input: ChannelSetupInput): Promise<void>;  // 建立连接
  teardown?(): Promise<void>;                       // 断开并清理
}
```

**`ChannelMessagingAdapter`**：消息发送（这是渠道存在的根本理由）
```typescript
interface ChannelMessagingAdapter {
  sendMessage(context: ChannelOutboundContext): Promise<ChannelSendResult>;
}
```

### 可选接口及其设计意图

| Adapter | 解决什么问题 | 典型实现 |
|---------|------------|---------|
| `ChannelAuthAdapter` | 登录/登出/QR 码配对 | WhatsApp（QR 码）、Telegram（bot token） |
| `ChannelGroupAdapter` | 群组管理 | Discord（guild/channel）、Slack（workspace） |
| `ChannelPairingAdapter` | DM 身份验证 | 所有渠道（配对码验证未知用户） |
| `ChannelStatusAdapter` | 健康检查 | 所有渠道（连接状态、版本信息） |
| `ChannelStreamingAdapter` | 流式回复 | Telegram（编辑消息）、Discord（编辑消息） |
| `ChannelThreadingAdapter` | 消息线程 | Slack（threads）、Discord（threads） |
| `ChannelMentionAdapter` | @mention 解析 | Discord、Slack、Telegram |
| `ChannelSecurityAdapter` | 安全策略 | 所有渠道（DM policy 配置） |
| `ChannelHeartbeatAdapter` | 心跳检测 | WhatsApp（长连接保活） |
| `ChannelResolverAdapter` | ID/名称解析 | 所有渠道（用户 ID → 显示名称） |
| `ChannelDirectoryAdapter` | 联系人目录 | Slack（用户列表）、Discord（成员列表） |
| `ChannelMessageActionAdapter` | 消息操作 | Discord（react）、Slack（emoji react）、Telegram（react） |
| `ChannelCommandAdapter` | 原生命令 | Discord（slash commands）、Telegram（bot commands） |
| `ChannelOutboundAdapter` | 外发定制 | 渠道特定的消息格式转换 |
| `ChannelConfigAdapter` | 配置适配 | 渠道特定的配置字段处理 |

### 能力声明

每个渠道通过 `ChannelCapabilities` 声明自己支持什么：

```typescript
interface ChannelCapabilities {
  supportsMedia: boolean;        // 是否支持图片/视频
  supportsThreads: boolean;      // 是否支持消息线程
  supportsReactions: boolean;    // 是否支持表情反应
  supportsEditing: boolean;      // 是否支持编辑已发消息
  supportsStreaming: boolean;    // 是否支持流式输出
  maxMessageLength: number;      // 最大消息长度
  supportsInlineButtons: boolean; // 是否支持行内按钮
  // ...
}
```

核心系统根据能力声明做出正确的行为决策。例如：如果渠道不支持 `supportsEditing`，流式回复会作为多条消息发送，而不是编辑同一条消息。

## 10.3 入站消息统一模型

所有渠道的入站消息都被转换为统一的 `InboundEnvelope`（`plugin-sdk/inbound-envelope.ts`）。这是消息流水线的"通用货币"——downstream 的所有逻辑都只和 Envelope 打交道，不关心消息来自哪个渠道。

转换职责在各渠道的 handler 中：
- Telegram handler 将 `grammY.Message` → `InboundEnvelope`
- Discord handler 将 `discord.js.Message` → `InboundEnvelope`
- WhatsApp handler 将 `Baileys.WAMessage` → `InboundEnvelope`

## 10.4 出站消息路由

出站消息通过 `ChannelOutboundContext` 传递给渠道：

```typescript
interface ChannelOutboundContext {
  text: string;                  // 回复文本
  media?: MediaAttachment[];     // 媒体附件
  replyTo?: string;              // 回复目标消息 ID
  threadId?: string;             // 线程 ID
  buttons?: InlineButton[][];    // 行内按钮
  channel: string;               // 渠道标识
  target: string;                // 目标用户/群组
}
```

`ChannelSendResult` 返回发送结果，包含平台分配的消息 ID（用于后续编辑或回复引用）。

## 10.5 SDK 辅助工具

Plugin SDK 提供一系列辅助工具，简化插件开发：

**文本处理**：
- `text-chunking.ts`：按渠道限制分块文本，尊重代码块和段落边界
- `outbound-media.ts`：媒体附件格式处理

**安全**：
- `allow-from.ts`：白名单匹配（支持通配符、正则、精确匹配）
- `group-access.ts`：群组访问控制
- `pairing-access.ts`：DM 配对验证
- `ssrf-policy.ts`：SSRF 防护（插件中的 HTTP 请求安全）

**数据管理**：
- `json-store.ts`：JSON 文件存储（插件数据持久化）
- `persistent-dedupe.ts`：持久化去重（避免重复处理）
- `keyed-async-queue.ts`：带 key 的异步队列（按用户/群组排队）
- `runtime-store.ts`：运行时状态存储

**Webhook**：
- `webhook-path.ts`：Webhook 路径生成
- `webhook-request-guards.ts`：Webhook 请求验证
- `webhook-targets.ts`：Webhook 目标管理

## 10.6 Plugin SDK 的 npm 发布结构

Plugin SDK 通过多个 export path 发布：

```typescript
import { ... } from 'openclaw/plugin-sdk'           // 主入口
import { ... } from 'openclaw/plugin-sdk/core'       // 核心类型
import { ... } from 'openclaw/plugin-sdk/telegram'   // Telegram 特定工具
import { ... } from 'openclaw/plugin-sdk/discord'    // Discord 特定工具
import { ... } from 'openclaw/plugin-sdk/slack'      // Slack 特定工具
```

每个渠道特定的子路径提供该渠道独有的工具（如 `discord-send.ts` 提供 Discord 消息发送的辅助函数）。

## 10.7 本章要点

- Plugin SDK 用 15+ 种 Adapter 接口实现接口隔离，渠道只实现需要的部分
- `ChannelCapabilities` 让核心系统了解每个渠道的能力边界
- `InboundEnvelope` 是消息的"通用货币"，实现渠道无关性
- SDK 提供丰富的辅助工具覆盖文本处理、安全、数据管理和 Webhook

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/plugin-sdk/core.ts` | ★★★ | 核心接口定义（必读） |
| `src/plugin-sdk/index.ts` | ★★ | SDK 导出汇总 |
| `src/plugin-sdk/inbound-envelope.ts` | ★★ | 入站消息类型 |
| `src/plugin-sdk/text-chunking.ts` | ★ | 文本分块工具 |
| `src/plugin-sdk/allow-from.ts` | ★ | 白名单匹配 |
