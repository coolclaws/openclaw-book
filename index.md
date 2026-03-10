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
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M7 7h10M7 11h6"/></svg>'
    title: 架构全景
    details: 从 Gateway 控制平面到消息流水线，系统梳理 OpenClaw 的整体架构设计，理解各模块之间的协作关系。

  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/><circle cx="18" cy="8" r="2"/><path d="M18 10v4l2 2"/></svg>'
    title: Agent 运行时深挖
    details: 深入 Pi 引擎的三层循环结构，剖析 System Prompt 组装、模型选择、上下文管理、工具策略的完整实现。

  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>'
    title: 扩展体系解读
    details: 覆盖 Plugin SDK、渠道适配器、Extension 机制、ACP 外部编码 Agent 协议，理解 OpenClaw 的可扩展设计。

  - icon:
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>'
    title: 安全与基础设施
    details: 安全模型、Sandbox 隔离、Cron 调度引擎、记忆系统——补全生产级部署所需的完整知识体系。
---
