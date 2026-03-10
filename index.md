---
layout: home

hero:
  name: "OpenClaw 源码解析"
  text: "深入剖析一个开源 AI 助手网关"
  tagline: 从 CLI 入口到 Agent 运行时，全面解读 OpenClaw 的架构设计与实现细节
  actions:
    - theme: brand
      text: 开始阅读
      link: /chapters/01-project-overview
    - theme: alt
      text: 查看目录
      link: /contents
    - theme: alt
      text: GitHub
      link: https://github.com/coolclaws/openclaw-book

features:
  - icon:
      src: /openclaw-book/icons/architecture.svg
    title: 架构全景
    details: 从 Gateway 控制平面到消息流水线，系统梳理 OpenClaw 的整体架构设计，理解各模块之间的协作关系。

  - icon:
      src: /openclaw-book/icons/agent.svg
    title: Agent 运行时深挖
    details: 深入 Pi 引擎的三层循环结构，剖析 System Prompt 组装、模型选择、上下文管理、工具策略的完整实现。

  - icon:
      src: /openclaw-book/icons/extensions.svg
    title: 扩展体系解读
    details: 覆盖 Plugin SDK、渠道适配器、Extension 机制、ACP 外部编码 Agent 协议，理解 OpenClaw 的可扩展设计。

  - icon:
      src: /openclaw-book/icons/security.svg
    title: 安全与基础设施
    details: 安全模型、Sandbox 隔离、Cron 调度引擎、记忆系统——补全生产级部署所需的完整知识体系。
---
