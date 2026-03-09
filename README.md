# OpenClaw 源码解析

> 深入剖析 OpenClaw —— 一个开源的个人 AI 助手网关系统

## 关于本书

[OpenClaw](https://github.com/openclaw/openclaw) 是一个 196k+ Star 的开源项目，它不是一个 AI 模型，而是一个**个人 AI 助手的控制平面（Control Plane）**。它将 WhatsApp、Telegram、Slack、Discord 等十几种聊天渠道统一接入，路由给 Claude、GPT 等大语言模型，再将回复分发回对应渠道。

本书从源码层面系统梳理 OpenClaw 的架构设计与实现细节，适合希望：

- 理解大型 TypeScript 开源项目架构的开发者
- 学习 AI Agent 网关系统设计模式的工程师
- 希望基于 OpenClaw 进行二次开发或贡献代码的参与者
- 对多渠道消息系统、插件体系、模型管理感兴趣的技术人员

## 技术栈

| 分类 | 技术选型 |
|------|---------|
| 语言 | TypeScript (ESM) |
| 运行时 | Node.js 22+ / Bun (可选) |
| 包管理 | pnpm monorepo |
| 构建 | tsdown (esbuild-based) |
| 测试 | Vitest + V8 coverage |
| Lint | Oxlint + Oxfmt |
| Schema | TypeBox (JSON Schema) |
| 伴侣应用 | Swift (macOS/iOS) / Kotlin (Android) |

## 目录

详见 [CONTENTS.md](./CONTENTS.md)

## 阅读建议

本书按照**由外到内、由静到动**的顺序组织。建议的阅读路径：

1. **快速概览**（第 1-2 章）：了解项目定位和整体架构
2. **启动流程**（第 3-4 章）：从 CLI 入口追踪到 Gateway 启动
3. **核心流水线**（第 5-6 章）：Gateway 控制平面 + 消息从进入到回复的完整链路——全书关键章节
4. **Agent 运行时**（第 7-10 章）：Pi 引擎三层架构、System Prompt、模型选择、上下文管理
5. **工具与扩展**（第 11-14 章）：工具策略、Sandbox、Skills、Sub-agent 系统
6. **扩展体系**（第 15-17 章）：Plugin SDK、消息渠道实现、Extension 机制
7. **辅助系统**（第 18-20 章）：安全模型、前端、辅助子系统——按需阅读

## 源码版本

本书基于 OpenClaw `v2026.3.9`（commit on `main` branch, March 2026）进行分析。

## License

本书内容采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 许可证。
OpenClaw 项目本身采用 MIT 许可证。
