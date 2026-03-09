# 第 1 章 项目概览与定位

## 1.1 OpenClaw 是什么

OpenClaw 不是一个 AI 模型，而是一个**个人 AI 助手的网关系统**。它的核心理念是：

> 你已经有了最好的 AI 模型（Claude、GPT），你也已经有了最常用的聊天工具（WhatsApp、Telegram、Slack）。OpenClaw 做的事情是把它们连接起来，让 AI 助手能够在你已有的渠道上回复你。

从架构角色来看，OpenClaw 是一个**控制平面（Control Plane）**：

```
消息渠道（WhatsApp/Telegram/Slack/Discord/...）
               │
               ▼
┌───────────────────────────────┐
│          Gateway              │
│       （控制平面）              │
│     ws://127.0.0.1:18789      │
└──────────────┬────────────────┘
               │
               ├─ Pi Agent（RPC 模式调用 LLM）
               ├─ CLI（openclaw 命令行）
               ├─ WebChat UI
               ├─ macOS 菜单栏应用
               └─ iOS / Android 节点
```

## 1.2 核心设计理念

通过阅读 `VISION.md` 和项目结构，可以提炼出 OpenClaw 的几个核心设计理念：

**Local-First（本地优先）**：Gateway 默认运行在本机 `127.0.0.1:18789`，不需要云服务。你的数据、session、配置都在 `~/.openclaw/` 下。

**Single-User（单用户）**：OpenClaw 为个人使用而设计。Gateway 的 "main" session 拥有完整的主机访问权限（可以执行 bash 命令），这是刻意的设计选择——因为这是*你自己的*助手。

**Multi-Channel（多渠道）**：这是 OpenClaw 最大的价值点。它不绑定任何单一聊天平台，而是通过统一的消息抽象层同时支持十几种渠道。

**Model-Agnostic（模型无关）**：虽然推荐 Anthropic Claude，但理论上支持任何 LLM 提供商。模型选择、failover、auth profile 轮转都是一等公民。

**Plugin-First（插件优先）**：核心保持精简，可选功能通过插件/扩展实现。项目有完整的 Plugin SDK 和 Extension 机制。

## 1.3 技术栈概览

| 层次 | 技术 | 说明 |
|------|------|------|
| 语言 | TypeScript (strict ESM) | 全量类型标注，禁用 `any` |
| 运行时 | Node.js 22+ | Bun 可选用于开发 |
| 包管理 | pnpm workspace | monorepo，含 root + ui + packages/* + extensions/* |
| 构建 | tsdown (esbuild) | 产出 `dist/` 目录 |
| Schema | TypeBox | 配置校验、工具定义、API 参数 |
| 测试 | Vitest + V8 coverage | 70% 覆盖率阈值 |
| Lint/Format | Oxlint + Oxfmt | 非 ESLint/Prettier |
| CLI | Commander.js | 命令行参数解析 |
| WebSocket | ws | Gateway 通信协议 |
| macOS/iOS | Swift + SwiftUI | 使用 Observation 框架 |
| Android | Kotlin | Jetpack Compose |

## 1.4 项目规模

基于 `v2026.3.9` 版本的统计：

- **总提交数**：10,729
- **`src/` 目录**：约 30MB，核心 TypeScript 源码
- **`extensions/`**：16MB，30+ 个独立的渠道/功能扩展
- **`apps/`**：15MB，macOS/iOS/Android 伴侣应用
- **`docs/`**：15MB，Mintlify 文档站
- **`ui/`**：1.7MB，Control UI + WebChat 前端
- **`skills/`**：580KB，50+ 个内置技能

最大的模块是 `src/agents/`（5.6MB, 210+ 文件），它包含了 Agent 运行时的全部逻辑。

## 1.5 发展历程

从 `VISION.md` 可以看到项目经历了多次更名：

> Warelay → Clawdbot → Moltbot → OpenClaw

最初是 Peter Steinberger 的个人实验项目，目标是"学习 AI 并构建真正有用的东西"。项目的吉祥物是一只太空龙虾（Molty），口号是 "EXFOLIATE!"。

## 1.6 本章小结

理解 OpenClaw 的关键是：**它是一个连接器和控制平面，而不是一个 AI 模型**。它要解决的问题是"如何让 AI 助手无处不在地为你服务"，而不是"如何让 AI 更聪明"。

带着这个认知，接下来我们进入仓库结构的详细拆解。
