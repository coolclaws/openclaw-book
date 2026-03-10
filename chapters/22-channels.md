# 第 22 章 消息渠道实现

## 22.1 渠道分类

OpenClaw 的渠道分为两类：**核心渠道**（编译到主包）和**扩展渠道**（独立 package）。

| 类别 | 渠道 | 底层库 | 代码量 | 特点 |
|------|------|--------|--------|------|
| 核心 | Telegram | grammY | 1.2MB | 最完整的参考实现 |
| 核心 | Discord | discord.js | 1.3MB | 最丰富的交互能力 |
| 核心 | Slack | Bolt | 676KB | 企业级 |
| 核心 | WhatsApp | Baileys | 460KB | 非官方 API，QR 码登录 |
| 核心 | Signal | signal-cli | 184KB | 依赖外部 CLI |
| 核心 | iMessage | imsg (legacy) | 136KB | 仅 macOS |
| 扩展 | Matrix | matrix-js-sdk | 387KB | 开源协议 |
| 扩展 | MS Teams | Bot Framework | 412KB | 企业级 |
| 扩展 | BlueBubbles | REST API | 473KB | 推荐的 iMessage 方案 |
| 扩展 | Google Chat | Chat API | 137KB | Google Workspace |
| 扩展 | 飞书 | Open API | 698KB | 中国市场 |

## 22.2 以 Telegram 为例：完整渠道剖析

Telegram 是最完整的渠道实现，是理解渠道模式的最佳参考。

### 消息入站流程

```
Telegram Server
  → grammY bot.on("message") [handlers.ts]
    → 提取消息内容（文本/媒体/sticker/poll/...）
    → 提取发送者信息（ID, username, first_name）
    → 提取群组信息（如果是群消息）
    → 处理回复引用（replyTo）
    → 处理转发消息
    → 处理媒体：下载 → 临时文件 → 转码（如需）
    → 音频消息：下载 → 转录（Whisper）→ 注入 Transcript
    → 构建 MsgContext（60+ 字段）
    → 交给 auto-reply/dispatch
```

### 消息出站流程

```
Agent 回复 → outbound.ts
  → 检查消息长度 vs Telegram 限制（4096 字符）
  → 如果超长 → 分块（text-chunking）
  → 如果有媒体附件 → 上传
  → 如果有行内按钮 → 构建 InlineKeyboard
  → 如果是流式回复 → 使用 editMessage（编辑同一条消息）
  → 最终调用 grammY bot.api.sendMessage()
```

### Telegram 独特能力

- **原生 Bot Commands**：`/start`、`/help` 等注册到 Telegram
- **Inline Buttons**：回复中可以携带可点击按钮
- **Reactions**：表情反应（`telegram-reaction-level.ts` 控制级别）
- **Sticker 处理**：将 sticker 转为图片理解
- **Poll 创建**：通过 message 工具创建投票
- **Stream 编辑**：流式回复通过编辑同一条消息实现，而非发送多条

### Telegram 的推理分离

Telegram 是唯一一个有专门推理内容展示的渠道。Agent 的推理过程（thinking）可以单独发送为一条可折叠的消息，与最终回复分开展示。其他渠道的通用 dispatch 路径会静默过滤推理内容。

## 22.3 WhatsApp 渠道的特殊性

WhatsApp 使用 [Baileys](https://github.com/WhiskeySockets/Baileys)——一个非官方的 WhatsApp Web API。这带来了独特的技术挑战：

### QR 码登录

```
openclaw channels login
  → 生成 WS 连接到 WhatsApp 服务器
  → 获取 QR 码
  → 在终端显示 QR 码（或在 Control UI 显示）
  → 用户用手机 WhatsApp 扫码
  → 建立持久 session（保存到 ~/.openclaw/credentials/）
```

`web/login.ts` 和 `web/login-qr.ts` 实现了这个流程。Session 凭证持久化后，重启 Gateway 不需要重新扫码。

### 重连机制

WhatsApp 的 WebSocket 连接不稳定，需要健壮的重连逻辑（`web/reconnect.ts`）。断线后自动重连，使用指数退避。

### 消息去重

WhatsApp/Baileys 可能重复投递消息，`shouldSkipDuplicateInbound` 在 dispatch 层面处理去重。

## 22.4 Discord 渠道的丰富交互

Discord 支持最丰富的交互能力：

- **Slash Commands**：`/ask`、`/model` 等注册为 Discord 原生命令
- **Thread Support**：消息线程的创建和回复
- **Guild Routing**：按 server（guild）和角色路由到不同 Agent
- **Embed Messages**：结构化的富文本消息
- **Voice Channel**：语音频道集成（通过扩展）
- **Reaction Handling**：表情反应触发操作

Discord 的渠道工具（`tools/discord-actions*.ts`）是所有渠道中最丰富的，包括 guild 管理、成员管理、频道管理、消息操作等。

## 22.5 渠道共性模式

阅读多个渠道实现后可以提炼出七种共性模式：

1. **Setup/Teardown**：建立连接 + 清理资源
2. **Inbound Handler**：平台消息 → InboundEnvelope 转换
3. **Outbound Adapter**：Agent 回复 → 平台格式转换
4. **Media Pipeline**：图片/音频/视频的上传下载和转码
5. **Group Support**：群组消息的 mention 激活和路由
6. **Reconnection**：长连接断开后的自动重连（带退避）
7. **Rate Limiting**：遵守平台 API 限制（如 Telegram 30 msg/sec）

## 22.6 本章要点

- Telegram 是最完整的参考实现，涵盖所有渠道模式
- WhatsApp 使用非官方 API，QR 码登录和重连是关键挑战
- Discord 交互能力最丰富，渠道工具最多
- 七种共性模式是所有渠道实现的"骨架"

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/telegram/` (全目录) | ★★★ | 最完整的渠道参考 |
| `src/web/login.ts` | ★★ | WhatsApp QR 码登录 |
| `src/web/inbound/` | ★★ | WhatsApp 入站处理 |
| `src/discord/events.ts` | ★★ | Discord 事件处理 |
| `src/channels/` | ★ | 渠道抽象层 |
