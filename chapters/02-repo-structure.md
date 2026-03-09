# 第 2 章 仓库结构与模块地图

## 2.1 Monorepo 结构

OpenClaw 使用 pnpm workspace 管理 monorepo，工作空间定义在 `pnpm-workspace.yaml`：

```yaml
packages:
  - .          # 主包（openclaw CLI + Gateway）
  - ui         # Control UI + WebChat 前端
  - packages/* # 内部共享包（clawdbot, moltbot）
  - extensions/* # 渠道扩展插件（30+ 个）
```

主包的 `package.json` 中 `bin` 字段指向 `openclaw.mjs`，这是 npm 安装后的全局命令入口。真正的代码入口是 `src/entry.ts`，构建后产出到 `dist/`。

## 2.2 顶层目录一览

```
openclaw/
├── src/                # 核心源码（30MB, 本书的主角）
├── extensions/         # 渠道扩展插件（独立 workspace packages）
├── apps/               # 伴侣应用（macOS/iOS/Android Swift/Kotlin）
├── ui/                 # 前端（Vite + React, Control UI + WebChat）
├── docs/               # Mintlify 文档站
├── skills/             # 内置技能（50+ 个 SKILL.md 文件）
├── vendor/a2ui/        # Canvas A2UI 运行时（vendored）
├── packages/           # 内部包（clawdbot, moltbot）
├── scripts/            # 构建/发布/调试脚本
├── test/               # 全局测试 fixtures 和 helpers
├── Swabble/            # Swift 工具库（macOS 应用依赖）
├── .agents/            # Agent 工作流配置
├── .pi/                # Pi agent 配置和 prompts
├── patches/            # pnpm 依赖补丁
└── git-hooks/          # pre-commit hooks
```

## 2.3 `src/` 模块详解

`src/` 是整个项目的心脏。按照职责可以分为以下几个层次：

### 第一层：入口与 CLI

| 目录/文件 | 大小 | 说明 |
|-----------|------|------|
| `entry.ts` | 6KB | 程序入口，Node respawn、版本快速路径 |
| `index.ts` | 3KB | 库入口，构建 Commander program |
| `cli/` | 1.6MB | CLI 命令注册、参数解析、profile、banner |
| `commands/` | 2.3MB | 所有子命令实现（agent, gateway, channels, auth, onboard 等） |

### 第二层：Gateway 控制平面

| 目录 | 大小 | 说明 |
|------|------|------|
| `gateway/` | 2.7MB | WebSocket 服务、认证、boot、config reload、Control UI |
| `config/` | 1.6MB | 配置 I/O、TypeBox schema、类型定义、校验、运行时覆盖 |
| `routing/` | 78KB | 消息路由、account 解析、session key 派发 |
| `sessions/` | 31KB | Session 模型管理 |

### 第三层：Agent 运行时（最大模块）

| 目录 | 大小 | 说明 |
|------|------|------|
| `agents/` | 5.6MB | Agent 全部逻辑（210+ 文件）|
| `agents/tools/` | - | 50+ 个内置工具（browser, canvas, cron, message, web-search 等）|
| `agents/auth-profiles/` | - | OAuth/API key 轮转与 cooldown |
| `agents/pi-embedded*.ts` | - | Pi agent 运行时（LLM 通信核心）|
| `agents/sandbox*/` | - | Docker 沙箱隔离 |
| `agents/skills*.ts` | - | Skills 平台 |
| `agents/subagent-*.ts` | - | 子 agent 派生与协调 |

### 第四层：消息处理

| 目录 | 大小 | 说明 |
|------|------|------|
| `auto-reply/` | 2.4MB | 消息接收 → 指令检测 → AI 回复 → 分块发送 |
| `channels/` | 786KB | 渠道抽象层、plugin 适配器 |
| `media/` | 159KB | 媒体管道（图片/音频/视频处理）|
| `media-understanding/` | 295KB | 媒体内容理解（转录、OCR）|

### 第五层：内置渠道

| 目录 | 大小 | 说明 |
|------|------|------|
| `telegram/` | 1.2MB | Telegram 渠道（grammY）|
| `discord/` | 1.3MB | Discord 渠道（discord.js）|
| `slack/` | 676KB | Slack 渠道（Bolt）|
| `whatsapp/` 及 `web/` | 440KB+ | WhatsApp 渠道（Baileys）|
| `signal/` | 184KB | Signal 渠道（signal-cli）|
| `imessage/` | 136KB | iMessage 渠道（legacy）|

### 第六层：插件与扩展支持

| 目录 | 大小 | 说明 |
|------|------|------|
| `plugin-sdk/` | 321KB | 插件开发 SDK，定义所有渠道适配器接口 |
| `plugins/` | 494KB | 插件加载、发现、配置、hook 运行 |
| `hooks/` | 285KB | 生命周期 hook 系统 |

### 第七层：基础设施

| 目录 | 大小 | 说明 |
|------|------|------|
| `infra/` | 2.1MB | 环境变量、端口管理、二进制、runtime guard |
| `process/` | 117KB | 子进程执行（exec, pty）|
| `security/` | 455KB | 安全策略、prompt injection 防御 |
| `logging/` | 109KB | 结构化日志 |
| `memory/` | 619KB | 记忆系统 |
| `browser/` | 828KB | Chrome/Chromium 浏览器控制 |
| `cron/` | 778KB | 定时任务 |
| `tts/` | 79KB | 文本转语音 |
| `utils/` | 73KB | 通用工具函数 |

## 2.4 `extensions/` 扩展目录

每个扩展都是一个独立的 pnpm workspace package，有自己的 `package.json`。扩展通过 Plugin SDK 与核心交互：

```
extensions/
├── matrix/          # Matrix 协议
├── msteams/         # Microsoft Teams
├── bluebubbles/     # iMessage（推荐方案）
├── googlechat/      # Google Chat
├── zalo/            # Zalo
├── zalouser/        # Zalo Personal
├── voice-call/      # 语音通话
├── discord/         # Discord 扩展功能
├── slack/           # Slack 扩展功能
├── telegram/        # Telegram 扩展功能
├── feishu/          # 飞书
├── irc/             # IRC
├── nostr/           # Nostr 协议
├── twitch/          # Twitch
├── mattermost/      # Mattermost
├── nextcloud-talk/  # Nextcloud Talk
├── tlon/            # Tlon
├── memory-core/     # 记忆系统核心
├── memory-lancedb/  # LanceDB 记忆后端
├── diffs/           # Diff 工具
├── open-prose/      # 写作工具
├── llm-task/        # LLM 任务
├── ...              # 还有更多
```

## 2.5 `skills/` 技能目录

Skills 是 Agent 可以按需加载的能力包，每个技能包含一个 `SKILL.md` 文件：

```
skills/
├── coding-agent/    # 编程 agent
├── canvas/          # Canvas 操作
├── discord/         # Discord 管理
├── slack/           # Slack 管理
├── github/          # GitHub 操作
├── gh-issues/       # GitHub Issues
├── weather/         # 天气查询
├── obsidian/        # Obsidian 笔记
├── notion/          # Notion
├── tmux/            # Tmux 操作
├── camsnap/         # 摄像头
├── clawhub/         # ClawHub 技能注册中心
├── ...              # 50+ 个技能
```

## 2.6 模块依赖关系图

以下是核心模块之间的调用关系（简化版）：

```
entry.ts → cli/program.ts → commands/*
                                │
                    commands/gateway.ts
                                │
                         gateway/boot.ts
                          ┌─────┴─────┐
                     config/        gateway/server
                          │              │
                     routing/       gateway/client
                          │              │
                    auto-reply/     gateway/auth
                     ┌────┴────┐
                dispatch.ts  reply.ts
                                │
                          agents/pi-embedded.ts
                           ┌────┴────┐
                    system-prompt.ts  tools/*
                           │
                    model-selection.ts
                    auth-profiles.ts
```

## 2.7 关键配置文件

| 文件 | 作用 |
|------|------|
| `package.json` | 主包依赖、scripts、bin 入口 |
| `pnpm-workspace.yaml` | monorepo workspace 定义 |
| `tsconfig.json` | TypeScript 编译配置 |
| `tsdown.config.ts` | 构建配置 |
| `vitest.config.ts` | 测试配置（还有多个变体 config） |
| `.oxlintrc.json` | Oxlint 规则 |
| `.oxfmtrc.jsonc` | Oxfmt 格式化配置 |
| `CLAUDE.md` | 开发者指南（Agent 友好格式）|
| `AGENTS.md` | Agent workspace 注入的 prompt |

## 2.8 本章小结

OpenClaw 的模块划分非常清晰：**入口 → CLI → Gateway → 路由 → 消息处理 → Agent → 工具**。这条主线串联了用户发消息到收到 AI 回复的全部过程。Extensions 和 Plugins 则以"侧挂"的方式扩展渠道能力。

接下来我们从程序的入口开始，追踪代码的执行流。
