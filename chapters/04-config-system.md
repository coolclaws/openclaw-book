# 第 4 章 配置系统

## 4.1 配置文件与路径

OpenClaw 的配置存储在 `~/.openclaw/openclaw.json`（支持 JSON5 格式，可以写注释）。相关路径：

```
~/.openclaw/
├── openclaw.json          # 主配置文件
├── credentials/           # 渠道登录凭证（WhatsApp session 等）
├── sessions/              # Pi agent session 数据
├── workspace/             # Agent 工作空间
│   ├── AGENTS.md          # Agent 指令
│   ├── SOUL.md            # 人格定义
│   ├── TOOLS.md           # 工具说明
│   └── skills/            # 用户安装的技能
└── agents/                # 多 Agent 数据
```

配置路径的解析逻辑在 `src/config/config-paths.ts` 中，支持 `OPENCLAW_HOME` 环境变量覆盖。

## 4.2 配置加载流程

配置加载的入口是 `src/config/io.ts` 中的 `loadConfig()`：

```
loadConfig()
  ├── readConfigFileSnapshot()     # 读取 JSON5 文件
  ├── parseConfigJson5()           # 解析（支持注释）
  ├── migrateLegacyConfig()        # 迁移旧版配置字段
  ├── validateConfigObject()       # TypeBox schema 校验
  └── setRuntimeConfigSnapshot()   # 缓存运行时快照
```

运行时配置快照是全局缓存的，通过 `getRuntimeConfigSnapshot()` 获取。Gateway 支持配置热重载（`src/gateway/config-reload.ts`），监听文件变化后重新加载。

## 4.3 TypeBox Schema 类型系统

配置校验使用 [TypeBox](https://github.com/sinclairzx81/typebox)（一个 JSON Schema 生成库），类型定义散布在 `src/config/types.*.ts` 文件中：

```
src/config/
├── types.ts                        # 汇总导出
├── types.base.ts                   # 基础类型
├── types.agents.ts                 # Agent 配置
├── types.agent-defaults.ts         # Agent 默认值
├── types.channels.ts               # 渠道配置
├── types.auth.ts                   # 认证配置
├── types.browser.ts                # 浏览器配置
├── types.gateway.ts                # Gateway 配置
├── types.memory.ts                 # 记忆配置
├── types.channel-messaging-common.ts  # 消息通用配置
└── ...
```

核心配置类型 `OpenClawConfig` 是一个大型嵌套对象，主要包含：

```typescript
interface OpenClawConfig {
  agent: {
    model: string;              // 默认模型，如 "anthropic/claude-opus-4-6"
    thinkingLevel?: string;     // 思考级别
    workspace?: string;         // 工作空间路径
  };
  gateway: {
    port: number;               // 默认 18789
    bind: string;               // "loopback" | "0.0.0.0"
    auth: { mode: string };     // 认证模式
    tailscale?: { ... };        // Tailscale 配置
  };
  channels: {
    telegram?: { botToken: string; ... };
    discord?: { token: string; ... };
    slack?: { botToken: string; appToken: string; ... };
    whatsapp?: { ... };
    signal?: { ... };
    // ... 更多渠道
  };
  browser?: { enabled: boolean; ... };
  // ...
}
```

## 4.4 配置校验

`src/config/validation.ts` 提供配置校验功能：

```typescript
validateConfigObject(config)               // 仅校验核心配置
validateConfigObjectWithPlugins(config)     // 含插件配置校验
```

校验使用 TypeBox 的 `Value.Check()` 进行，错误信息会指出具体的字段路径。

## 4.5 运行时覆盖

`src/config/runtime-overrides.ts` 支持通过环境变量和命令行参数覆盖配置值。例如：

```bash
TELEGRAM_BOT_TOKEN=xxx openclaw gateway   # 环境变量优先于配置文件
```

覆盖优先级：**环境变量 > 命令行参数 > 配置文件 > 默认值**。

## 4.6 Session 管理

Session 配置在 `src/config/sessions/` 下：

```
src/config/sessions/
├── main-session.ts    # Main session key 解析（"main" 是默认的个人 session）
├── store.ts           # Session store 读写（sessions.json）
├── paths.ts           # Session 文件路径
└── types.ts           # SessionEntry 类型定义
```

每个 session 有一个 key（如 `main`、`telegram:+1234567890`、`discord:guild-123:channel-456`），对应一组 AI 对话历史和状态。

## 4.7 本章要点

- 配置文件是 JSON5 格式，存储在 `~/.openclaw/openclaw.json`
- 使用 TypeBox 进行 schema 校验，类型定义严格
- 支持热重载和运行时覆盖（环境变量优先）
- Session 是消息路由的基本单位，每个渠道/群组/用户组合对应一个 session

### 推荐阅读的源文件

| 文件 | 说明 |
|------|------|
| `src/config/io.ts` | 配置加载核心逻辑 |
| `src/config/types.ts` | 配置类型汇总 |
| `src/config/types.agents.ts` | Agent 配置类型（理解 Agent 能力配置） |
| `src/config/types.channels.ts` | 渠道配置类型（理解渠道接入方式） |
| `src/config/sessions/main-session.ts` | Session key 解析逻辑 |
| `src/config/validation.ts` | 配置校验实现 |
