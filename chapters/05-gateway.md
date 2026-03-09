# 第 5 章 Gateway 控制平面

## 5.1 Gateway 的角色

Gateway 是 OpenClaw 的核心运行进程——一个单进程的 WebSocket + HTTP 服务器，是整个系统的中枢。它绑定在 `127.0.0.1:18789`（默认），承载以下职责：

- **WebSocket 控制平面**：所有客户端通过 WS 连接，双向通信
- **渠道连接管理**：维护与十几种聊天平台的长连接
- **HTTP 服务**：提供 Control UI、WebChat、Webhook 端点
- **Session 生命周期管理**：创建、路由、紧凑化、销毁
- **插件运行时**：加载和管理扩展插件
- **定时任务引擎**：Cron 调度
- **安全边界**：认证、DM pairing、rate limiting

## 5.2 服务器启动：`server.impl.ts`

`startGatewayServer`（1065 行）是 Gateway 的主启动函数。通过分析其 import 列表和初始化顺序，可以看出 Gateway 的"组装过程"——它像一个微内核，按顺序接入各个子系统：

### 启动顺序（简化）

```
1.  loadConfig()                    — 加载配置
2.  migrateLegacyConfig()           — 迁移旧版配置
3.  ensureGatewayStartupAuth()      — 确保认证配置有效
4.  createAuthRateLimiter()         — 创建认证限速器
5.  loadGatewayModelCatalog()       — 加载模型目录
6.  createPluginRuntime()           — 初始化插件运行时
7.  loadGatewayPlugins()            — 加载所有插件
8.  createChannelManager()          — 创建渠道管理器
9.  initSubagentRegistry()          — 初始化子 Agent 注册表
10. startHeartbeatRunner()          — 启动心跳检测
11. buildGatewayCronService()       — 构建 Cron 服务
12. attachGatewayWsHandlers()       — 挂载 WS 消息处理
13. startChannelHealthMonitor()     — 启动渠道健康监控
14. startGatewayConfigReloader()    — 启动配置热重载
15. startGatewayDiscovery()         — 启动 Bonjour/mDNS 发现
16. startGatewayTailscaleExposure() — 配置 Tailscale 暴露
17. startGatewaySidecars()          — 启动浏览器等 sidecar
18. runBootSequence()               — 执行 BOOT.md
```

这个顺序是精心设计的——认证和模型必须在渠道连接之前就绪，插件在渠道之前加载（因为扩展渠道是插件），健康监控在渠道之后启动（需要监控对象存在）。

### 子系统模块化

Gateway 的实现拆分到十几个 `server-*.ts` 文件中：

| 文件 | 职责 |
|------|------|
| `server.impl.ts` | 主启动函数，组装所有子系统 |
| `server-channels.ts` | 渠道管理（连接、断开、状态） |
| `server-chat.ts` | 聊天事件处理（消息入站路由） |
| `server-close.ts` | 优雅关闭处理 |
| `server-cron.ts` | Cron 定时任务服务 |
| `server-discovery-runtime.ts` | Bonjour/mDNS 设备发现 |
| `server-lanes.ts` | 并发 lane 配置 |
| `server-maintenance.ts` | 维护定时器（清理、健康刷新） |
| `server-methods.ts` | WS 方法处理器注册 |
| `server-methods-list.ts` | WS 方法/事件列表 |
| `server-model-catalog.ts` | 模型目录加载 |
| `server-plugins.ts` | 插件加载 |
| `server-reload-handlers.ts` | 配置重载处理 |
| `server-runtime-config.ts` | 运行时配置解析 |
| `server-runtime-state.ts` | 运行时状态管理 |
| `server-session-key.ts` | Session key 解析 |
| `server-startup.ts` | Sidecar 启动（浏览器等） |
| `server-tailscale.ts` | Tailscale 暴露配置 |
| `server-ws-runtime.ts` | WebSocket 运行时处理 |
| `server-wizard-sessions.ts` | 向导 session 追踪 |

这种拆分让每个子系统可以独立测试和维护，同时 `server.impl.ts` 作为"组装工厂"将它们连接起来。

## 5.3 WebSocket 协议

Gateway 的 WS 协议是 JSON-based 的 RPC 风格，带有事件推送。

### 方法类型

**客户端 → Gateway（请求）**：

| 方法 | 说明 |
|------|------|
| `chat.send` | 发送消息给 Agent |
| `chat.abort` | 中止正在进行的 Agent 回复 |
| `sessions.patch` | 更新 session 设置（model, thinkingLevel, verboseLevel 等）|
| `sessions.list` | 列出所有 session |
| `config.get` / `config.set` | 配置读写 |
| `node.list` / `node.describe` / `node.invoke` | 设备节点操作 |
| `channels.status` | 渠道状态查询 |

**Gateway → 客户端（事件推送）**：

| 事件 | 说明 |
|------|------|
| `agent.text` | Agent 文本输出（流式） |
| `agent.tool_start` / `agent.tool_end` | 工具调用开始/结束 |
| `agent.thinking` | Agent 推理过程 |
| `channel.status` | 渠道状态变化 |
| `presence.update` | 在线状态变化 |
| `health.update` | 健康状态更新 |

### 连接认证

`connection-auth.ts` 实现三种认证模式：

1. **Token 认证**：连接时携带 session token，验证后建立身份
2. **Password 认证**：用于 Tailscale Funnel（公网暴露）场景，连接时需要密码
3. **Tailscale 身份**：在 tailnet 内部时，可信任 Tailscale 提供的身份 header

`auth-rate-limit.ts` 对认证尝试进行限速，防止暴力破解。

## 5.4 优雅关闭

`server-close.ts` 实现 Gateway 的优雅关闭流程：

```
1. 停止接受新连接
2. 等待所有 pending ReplyDispatcher 完成（getTotalPendingReplies）
3. 等待所有活跃 Agent 运行结束（getActiveEmbeddedRunCount）
4. 等待所有命令队列清空（getTotalQueueSize）
5. 运行插件的 gateway_stop hook
6. 关闭所有渠道连接
7. 停止 Cron 服务
8. 停止 Tailscale 暴露
9. 清理临时文件
10. 关闭 HTTP/WS 服务器
```

关键设计：`setPreRestartDeferralCheck` 注册了一个检查函数，在 SIGUSR1（重启信号）到达时，不立即重启，而是先检查是否有 pending 工作。只有当所有工作完成后才执行重启。

## 5.5 渠道健康监控

**`channel-health-monitor.ts`**：定期轮询各渠道的健康状态。

**`channel-health-policy.ts`**：定义健康策略。例如：
- WhatsApp 连接断开超过 60 秒 → 标记为 unhealthy → 尝试重连
- Telegram bot 无法收发消息 → 标记为 degraded → 触发告警

**`channel-status-patches.ts`**：当渠道状态变化时，生成 JSON Patch 格式的增量更新，通过 WS 推送给所有连接的客户端。Control UI 据此实时更新渠道状态面板。

## 5.6 配置热重载

**`config-reload.ts`**：监听 `~/.openclaw/openclaw.json` 的文件变化。

**`config-reload-plan.ts`**：重载时不是暴力全部重启，而是生成一个**增量重载计划**：

```
对比 oldConfig 和 newConfig：
├── 渠道 A：配置未变 → skip
├── 渠道 B：token 变了 → 断开重连
├── 渠道 C：新增 → 初始化连接
├── 渠道 D：删除 → 断开并清理
└── Gateway 参数变了 → 就地更新（无需重启）
```

这个 diff-based 机制避免了不必要的渠道重连——如果你只是改了 Discord 的 token，Telegram 连接不应该受影响。

## 5.7 Control UI 与 WebChat

Gateway 内嵌了完整的 Web 管理界面：

```
control-ui.ts              # 主路由入口
control-ui-routing.ts      # URL → 处理器的路由映射
control-ui-csp.ts          # Content Security Policy 设置
control-ui-http-utils.ts   # HTTP 工具函数
control-ui-shared.ts       # 前后端共享状态
control-ui-contract.ts     # API 接口契约（前后端类型共享）
```

Control UI 和 WebChat 都是静态文件，构建后放在 `ui/dist/`。Gateway 的 HTTP 服务直接 serve 这些文件，不需要 Nginx 或其他 Web 服务器。

**CSP 配置**（`control-ui-csp.ts`）确保 UI 页面只能加载来自 Gateway 自身的资源，防止 XSS 攻击。`maybeSeedControlUiAllowedOriginsAtStartup` 在启动时配置允许的 CORS origin。

## 5.8 Boot Sequence

Gateway 启动的最后一步是执行 `BOOT.md`（`gateway/boot.ts`）。这是一个用户可定制的启动脚本：

```markdown
<!-- ~/.openclaw/workspace/BOOT.md -->
Send a message to my Telegram saying "🦞 OpenClaw is online!"
Check if there are any unread messages from the last hour.
```

Boot 的实现利用了 Agent 本身——它创建一个临时的 boot session，用 Agent 执行 BOOT.md 中的指令。执行完毕后恢复正常 session 状态。如果 BOOT.md 不存在或为空，则跳过。

## 5.9 设备发现与节点注册

**`server-discovery-runtime.ts`**：通过 Bonjour/mDNS 广播 Gateway 的存在，让 iOS/Android 节点能自动发现。

**`node-registry.ts`**：维护已连接的设备节点注册表。每个节点通过 WS 连接，广播自己的能力（摄像头、屏幕录制、Canvas 等）。Agent 通过 `node.invoke` 调用这些能力。

## 5.10 本章要点

- Gateway 是一个"微内核 + 子系统组装"架构，启动时按依赖顺序接入 18+ 个子系统
- WS 协议提供 RPC 方法调用和事件推送两种通信模式
- 优雅关闭等待所有 pending 工作完成，不丢失用户消息
- 配置热重载使用 diff-based 增量计划，避免不必要的渠道重连
- Boot sequence 利用 Agent 自身执行用户定义的启动脚本

### 推荐阅读的源文件

| 文件 | 优先级 | 行数 | 说明 |
|------|--------|------|------|
| `src/gateway/server.impl.ts` | ★★★ | 1065 | 主启动函数，理解整体架构 |
| `src/gateway/server-channels.ts` | ★★ | - | 渠道管理 |
| `src/gateway/server-close.ts` | ★★ | - | 优雅关闭 |
| `src/gateway/config-reload.ts` | ★★ | - | 配置热重载 |
| `src/gateway/config-reload-plan.ts` | ★★ | - | 增量重载计划 |
| `src/gateway/connection-auth.ts` | ★ | - | 连接认证 |
| `src/gateway/boot.ts` | ★ | - | Boot sequence |
| `src/gateway/server-methods.ts` | ★ | - | WS 方法处理器 |
