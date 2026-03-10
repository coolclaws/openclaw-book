# OpenClaw 源码解析

> 深入剖析 OpenClaw —— 一个开源的个人 AI 助手网关系统

## 关于本书

[OpenClaw](https://github.com/openclaw/openclaw) 是一个开源项目，它不是一个 AI 模型，而是一个**个人 AI 助手的控制平面（Control Plane）**。它将 WhatsApp、Telegram、Slack、Discord 等十几种聊天渠道统一接入，路由给 Claude、GPT 等大语言模型，再将回复分发回对应渠道。

本书从源码层面系统梳理 OpenClaw 的架构设计与实现细节，适合希望：

- 理解大型 TypeScript 开源项目架构的开发者
- 学习 AI Agent 网关系统设计模式的工程师
- 希望基于 OpenClaw 进行二次开发或贡献代码的参与者
- 对多渠道消息系统、插件体系、模型管理感兴趣的技术人员

## 目录

详见 [CONTENTS.md](./contents.md)

全书共 **26 章 + 2 附录**，分六个部分：

| 部分 | 章节 | 核心议题 |
|------|------|---------|
| 第一部分：宏观认知 | Ch 1–2 | 项目定位、仓库结构 |
| 第二部分：启动与基础设施 | Ch 3–4 | CLI 入口、配置系统 |
| 第三部分：核心流水线 | Ch 5–9 | Gateway、消息入境/出境、媒体理解、Cron |
| 第四部分：Agent 运行时 | Ch 10–20 | Pi 引擎、模型选择、上下文、记忆、工具、Sandbox、Browser、Skills、Sub-agent、ACP |
| 第五部分：扩展体系 | Ch 21–23 | Plugin SDK、渠道实现、Extension |
| 第六部分：辅助系统 | Ch 24–26 | 安全模型、前端、辅助子系统 |

## 阅读建议

按照**由外到内、由静到动**的顺序组织。推荐阅读路径：

### 阶段一：快速建立全局视图（约 2 小时）
- **第 1–2 章**：项目定位 + 仓库结构——建立整体认知
- **第 5 章**：Gateway 控制平面——理解系统骨架

### 阶段二：核心流水线（约 3 小时）⭐ 全书关键
- **第 6–7 章**：消息入境与出境——一条消息进出系统的完整旅程
- **第 8–9 章**：媒体理解 + Cron——消息附件处理与定时任务

### 阶段三：Agent 运行时（约 4 小时）
- **第 10–14 章**：Pi 引擎、System Prompt、模型选择、上下文管理、记忆系统
- **第 15–17 章**：工具策略、Sandbox、Browser 控制

### 阶段四：多 Agent 协作（约 2 小时）
- **第 18–20 章**：Skills、Sub-agent、ACP（外部编码 Agent）

### 阶段五：扩展与安全（按需阅读）
- **第 21–23 章**：Plugin SDK、渠道实现、Extension
- **第 24 章**：安全模型（重要，特别是 Exec 审批和 Auth Profiles）
- **第 25–26 章**：前端、辅助子系统

## 源码版本

本书基于 OpenClaw `v2026.3.x`（`main` branch，March 2026）进行分析。

## License

本书内容采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 许可证。
OpenClaw 项目本身采用 MIT 许可证。
