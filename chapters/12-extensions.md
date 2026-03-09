# 第 12 章 Extension 扩展机制

## 12.1 Extension vs 核心渠道的设计边界

OpenClaw 将渠道分为"核心"（`src/` 下直接编译）和"扩展"（`extensions/` 下独立 package）。设计边界的判断标准：

- **使用频率**：WhatsApp/Telegram/Discord/Slack 使用最广，放核心
- **依赖权重**：Matrix 依赖 `matrix-js-sdk`（很重），放扩展
- **维护模式**：核心渠道由主维护者维护，扩展可以由社区维护
- **可选性**：核心渠道零配置可用，扩展需要显式安装

## 12.2 Extension 的 Package 结构

每个 extension 是一个独立的 npm package，遵循固定的目录结构：

```
extensions/matrix/
├── package.json           # 独立依赖
│   ├── dependencies       # matrix-js-sdk 等（运行时）
│   ├── devDependencies    # openclaw: "workspace:*"（开发时）
│   └── peerDependencies   # openclaw: "*"（运行时通过 jiti 解析）
├── src/
│   ├── index.ts          # 插件入口，导出 plugin 注册函数
│   ├── channel.ts        # 渠道 adapter 实现
│   ├── setup.ts          # 初始化逻辑
│   ├── outbound.ts       # 发送消息
│   ├── inbound.ts        # 接收消息
│   ├── config.ts         # 配置 schema
│   └── types.ts          # 类型定义
└── tsconfig.json
```

**依赖管理的巧妙设计**：

```json
{
  "peerDependencies": { "openclaw": "*" },         // npm install 时不装
  "devDependencies": { "openclaw": "workspace:*" } // 开发时用 workspace 链接
}
```

为什么用 `peerDependencies` 而不是 `dependencies`？因为运行时 OpenClaw 通过 `jiti`（运行时 TypeScript 加载器）解析 `openclaw/plugin-sdk` 的引用，不需要在 extension 的 `node_modules` 中实际安装 `openclaw`。而 `workspace:*` 在 `dependencies` 中会导致 `npm install` 失败（`workspace:` 协议是 pnpm 特有的）。

## 12.3 插件加载机制

`src/plugins/` 实现了完整的插件生命周期管理：

### 发现阶段

`discovery.ts` 扫描可能的插件来源：

```
1. extensions/ 目录下的所有子目录
2. node_modules 中带有 openclaw-plugin 标识的包
3. 配置中显式指定的插件路径
```

发现后检查每个候选的 `package.json` 是否有插件标识字段。

### 加载阶段

`enable.ts` 按以下流程加载插件：

```
1. 检查配置中是否启用该插件（某些插件需要显式 opt-in）
2. 安装运行时依赖（npm install --omit=dev）
3. 动态 import 插件入口模块
4. 调用插件导出的注册函数
5. 注册 channel adapters 到渠道注册表
6. 注册 hooks 到 hook runner
7. 注册 config schema 到校验器
```

### Config Schema 注册

`config-schema.ts`：每个插件可以注册自己的配置 schema。加载后，OpenClaw 的配置校验会包含插件的字段，用户在 `openclaw.json` 中写的插件配置也能被正确校验。

```typescript
// 核心校验
validateConfigObject(config);                    // 只校验核心字段
// 含插件校验
validateConfigObjectWithPlugins(config);          // 核心 + 所有已加载插件的字段
```

## 12.4 Extension 分类详解

### 渠道扩展（最多）

30+ 个渠道覆盖各种通信平台：

**企业通信**：MS Teams, Slack (扩展), Google Chat, Mattermost, Nextcloud Talk
**即时通讯**：Matrix, BlueBubbles (iMessage), Zalo, Zalo Personal, Line, Feishu
**社交/社区**：Discord (扩展), Twitch, IRC, Nostr, Tlon
**其他**：Synology Chat, Voice Call

### 功能扩展

- **`diffs/`** (9.5MB)：差异对比工具，是最大的扩展
- **`open-prose/`** (758KB)：写作增强
- **`llm-task/`**：LLM 任务编排
- **`acpx/`**：Agent Control Protocol 扩展

### 记忆扩展

- **`memory-core/`**：记忆系统核心接口
- **`memory-lancedb/`**：LanceDB 向量存储后端

记忆是一个特殊的插件槽位——同一时间只能有一个记忆插件激活。

### 认证扩展

- **`google-gemini-cli-auth/`**：Gemini CLI OAuth 认证
- **`minimax-portal-auth/`**：MiniMax Portal 认证
- **`qwen-portal-auth/`**：通义千问 Portal 认证
- **`copilot-proxy/`**：GitHub Copilot 代理认证

## 12.5 Hook 系统

插件通过 hook 系统在 Agent 生命周期的关键节点介入。`src/hooks/` 定义了所有可用的 hook 点：

### Hook 时序图

```
消息到达
  → message_received hook          ← 插件可以记录/过滤
    → before_model_resolve hook    ← 插件可以覆盖模型
      → before_agent_start hook    ← 插件可以修改 prompt
        → before_prompt_build hook ← 插件可以注入上下文
          → [LLM 调用]
            → before_tool_call hook  ← 插件可以审批/阻止工具调用
              → [工具执行]
            → after_tool_call hook   ← 插件可以处理结果
          → [回复生成]
        → after_agent_end hook     ← 插件可以后处理
      → gateway_stop hook          ← Gateway 关闭时清理
```

所有入站 hook（message_received）是 **fire-and-forget** 的——不阻塞主流程。模型和工具相关的 hook 是**同步阻塞**的——可以影响执行路径。

### Hook Runner

`plugins/hook-runner-global.ts` 维护全局 hook runner：

```typescript
const hookRunner = getGlobalHookRunner();

// 检查是否有插件注册了特定 hook
if (hookRunner?.hasHooks("before_model_resolve")) {
  const override = await hookRunner.runBeforeModelResolve(event, ctx);
}
```

`hasHooks` 检查避免了在没有任何插件监听时的无谓调用。

## 12.6 开发新 Extension 的完整流程

```bash
# 1. 创建目录
mkdir extensions/my-channel
cd extensions/my-channel

# 2. 初始化 package.json
npm init -y
# 设置 peerDependencies、devDependencies

# 3. 实现 Plugin SDK 接口
# src/index.ts → 导出注册函数
# src/channel.ts → 实现 adapters

# 4. 注册配置 schema
# src/config.ts → TypeBox schema

# 5. 安装依赖
cd ../.. && pnpm install

# 6. 在配置中启用
# openclaw.json → channels.my-channel.enabled = true

# 7. 测试
pnpm test extensions/my-channel
```

## 12.7 本章要点

- Extension 通过 `peerDependencies` + `jiti` 运行时解析实现依赖管理
- 插件加载经历发现 → 安装 → import → 注册的完整生命周期
- 每个插件可以注册自己的配置 schema，与核心校验集成
- Hook 系统分入站（fire-and-forget）和执行路径（同步阻塞）两种模式
- 30+ 个扩展覆盖渠道、功能、记忆、认证四大类

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/plugins/discovery.ts` | ★★★ | 插件发现机制 |
| `src/plugins/enable.ts` | ★★ | 插件加载流程 |
| `src/plugins/hook-runner-global.ts` | ★★ | Hook 运行器 |
| `src/plugins/config-schema.ts` | ★ | 配置 schema 注册 |
| `extensions/matrix/src/index.ts` | ★ | 一个典型扩展入口 |
