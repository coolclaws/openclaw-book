# 第 10 章 工具策略与沙箱

## 10.1 工具授权的问题

工具是 Agent 与外界交互的唯一通道。哪些工具可以用、谁能用、在什么场景下用——这些问题不是"全开或全关"的二选一，而是需要精细的分层授权。OpenClaw 用一套**多层策略管道（Policy Pipeline）**来解决这个问题。

## 10.2 工具的六个来源

工具从六个来源汇聚到同一个工具集：

```
Pi coding tools        → bash, read, write, edit, process, apply_patch, glob
OpenClaw core tools    → message, cron, gateway, canvas, nodes, session_status,
                         tts, image, pdf, web_search, web_fetch, browser
Channel tools          → discord_send/react/..., telegram_send/...,
                         slack_post/..., whatsapp_*
Plugin tools           → 各扩展插件注册的自定义工具
SDK tools              → sessions_send/list/history/spawn,
                         subagents, memory_search, memory_get
Sub-agent tools        → subagents-tool（仅 main session 有）
```

这六层工具在汇聚后，经过**策略管道**过滤，最终形成当次请求可用的工具集。

---

## 10.3 工具组（Tool Groups）

**文件：** `src/agents/tool-policy-shared.ts`

工具按功能分组，策略中可以直接引用组名，而不必逐个列举工具名：

```typescript
const TOOL_GROUPS = {
  all: [...],              // 全部工具
  core: [...],             // Pi 核心（bash, read, write, edit, process...）
  messaging: [...],        // 消息发送相关
  channels: [...],         // 各渠道特有工具
  memory: [...],           // 记忆相关（memory_search, memory_get）
  sessions: [...],         // session 管理（sessions_send, sessions_list...）
  subagents: [...],        // 子 Agent 管理
  browser: [...],          // 浏览器工具
  canvas: [...],           // Canvas 工具
  nodes: [...],            // 节点管理
  cron: [...],             // 定时任务
  gateway: [...],          // Gateway 管理
};
```

配置示例：

```json
{
  "toolPolicy": {
    "allow": ["core", "memory", "messaging"],
    "deny": ["gateway", "nodes"]
  }
}
```

---

## 10.4 策略管道（Policy Pipeline）

**文件：** `src/agents/tool-policy-pipeline.ts`

管道由多个步骤组成，每个步骤是一层策略：

```typescript
type ToolPolicyPipelineStep = {
  policy: { allow?: string[]; deny?: string[] } | undefined;
  label: string;                        // 调试标识
  stripPluginOnlyAllowlist?: boolean;  // 是否剥离仅插件工具的白名单
};
```

### 默认管道步骤（优先级从低到高）

```typescript
buildDefaultToolPolicyPipelineSteps({
  globalPolicy,          // 全局策略（最低优先级）
  globalProviderPolicy,  // 全局 × provider 级策略
  agentPolicy,           // agent 级策略
  agentProviderPolicy,   // agent × provider 级策略
  groupPolicy,           // 群组 session 策略
  profilePolicy,         // auth profile 级策略（最高优先级）
  providerProfilePolicy, // auth profile × provider 级策略
});
```

高优先级的步骤可以完全覆盖低优先级步骤的结论：

```
初始：tools = 全量工具集

for each step（从低到高优先级）：
  if step.policy.allow 存在：
    tools = tools ∩ expandGroups(step.policy.allow)
  if step.policy.deny 存在：
    tools = tools - expandGroups(step.policy.deny)
```

这意味着运营者可以全局开放宽松策略，对特定 auth profile 收紧——高优先级策略会直接覆盖低优先级的结果。

### 插件工具组的特殊处理

插件注册的工具可以被独立引用：

```json
{
  "toolPolicy": {
    "allow": ["core", "plugin:my-discord-bot"]
  }
}
```

`stripPluginOnlyAllowlist` 处理一个边界情况：如果 allow 列表里**只包含插件工具**（忘记也允许核心工具），该步骤的 allow 策略变为 `undefined`（不限制），避免意外封锁所有核心工具。

---

## 10.5 Owner-Only 工具

**文件：** `src/agents/tool-policy.ts`

某些高权限工具只有机器拥有者（owner）可以使用：

```typescript
function isOwnerOnlyToolName(name: string): boolean;

function applyOwnerOnlyToolPolicy(
  tools: AnyAgentTool[],
  senderIsOwner: boolean
): AnyAgentTool[];
```

当 `senderIsOwner = false`（比如消息来自 Discord 群里的非 owner 用户），owner-only 工具从工具集中移除。这类工具通常包括：

- `gateway`（修改 OpenClaw 配置，重启服务）
- 高权限 `exec` 变体（`elevated: true`）
- 某些 node 管理工具（device 配对、远程执行）

---

## 10.6 沙箱（Docker 隔离）

**文件：** `src/agents/sandbox/`

非 main session 可以启用 Docker 沙箱，提供操作系统级隔离。

### 沙箱文件组织

```
src/agents/sandbox/
├── config.ts          # 沙箱配置解析
├── constants.ts       # 默认镜像名、超时等安全常量
├── context.ts         # 沙箱上下文（工作空间路径映射）
├── docker.ts          # Docker 命令执行（run, exec, kill）
├── manage.ts          # 容器管理（列出、清理）
├── runtime-status.ts  # 运行时状态（容器是否存活）
├── tool-policy.ts     # 工具白名单/黑名单（固定，不可被用户覆盖）
└── types.ts           # 类型定义
```

### 沙箱工具策略（固定规则）

沙箱的工具策略是**硬编码的**，不受用户配置影响：

```
允许：bash, process, read, write, edit, apply_patch,
      sessions_list, sessions_history, sessions_send, sessions_spawn

禁止：browser, canvas, nodes, cron, gateway,
      discord_*, telegram_*, slack_*, whatsapp_*（所有渠道工具）
```

沙箱中的 `bash` 工具被替换为只能在 Docker 容器内执行的版本。容器通过 volume 映射访问 workspace 目录，无法访问宿主机其他路径。

### 沙箱生命周期

```
session 创建
  → 启动 Docker 容器（按 config 指定的镜像）
    → 映射 workspace 目录为 volume
      → Agent 执行（所有 bash 命令在容器内运行）
        → session 结束 / 超时
          → 容器停止
            → sandbox-prune 清理（定期清理不活跃容器）
```

### 两种沙箱触发方式

```typescript
const SUBAGENT_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
```

- `inherit`：跟随父 Agent 的沙箱配置（默认）
- `require`：强制启用沙箱（适合执行不可信代码，或处理外部用户提交的任务）

---

## 10.7 群组 Session 的工具策略

当 Agent 在群组聊天（Discord 群、Slack 频道）中运行时，工具策略有额外约束：

- 某些工具被自动降权（如 `exec` 在群组中可能需要审批）
- `gateway` 类高权限工具在群组中通常禁用
- owner-only 工具只对群组中被识别为 owner 的成员开放

`groupPolicy` 步骤在管道中专门处理这类约束。

---

## 10.8 工具策略的调试

管道的每个步骤都有 `label` 字段，出现策略冲突时可以追踪是哪一层规则起了作用：

```
[policy:global]        allow=[core, messaging]
[policy:agent]         deny=[gateway]
[policy:group]         deny=[nodes, canvas]
[policy:profile]       allow=[core]      ← 最终生效：只有 core 工具
```

`applyToolPolicyPipeline` 在 `warn` 回调中记录每层决策结果，方便运营者诊断"为什么 Agent 少了某个工具"。

---

## 10.9 本章要点

- 工具来自六个来源，经过多层策略管道汇聚
- 工具组（Tool Groups）允许批量引用，避免逐个列举
- 策略管道是覆盖式的（高优先级覆盖低优先级），不是追加式的
- Owner-only 工具在非 owner 场景自动从工具集移除
- 沙箱工具策略是硬编码的，不受用户配置影响
- 沙箱通过 Docker volume 映射实现文件系统隔离

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/agents/tool-policy-pipeline.ts` | ★★★ | 策略管道实现 |
| `src/agents/tool-policy-shared.ts` | ★★★ | 工具组定义 + 策略共享逻辑 |
| `src/agents/tool-policy.ts` | ★★ | Owner-only 工具策略 |
| `src/agents/sandbox/tool-policy.ts` | ★★ | 沙箱固定工具策略 |
| `src/agents/sandbox/context.ts` | ★★ | 沙箱上下文（volume 映射）|
| `src/agents/sandbox/docker.ts` | ★ | Docker 命令执行 |
