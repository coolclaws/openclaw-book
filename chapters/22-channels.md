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

## 22.5 Slash Commands：跨渠道命令系统

**文件：** `src/auto-reply/commands-registry.ts`, `src/auto-reply/reply/commands-*.ts`

Slash Commands 是 OpenClaw 内置的命令交互层，允许用户在任意渠道里用 `/command` 语法触发功能，无需把指令包含在自然语言消息里。它在消息进入 Agent 运行时之前被拦截处理，不占用 LLM token。

### 22.5.1 两种命令形态

| 形态 | 说明 | 典型渠道 |
|------|------|---------|
| **Text Commands**（文本命令）| 纯文本消息以 `/` 开头，如 `/status`、`/compact` | 所有渠道（Signal、Telegram、Discord 等）|
| **Native Commands**（原生命令）| 渠道原生的 Slash Command 注册（如 Discord `/command` 自动补全）| Discord、Slack |

`CommandScope` 字段控制命令在哪种形态下生效：`"text"` / `"native"` / `"both"`。

### 22.5.2 内置命令分类

内置命令按 `CommandCategory` 分七组：

| 分类 | 代表命令 | 说明 |
|------|---------|------|
| `session` | `/compact`, `/abort`, `/export-session` | 会话管理 |
| `status` | `/status` | 显示当前模型、token 用量、reasoning 级别 |
| `options` | `/reasoning`, `/verbose`, `/model` | 运行时参数切换 |
| `management` | `/restart`, `/config` | 系统管理 |
| `media` | `/tts` | 媒体功能开关 |
| `tools` | `/bash`, `/approve` | 工具相关 |
| `docks` | `/acp` | ACP 会话对接 |

### 22.5.3 Skill Commands 扩展

Skills 可以注册自定义命令（`SkillCommandSpec`），与内置命令共享同一套注册表：

```typescript
// SKILL.md 中通过约定的接口注册
const spec: SkillCommandSpec = {
  name: "my-skill",
  description: "触发 my-skill 功能",
  textAliases: ["/my-skill"],
  scope: "both",
};
```

`listChatCommandsForConfig` 会把内置命令和 Skill 命令合并后返回，再由渠道适配器注册为 Discord/Slack 原生命令或文本匹配规则。

### 22.5.4 Native Commands 渠道注册

Discord 和 Slack 支持服务端注册的原生 Slash Commands，有自动补全和参数菜单：

```typescript
type NativeCommandSpec = {
  name: string;
  description: string;
  acceptsArgs: boolean;
  args?: CommandArgDefinition[];  // 每个 arg 可定义 choices 或触发 autocomplete
};
```

`resolveNativeCommandsEnabled` 在每次消息到来时检查是否需要同步命令列表到渠道平台。

### 22.5.5 命令解析流程

```
消息到达
    ↓
parseSlashCommand()  → 是 Slash Command？
    ↓ 是
handleCommands()    → 找到对应 handler
    ↓
直接返回响应（不进入 Pi 引擎，不消耗 LLM）
    ↓
用户收到 /status 回复、模型切换确认等
```

不是命令 → 正常流入 Pi 引擎处理。

---

## 22.6 渠道共性模式

阅读多个渠道实现后可以提炼出七种共性模式：

1. **Setup/Teardown**：建立连接 + 清理资源
2. **Inbound Handler**：平台消息 → InboundEnvelope 转换
3. **Outbound Adapter**：Agent 回复 → 平台格式转换
4. **Media Pipeline**：图片/音频/视频的上传下载和转码
5. **Group Support**：群组消息的 mention 激活和路由
6. **Reconnection**：长连接断开后的自动重连（带退避）
7. **Rate Limiting**：遵守平台 API 限制（如 Telegram 30 msg/sec）

## 22.6.1 Discord 自动归档与 Mattermost 线程

> **📦 v2026.3.11 新增**

**Discord `autoArchiveDuration` 配置：**

Discord 渠道新增 `autoArchiveDuration` 配置项，控制 thread 的自动归档时长：

```json
{
  "channels": {
    "discord": {
      "autoArchiveDuration": "1d"
    }
  }
}
```

支持的值：`"1h"`、`"1d"`、`"3d"`、`"7d"`。归档后的 thread 不再接收新消息路由，但历史记录保留。这对于使用 thread-bound ACP session 的场景特别有用——完成的编码任务 thread 会自动归档，保持频道整洁。

**Mattermost 线程会话模式：**

新增 `channels.mattermost.replyToMode` 配置，支持在顶层帖子（root post）上开启线程会话。设置后，Agent 的回复会自动作为线程回复而非独立消息发送，与 Mattermost 的线程式协作模式对齐。

---

## 22.6.2 Slack Block Kit 支持

> **📦 v2026.3.12 新增**

Slack 渠道现在通过 `channelData.slack.blocks` 支持 [Block Kit](https://api.slack.com/block-kit) 消息格式。Agent 在使用 `message` 工具向 Slack 发送消息时，可以传递 Block Kit JSON 结构，走标准 outbound delivery 路径：

```json
{
  "channel": "slack",
  "to": "#general",
  "channelData": {
    "slack": {
      "blocks": [
        {
          "type": "section",
          "text": { "type": "mrkdwn", "text": "*日报摘要*\n今日完成 3 项任务" }
        },
        {
          "type": "actions",
          "elements": [
            { "type": "button", "text": { "type": "plain_text", "text": "查看详情" }, "url": "..." }
          ]
        }
      ]
    }
  }
}
```

这让 Agent 能够发送包含按钮、分栏、图表等丰富布局的 Slack 消息，而非仅限于纯文本。

---

## 22.7 本章要点

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
