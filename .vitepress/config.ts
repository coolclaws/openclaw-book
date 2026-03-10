import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'OpenClaw 源码解析',
  description: '深入剖析 OpenClaw —— 一个开源的个人 AI 助手网关系统',
  lang: 'zh-CN',

  base: '/openclaw-book/',

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/openclaw-book/favicon.svg' }],
    ['link', { rel: 'icon', type: 'image/x-icon', href: '/openclaw-book/favicon.ico' }],
    ['meta', { name: 'theme-color', content: '#ff4d4d' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'OpenClaw 源码解析' }],
    ['meta', { property: 'og:description', content: '深入剖析 OpenClaw —— 一个开源的个人 AI 助手网关系统' }],
  ],

  themeConfig: {
    logo: { src: '/logo.svg', alt: 'OpenClaw' },

    nav: [
      { text: '开始阅读', link: '/chapters/01-project-overview' },
      { text: '目录', link: '/contents' },
      { text: 'GitHub', link: 'https://github.com/coolclaws/openclaw-book' },
    ],

    sidebar: [
      {
        text: '前言',
        items: [
          { text: '关于本书', link: '/' },
          { text: '完整目录', link: '/contents' },
        ],
      },
      {
        text: '第一部分：宏观认知',
        collapsed: false,
        items: [
          { text: '第 1 章　项目概览与定位', link: '/chapters/01-project-overview' },
          { text: '第 2 章　仓库结构与模块地图', link: '/chapters/02-repo-structure' },
        ],
      },
      {
        text: '第二部分：启动与基础设施',
        collapsed: false,
        items: [
          { text: '第 3 章　入口与 CLI 系统', link: '/chapters/03-entry-and-cli' },
          { text: '第 4 章　配置系统', link: '/chapters/04-config-system' },
        ],
      },
      {
        text: '第三部分：核心流水线',
        collapsed: false,
        items: [
          { text: '第 5 章　Gateway 控制平面', link: '/chapters/05-gateway' },
          { text: '第 6 章　消息流水线', link: '/chapters/06-message-pipeline' },
          { text: '第 7 章　消息出境：Outbound Delivery', link: '/chapters/07-outbound-delivery' },
          { text: '第 8 章　媒体理解', link: '/chapters/08-media-understanding' },
          { text: '第 9 章　Cron 调度引擎', link: '/chapters/09-cron' },
        ],
      },
      {
        text: '第四部分：Agent 运行时',
        collapsed: false,
        items: [
          { text: '第 10 章　Pi 引擎总览与三层架构', link: '/chapters/10-agent-runtime' },
          { text: '第 11 章　System Prompt', link: '/chapters/11-system-prompt' },
          { text: '第 12 章　模型选择', link: '/chapters/12-model-selection' },
          { text: '第 13 章　上下文管理', link: '/chapters/13-context-management' },
          { text: '第 14 章　记忆系统', link: '/chapters/14-memory' },
          { text: '第 15 章　工具策略', link: '/chapters/15-tool-policy' },
          { text: '第 16 章　Sandbox', link: '/chapters/16-sandbox' },
          { text: '第 17 章　Browser 控制系统', link: '/chapters/17-browser' },
          { text: '第 18 章　Skills', link: '/chapters/18-skills' },
          { text: '第 19 章　Sub-agent 系统', link: '/chapters/19-subagent' },
          { text: '第 20 章　ACP：外部 Agent 通信协议', link: '/chapters/20-acp' },
        ],
      },
      {
        text: '第五部分：扩展体系',
        collapsed: false,
        items: [
          { text: '第 21 章　Plugin SDK 与渠道抽象', link: '/chapters/21-plugin-sdk' },
          { text: '第 22 章　消息渠道实现', link: '/chapters/22-channels' },
          { text: '第 23 章　Extension 扩展机制', link: '/chapters/23-extensions' },
        ],
      },
      {
        text: '第六部分：辅助系统',
        collapsed: false,
        items: [
          { text: '第 24 章　安全模型', link: '/chapters/24-security' },
          { text: '第 25 章　前端与伴侣应用', link: '/chapters/25-frontend' },
          { text: '第 26 章　辅助子系统', link: '/chapters/26-auxiliary-systems' },
        ],
      },
      {
        text: '附录',
        collapsed: true,
        items: [
          { text: '附录 A：推荐阅读路径', link: '/chapters/appendix-a-reading-path' },
          { text: '附录 B：关键类型速查', link: '/chapters/appendix-b-type-reference' },
          { text: '附录 C：名词解释（Glossary）', link: '/chapters/appendix-c-glossary' },
        ],
      },
    ],

    outline: {
      level: [2, 3],
      label: 'On This Page',
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/coolclaws/openclaw-book' },
    ],

    footer: {
      message: '基于 MIT 协议发布',
      copyright: 'Copyright © 2025-present',
    },

    search: {
      provider: 'local',
    },
  },

  markdown: {
    lineNumbers: true,
  },
})
