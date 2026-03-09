# 附录 A：推荐阅读路径

## 路径一：全景式阅读（2-3 周）

按照本书章节顺序，从头到尾阅读。适合希望全面理解 OpenClaw 的读者。

```
第 1-2 章（1-2 天）→ 第 3-4 章（1-2 天）→ 第 5-6 章（2-3 天）
→ 第 7-9 章（3-5 天）→ 第 10-12 章（2-3 天）→ 第 13-15 章（按需）
```

## 路径二：消息流追踪（3-5 天）

如果你只想理解"一条消息从用户发出到收到 AI 回复的全过程"，按照这个路径：

```
1. src/telegram/handlers.ts        — 消息如何进入系统
2. src/auto-reply/envelope.ts      — 消息如何被封装
3. src/auto-reply/dispatch.ts      — 消息如何被分发
4. src/routing/resolve-route.ts    — 路由如何确定
5. src/auto-reply/reply.ts         — AI 回复如何生成
6. src/agents/pi-embedded.ts       — Agent 如何运行
7. src/agents/system-prompt.ts     — System prompt 如何组装
8. src/auto-reply/chunk.ts         — 回复如何分块发送
9. src/telegram/outbound.ts        — 回复如何发到 Telegram
```

## 路径三：Agent 深入（3-5 天）

如果你对 AI Agent 的运行机制最感兴趣：

```
1. src/agents/system-prompt.ts         — Prompt 工程
2. src/agents/pi-embedded.ts           — Agent 入口
3. src/agents/pi-embedded-subscribe.ts — 流式处理
4. src/agents/pi-embedded-subscribe.handlers.tools.ts — 工具调用
5. src/agents/model-selection.ts       — 模型选择
6. src/agents/auth-profiles.ts         — 认证轮转
7. src/agents/compaction.ts            — 上下文管理
8. src/agents/tools/common.ts          — 工具注册
9. src/agents/tools/message-tool.ts    — 消息工具实现
```

## 路径四：插件开发（2-3 天）

如果你想为 OpenClaw 开发渠道插件：

```
1. src/plugin-sdk/core.ts              — 必读，所有接口定义
2. src/plugin-sdk/index.ts             — SDK 导出
3. extensions/matrix/src/index.ts      — 一个完整的插件示例
4. src/plugins/discovery.ts            — 理解插件如何被发现
5. src/plugins/enable.ts               — 理解插件如何被加载
6. src/telegram/handlers.ts            — 参考最完整的渠道实现
```

## 路径五：基础设施（1-2 天）

如果你对项目工程化感兴趣：

```
1. package.json + pnpm-workspace.yaml  — Monorepo 结构
2. tsdown.config.ts                    — 构建配置
3. vitest.config.ts                    — 测试配置
4. src/infra/                          — 基础设施工具
5. src/logging/                        — 日志系统
6. CLAUDE.md                           — 开发规范
```

## 关键文件 Top 10

如果时间有限，这 10 个文件能让你快速建立对 OpenClaw 的理解：

| # | 文件 | 理由 |
|---|------|------|
| 1 | `src/agents/system-prompt.ts` | 理解 Agent 的"灵魂" |
| 2 | `src/auto-reply/dispatch.ts` | 理解消息入口 |
| 3 | `src/auto-reply/reply.ts` | 理解 AI 回复生成 |
| 4 | `src/agents/pi-embedded.ts` | 理解 Agent 运行时 |
| 5 | `src/plugin-sdk/core.ts` | 理解渠道抽象 |
| 6 | `src/gateway/boot.ts` | 理解系统启动 |
| 7 | `src/routing/resolve-route.ts` | 理解消息路由 |
| 8 | `src/config/io.ts` | 理解配置系统 |
| 9 | `src/agents/model-selection.ts` | 理解多模型管理 |
| 10 | `src/agents/tools/common.ts` | 理解工具注册 |
