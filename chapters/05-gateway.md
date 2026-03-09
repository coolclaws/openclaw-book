# 第 5 章 Gateway 控制平面

## 5.1 Gateway 的角色

Gateway 是 OpenClaw 的核心运行进程——一个单进程的 WebSocket + HTTP 服务器，是整个系统的"神经中枢"。它默认绑定在 `127.0.0.1:18789`，承载以下职责：

- **WebSocket 控制平面**：所有客户端（TUI、Control UI、WebChat、移动端）通过 WS 连接，双向通信
- **渠道连接管理**：维护与十几种聊天平台的长连接
- **HTTP 服务**：Control UI、WebChat、Webhook 端点
- **Session 生命周期管理**：创建、路由、compact、销毁
- **插件运行时**：加载和管理扩展插件，提供 Hook 系统
- **Cron 调度引擎**：定时任务的注册、触发、回调
- **安全边界**：连接认证、DM pairing、rate limiting
- **设备节点注册**：iOS/Android 配对节点的能力发现与调用

---

## 5.2 服务器启动：`server.impl.ts`

`startGatewayServer`（1065 行）是 Gateway 的主启动函数。通过分析其初始化顺序，可以看出一个精心设计的**依赖拓扑**——后启动的系统可能依赖先启动的系统，每一步都有明确的前置条件。

### 启动顺序（18 个阶段）

```
阶段 1：loadConfig()
         → 读取 ~/.openclaw/openclaw.json

阶段 2：migrateLegacyConfig()
         → 迁移旧版配置格式（向后兼容）

阶段 3：ensureGatewayStartupAuth()
         → 确认至少有一个有效的认证配置
         → 无有效 auth → 启动向导流程

阶段 4：createAuthRateLimiter()
         → 为 WS 连接认证创建限速器（防暴力破解）

阶段 5：loadGatewayModelCatalog()
         → 加载内置模型目录 + 动态发现（Ollama 等）

阶段 6：createPluginRuntime()
         → 初始化插件沙箱环境

阶段 7：loadGatewayPlugins()
         → 扫描 ~/.openclaw/plugins/ 目录
         → 依次加载插件，注册 Hook、工具、渠道、HTTP 路由

阶段 8：createChannelManager()
         → 初始化渠道管理器（尚未建立渠道连接）

阶段 9：initSubagentRegistry()
         → 恢复持久化的子 Agent 注册表
         → 继续处理崩溃前未完成的 announce

阶段 10：startHeartbeatRunner()
          → 启动定期心跳 session（检查邮件/日历等）

阶段 11：buildGatewayCronService()
          → 构建 Cron 调度服务
          → 从 ~/.openclaw/cron.json 恢复已注册的任务

阶段 12：attachGatewayWsHandlers()
          → 挂载所有 WS 消息处理器
          → 开始接受客户端连接（Gateway 正式"在线"）

阶段 13：startChannelHealthMonitor()
          → 渠道连接初始化（实际建立与各平台的连接）
          → 启动健康轮询（WhatsApp 断连检测等）

阶段 14：startGatewayConfigReloader()
          → 监听配置文件变化（inotify/FSEvents）
          → 配置变更触发增量重载计划

阶段 15：startGatewayDiscovery()
          → Bonjour/mDNS 广播 Gateway 地址
          → iOS/Android 节点自动发现

阶段 16：startGatewayTailscaleExposure()
          → 配置 Tailscale Funnel 暴露（可选）

阶段 17：startGatewaySidecars()
          → 启动浏览器 sidecar（Chrome/Chromium 实例）
          → 启动其他辅助进程

阶段 18：runBootSequence()
          → 执行 BOOT.md（用户定义的启动脚本）
```

**依赖关系的关键约束：**
- 阶段 6（Plugin Runtime）必须在阶段 7（加载插件）之前
- 阶段 7（插件）必须在阶段 8（渠道管理器）之前——插件可以注册额外渠道
- 阶段 12（WS 处理器）在阶段 13（渠道连接）之前——保证客户端连接时渠道已就绪
- 阶段 9（Subagent Registry）必须在 WS 之前——否则子 Agent 完成事件可能丢失

### 模块拆分策略

`server.impl.ts` 是 Gateway 的"组装工厂"，具体实现拆分到 19 个 `server-*.ts` 文件：

| 文件 | 行数 | 职责 |
|------|------|------|
| `server.impl.ts` | 1065 | 主启动函数，组装所有子系统 |
| `server-channels.ts` | — | 渠道连接、断开、状态查询 |
| `server-chat.ts` | — | 聊天事件入站路由 |
| `server-close.ts` | — | 优雅关闭流程 |
| `server-cron.ts` | — | Cron 定时任务服务 |
| `server-discovery-runtime.ts` | — | Bonjour/mDNS 设备发现 |
| `server-lanes.ts` | — | 并发 Lane 配置 |
| `server-maintenance.ts` | — | 维护定时器（清理、健康刷新）|
| `server-methods.ts` | — | WS 方法处理器注册 |
| `server-methods-list.ts` | — | 所有 WS 方法/事件的枚举 |
| `server-model-catalog.ts` | — | 模型目录加载与合并 |
| `server-plugins.ts` | — | 插件加载逻辑 |
| `server-reload-handlers.ts` | — | 配置重载事件处理 |
| `server-runtime-config.ts` | — | 运行时配置解析 |
| `server-runtime-state.ts` | — | 全局运行时状态（活跃运行数、pending 队列等）|
| `server-session-key.ts` | — | Session key 解析与规范化 |
| `server-startup.ts` | — | Sidecar 进程启动 |
| `server-tailscale.ts` | — | Tailscale Funnel 配置 |
| `server-ws-runtime.ts` | — | WebSocket 运行时（消息接收、广播）|
| `server-wizard-sessions.ts` | — | 初始化向导 Session 追踪 |

---

## 5.3 WebSocket 协议

Gateway 的 WS 协议是 JSON-based 的 RPC 风格，支持请求/响应和事件推送两种通信模式。

### 客户端 → Gateway（请求方法）

| 方法 | 说明 |
|------|------|
| `chat.send` | 发送消息给 Agent |
| `chat.abort` | 中止正在进行的 Agent 回复 |
| `sessions.patch` | 更新 session 设置（model、thinkingLevel、verboseLevel 等）|
| `sessions.list` | 列出所有 session |
| `sessions.compact` | 手动触发 session compaction |
| `sessions.reset` | 重置 session 历史 |
| `config.get` / `config.set` | 配置读写 |
| `node.list` / `node.describe` / `node.invoke` | 配对设备节点操作 |
| `channels.status` | 渠道状态查询 |
| `cron.list` / `cron.add` / `cron.remove` | Cron 任务管理 |
| `subagents.list` / `subagents.kill` | 子 Agent 管理 |

### Gateway → 客户端（事件推送）

| 事件 | 说明 |
|------|------|
| `agent.text` | Agent 文本输出（流式，每个 chunk 一个事件）|
| `agent.tool_start` | 工具调用开始（含工具名和参数）|
| `agent.tool_end` | 工具调用结束（含结果摘要）|
| `agent.thinking` | Agent 推理过程（仅在 reasoning 开启时）|
| `agent.done` | Agent 本轮回复完成 |
| `channel.status` | 渠道状态变化（connected/disconnected/degraded）|
| `session.updated` | Session 元数据更新 |
| `presence.update` | 在线状态变化 |
| `health.update` | 系统健康状态更新 |
| `node.event` | 配对设备触发的事件（相机拍照完成等）|

### 连接认证（`connection-auth.ts`）

三种认证模式：

```typescript
// 1. Token 认证（最常用）
// 客户端连接时携带 session token
// token 来自配置的 auth.token 或通过 pairing 流程生成

// 2. Password 认证（Tailscale Funnel 场景）
// 公网暴露时用密码保护，防止未授权访问

// 3. Tailscale 身份（tailnet 内部）
// 在 tailnet 中可信任 Tailscale 提供的 identity header
// 不需要额外认证
```

`auth-rate-limit.ts` 对认证尝试进行限速：同一 IP 在短时间内多次认证失败会被临时封锁。

---

## 5.4 插件系统与 Hook 机制

**文件：** `src/plugins/`

### 插件加载流程

```
扫描 ~/.openclaw/plugins/*/manifest.json
  → 验证 manifest schema（必填字段、版本兼容性）
  → 加载插件入口文件（ESM 动态 import）
  → 调用插件的 setup(runtime) 函数
    → 插件注册 Hook
    → 插件注册工具
    → 插件注册渠道
    → 插件注册 HTTP 路由
  → 插件加载完成
```

### Hook 系统：24 个生命周期钩子

```typescript
type PluginHookName =
  // Agent 生命周期
  | "before_model_resolve"   // 模型选择前（可覆盖模型）
  | "before_prompt_build"    // System prompt 构建前（可注入内容）
  | "before_agent_start"     // Agent 开始前（旧版，保持兼容）
  | "llm_input"              // LLM 请求发出前（可观测请求参数）
  | "llm_output"             // LLM 响应完成后（可观测完整输出）
  | "agent_end"              // Agent 运行结束后
  | "before_compaction"      // Compaction 开始前
  | "after_compaction"       // Compaction 完成后
  | "before_reset"           // Session 重置前

  // 消息生命周期
  | "message_received"       // 消息收到（fire-and-forget，不阻塞）
  | "message_sending"        // 消息即将发出（可修改 payload）
  | "message_sent"           // 消息已发出

  // 工具生命周期
  | "before_tool_call"       // 工具调用前（可阻止）
  | "after_tool_call"        // 工具调用后
  | "tool_result_persist"    // 工具结果写入前（可修改持久化内容）
  | "before_message_write"   // 消息写入 session 文件前（可修改）

  // Session 生命周期
  | "session_start"          // Session 首次创建
  | "session_end"            // Session 结束

  // Sub-agent 生命周期
  | "subagent_spawning"      // 子 Agent 即将派生（可修改参数）
  | "subagent_delivery_target" // 子 Agent 广播目标解析（可覆盖）
  | "subagent_spawned"       // 子 Agent 已派生
  | "subagent_ended"         // 子 Agent 运行结束

  // Gateway 生命周期
  | "gateway_start"          // Gateway 启动（插件初始化后置工作）
  | "gateway_stop";          // Gateway 关闭（清理插件资源）
```

### Hook 优先级

插件注册 hook 时可以指定优先级：

```typescript
runtime.on("before_tool_call", handler, { priority: 10 });
// priority 越高，越早执行
// 默认 priority = 0
// 同优先级按注册顺序执行
```

### 可阻断 vs 观测型 Hook

| Hook 类型 | 例子 | 行为 |
|---------|------|------|
| 可阻断（返回 result）| `before_tool_call`、`message_sending` | 插件可返回 `{ block: true }` 阻止后续执行 |
| 可覆盖（返回覆盖值）| `before_model_resolve`、`message_sending` | 插件可返回新值覆盖默认值 |
| 纯观测（void）| `message_received`、`agent_end` | 只能观测，不影响执行流 |

### 插件 Runtime API

插件通过 `runtime` 对象获得与 Gateway 交互的能力：

```typescript
// 发送消息到渠道
runtime.channel.send({ channel: "discord", to: "#general", message: "..." });

// 读取/写入配置
runtime.config.get();
runtime.config.patch({ ... });

// 注册工具（让 Agent 可以调用）
runtime.tools.register({ name: "my_tool", handler: async (input) => ... });

// 发送系统事件（注入到 session）
runtime.system.sendEvent({ sessionKey, text: "..." });

// 记录日志
runtime.log.info("plugin initialized");
```

---

## 5.5 Cron 调度引擎

**文件：** `src/gateway/server-cron.ts`

Cron 是 Gateway 的定时任务系统，允许周期性或一次性地触发 Agent 执行。

### 调度类型

```typescript
// 固定时间点（one-shot）
{ kind: "at", at: "2026-03-10T09:00:00Z" }

// 固定间隔（recurring）
{ kind: "every", everyMs: 3600000, anchorMs: 1710000000000 }

// Cron 表达式（recurring）
{ kind: "cron", expr: "0 9 * * MON", tz: "Asia/Singapore" }
```

### 任务 Payload 类型

```typescript
// 系统事件（注入到 main session）
{ kind: "systemEvent", text: "检查邮件" }

// Agent 回合（独立 isolated session）
{ kind: "agentTurn", message: "生成今日报告", model: "anthropic/claude-haiku-3-5" }
```

`sessionTarget = "main"` 时只允许 `systemEvent`；`sessionTarget = "isolated"` 时使用 `agentTurn`（独立运行，完成后 announce 回主 session）。

### 持久化与恢复

Cron 任务持久化到 `~/.openclaw/cron.json`。Gateway 重启后在阶段 11 恢复所有任务，并检查在停机期间应该触发但未触发的任务是否需要补触发（`runMode: "due"`）。

---

## 5.6 优雅关闭

**文件：** `src/gateway/server-close.ts`

```
收到 SIGTERM / SIGINT
  ↓
停止接受新的 WS 连接
  ↓
等待 pending ReplyDispatcher 完成（getTotalPendingReplies）
  ↓
等待活跃 Agent 运行结束（getActiveEmbeddedRunCount）
  ↓
等待命令队列清空（getTotalQueueSize）
  ↓
运行 gateway_stop hook（插件清理）
  ↓
关闭所有渠道连接
  ↓
停止 Cron 服务
  ↓
停止 Tailscale 暴露
  ↓
清理临时文件、容器等
  ↓
关闭 HTTP/WS 服务器
```

**`setPreRestartDeferralCheck`**：SIGUSR1（热更新信号）到达时，不立即重启，而是注册一个 deferral check 函数，等所有 pending 工作完成后才执行重启。这确保热更新不会截断用户正在接收的回复。

---

## 5.7 渠道健康监控

**文件：** `src/gateway/channel-health-monitor.ts`

```
定期轮询（configurable interval）
  ↓
对每个渠道调用 healthCheck()
  ↓
  └─ connected：连接正常
  └─ degraded：功能受限（如只能收不能发）
  └─ disconnected：连接断开
  └─ reconnecting：正在重连
  ↓
状态变化 → channel-status-patches.ts
  → 生成 JSON Patch 增量
  → 通过 WS 广播给所有连接的客户端
  → Control UI 实时更新渠道状态
```

**`channel-health-policy.ts`** 定义每种渠道的健康策略：
- WhatsApp 断连 > 60s → 触发自动重连
- Telegram bot 消息发送失败 → 标记为 degraded
- Discord 心跳超时 → 标记为 disconnected → 重建 WS 连接

---

## 5.8 配置热重载

**文件：** `src/gateway/config-reload.ts`

监听 `~/.openclaw/openclaw.json` 的文件变化（inotify/FSEvents）。

**`config-reload-plan.ts`** 生成**增量重载计划**，避免不必要的渠道重连：

```
对比 oldConfig 和 newConfig：

渠道 A：配置未变         → skip（不动）
渠道 B：token 变了       → disconnect → reconnect（保留配置）
渠道 C：新增             → initialize → connect（全新）
渠道 D：已删除           → disconnect → cleanup
Gateway 全局参数变了      → in-place update（无需重启）
模型配置变了             → reload model catalog
```

**为什么是增量而不是全量重载？**

全量重载意味着所有渠道断线重连——在高流量场景下，这会导致消息丢失（断线期间的消息不会重传）。增量计划只影响实际变化的部分。

---

## 5.9 Control UI 与 WebChat

**文件：** `src/gateway/control-ui.ts`

```
control-ui.ts              # HTTP 路由入口
control-ui-routing.ts      # URL → 处理器映射
control-ui-csp.ts          # Content Security Policy
control-ui-http-utils.ts   # HTTP 工具（ETag、Cache-Control 等）
control-ui-shared.ts       # 前后端共享状态
control-ui-contract.ts     # API 接口契约（类型共享）
```

Control UI 和 WebChat 是静态文件（`ui/dist/`），Gateway 的 HTTP 服务直接 serve，不需要 Nginx。

**CSP 配置**防止 XSS：UI 页面只能加载来自 Gateway 自身的资源。`maybeSeedControlUiAllowedOriginsAtStartup` 在启动时配置允许的 CORS origin（适配 Control UI 在不同端口访问的场景）。

---

## 5.10 Boot Sequence

**文件：** `src/gateway/boot.ts`

Gateway 启动的最后一步执行 `BOOT.md`。这是一个用户定义的启动脚本：

```markdown
<!-- ~/.openclaw/workspace/BOOT.md -->
Send a message to Telegram saying "🦞 OpenClaw is online!"
Check for unread emails from the last 2 hours.
```

**实现原理：** 利用 Agent 本身执行脚本——创建一个临时 boot session，让 Agent 执行 BOOT.md 的指令，执行完毕后 session 销毁。BOOT.md 不存在或为空时跳过。

---

## 5.11 设备节点注册

**文件：** `src/gateway/node-registry.ts`

每个配对的 iOS/Android 节点通过 WS 连接到 Gateway，并广播自己的能力集：

```typescript
type NodeCapabilities = {
  camera?: { front: boolean; back: boolean };
  screen?: boolean;          // 屏幕录制
  photos?: boolean;          // 相册访问
  location?: boolean;        // 定位
  notifications?: boolean;   // 推送通知
  canvas?: boolean;          // Canvas 渲染
  run?: boolean;             // 远程命令执行
};
```

`node.invoke` WS 方法让 Agent 可以远程调用节点能力：

```
Agent 调用 nodes(action="camera_snap")
  → node.invoke 发送到对应设备
  → 设备拍照
  → 图片通过 WS 回传到 Gateway
  → Agent 收到图片作为工具结果
```

**设备发现：** `server-discovery-runtime.ts` 通过 Bonjour/mDNS 广播 Gateway 地址，新节点无需手动配置 IP 即可自动发现 Gateway。

---

## 5.12 本章要点

Gateway 是一个**微内核 + 子系统组装**架构。核心设计决策：

| 设计点 | 解决的问题 |
|-------|---------|
| 18 阶段有序启动 | 依赖关系清晰，避免系统初始化竞态 |
| 19 个 server-*.ts 模块 | 关注点分离，每个子系统独立可测 |
| 24 个 Plugin Hook | 插件在不修改核心代码的前提下扩展任意生命周期 |
| 增量配置重载 | 配置变更只影响实际改变的渠道，不影响其他 |
| 优雅关闭等待 pending | 热更新和关闭时不截断用户消息 |
| Deferral Check 机制 | SIGUSR1 热更新在 pending 工作完成后才执行 |

### 推荐阅读的源文件

| 文件 | 优先级 | 行数 | 说明 |
|------|--------|------|------|
| `src/gateway/server.impl.ts` | ★★★ | 1065 | 主启动函数，全局依赖拓扑 |
| `src/gateway/server-close.ts` | ★★★ | — | 优雅关闭 + Deferral Check |
| `src/gateway/config-reload-plan.ts` | ★★★ | — | 增量配置重载算法 |
| `src/gateway/server-channels.ts` | ★★ | — | 渠道管理 |
| `src/gateway/server-cron.ts` | ★★ | — | Cron 调度引擎 |
| `src/gateway/channel-health-monitor.ts` | ★★ | — | 渠道健康监控 |
| `src/plugins/hooks.ts` | ★★★ | — | Hook 系统完整定义 |
| `src/plugins/types.ts` | ★★ | — | 所有 Hook 类型（24 个）|
| `src/gateway/connection-auth.ts` | ★ | — | WS 连接认证 |
| `src/gateway/node-registry.ts` | ★ | — | 设备节点注册 |
| `src/gateway/boot.ts` | ★ | — | Boot sequence |
