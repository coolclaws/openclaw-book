# 第 17 章 Browser 控制系统

## 17.1 OpenClaw 的浏览器能力

OpenClaw 内置一套完整的浏览器控制系统，让 Agent 可以：
- 打开网页、截图、提取内容
- 填表、点击、拖拽——完整的 UI 自动化
- 接管用户正在使用的 Chrome tab（Extension Relay 模式）
- 同时管理多个 Chrome Profile（隔离不同用途）

这套系统的实现分三层：**Chrome 进程管理**（启动/连接）→ **CDP 协议层**（控制）→ **Playwright 抽象层**（高级操作）。

---

## 17.2 整体架构

```
┌─────────────────────────────────────────────────────────┐
│  Agent 工具层                                            │
│  browser tool: status/snapshot/screenshot/act/navigate  │
└──────────────────────────┬──────────────────────────────┘
                           │ HTTP
┌──────────────────────────▼──────────────────────────────┐
│  Browser Control Server（端口 18791）                    │
│  HTTP + WebSocket 服务，处理浏览器操作请求                │
│                                                          │
│  routes/: agent.act / agent.snapshot / tabs / basic ...  │
└──────────┬───────────────────────┬──────────────────────┘
           │                       │
┌──────────▼───────┐   ┌───────────▼──────────────┐
│ Playwright 会话   │   │  Chrome Extension Relay   │
│ (pw-session.ts)  │   │  (extension-relay.ts)     │
│ 本地启动的 Chrome │   │  用户现有 Chrome tab       │
└──────────┬───────┘   └───────────┬───────────────┘
           │ CDP                   │ WebSocket relay
           └──────────┬────────────┘
              ┌───────▼────────┐
              │  Chrome / CDP  │
              │  (端口 18800+) │
              └────────────────┘
```

---

## 17.3 Browser Profile：多实例隔离

**文件：** `src/browser/profiles.ts`, `src/browser/config.ts`

OpenClaw 支持多个 Chrome Profile，每个 Profile 是一个独立的 Chrome 实例：

```typescript
type ResolvedBrowserProfile = {
  name: string;
  cdpPort: number;   // CDP 调试端口（18800-18899 范围）
  cdpUrl: string;
  cdpHost: string;
  cdpIsLoopback: boolean;
  color: string;     // 视觉区分色
  driver: "openclaw" | "extension";  // 驱动模式
  attachOnly: boolean;               // 只连接，不启动
};
```

**CDP 端口分配规则：**

```
18800–18899：Chrome Profile CDP 端口（最多 100 个 profile）
18789：Gateway WebSocket（保留）
18790：Bridge Server（保留）
18791：Browser Control Server（保留）
18792–18799：其他服务（canvas 在 18793）
```

端口在 profile 创建时分配并持久化到配置文件，多次启动端口不变。每个 profile 有独立的颜色（用于日志和 UI 区分）。

**两种驱动模式：**

```
driver: "openclaw"  → OpenClaw 自己启动和管理 Chrome 进程
driver: "extension" → 通过 Chrome Extension Relay 接入用户已有的 Chrome
```

---

## 17.4 Chrome Extension Relay

**文件：** `src/browser/extension-relay.ts`

Extension Relay 是 OpenClaw 独特的能力：**接管用户正在使用的 Chrome**，而不是启动新的浏览器实例。

用户安装 OpenClaw 的 Chrome 扩展，点击工具栏图标"附加当前 tab"。OpenClaw 通过扩展建立 WebSocket 连接，从此可以控制那个 tab。

```typescript
type ChromeExtensionRelayServer = {
  host: string;
  bindHost: string;
  port: number;
  baseUrl: string;
  cdpWsUrl: string;               // 中继后的 CDP WebSocket URL
  extensionConnected: () => boolean; // 扩展是否在线
  stop: () => Promise<void>;
};
```

**中继原理：**

```
OpenClaw ←→ RelayServer ←→ Chrome Extension ←→ Chrome CDP
           (WebSocket)    (WebSocket message)   (Chrome DevTools)
```

扩展充当 CDP 代理：OpenClaw 发送 CDP 指令到 RelayServer，RelayServer 转发给扩展，扩展执行并返回结果。对于 OpenClaw 来说，使用体验和控制本地 Chrome 完全一致。

**应用场景：** 用户已登录的网站（无需重新登录）、公司内网页面（VPN 已连接）、已有 session 的 web 应用。

---

## 17.5 Playwright 会话层

**文件：** `src/browser/pw-session.ts`（164 行）

每个 Profile 对应一个 Playwright BrowserContext，`PwSession` 管理其生命周期：

```typescript
// 页面状态跟踪
type PageState = {
  console: BrowserConsoleMessage[];  // console.log 输出
  errors: BrowserPageError[];        // JS 错误
  requests: BrowserNetworkRequest[]; // 网络请求记录
  
  // ARIA 角色引用（用于 act 时精确定位元素）
  roleRefs?: Record<string, { role: string; name?: string; nth?: number }>;
  roleRefsMode?: "role" | "aria";   // 引用模式
  roleRefsFrameSelector?: string;
};
```

**roleRefs 机制：** `snapshot` 操作生成 ARIA 树快照时，同时构建 `roleRefs` 映射表（e1, e2, e3...）。后续 `act` 操作通过引用 ID（如 `ref: "e12"`）定位元素，避免了 CSS selector 在动态页面中易失效的问题。

两种引用模式：
- `role`：基于 ARIA role + name 的 `getByRole` 定位（更语义化）
- `aria`：Playwright 原生 `aria-ref` id（更精确稳定）

---

## 17.6 核心操作

**文件：** `src/browser/pw-tools-core.*.ts`

Playwright 操作层按功能分为多个模块：

### pw-tools-core.interactions — 交互操作

```typescript
// 点击
click(ref, { button?, doubleClick?, modifiers? })

// 文字输入
type(ref, text, { slowly? })

// 按键
press(ref, key)

// 拖拽
drag(startRef, endRef)

// 下拉选择
select(ref, values[])

// 表单填充
fill(ref, value)

// 调整大小
resize(ref, { width, height })
```

### pw-tools-core.snapshot — 页面快照

```typescript
// ARIA 树快照（用于 AI 理解页面结构）
snapshotForAI(options?: { timeout?, track? })
  → { full: string; incremental?: string }
```

`incremental` 模式：只返回自上次快照以来变化的部分，大幅减少 token 消耗。

`track` 参数：指定只跟踪特定区域的变化（如一个列表容器）。

### pw-tools-core.state — 状态查询

```typescript
// 截图
screenshot({ type?, quality?, fullPage? })

// Console 日志
getConsole()

// JS 错误
getErrors()

// 网络请求
getRequests()
```

### pw-tools-core.storage — 存储操作

读写 localStorage、sessionStorage、cookies——通常用于验证会话状态或预填充凭据。

---

## 17.7 Server Context：多 Profile 运行时状态

**文件：** `src/browser/server-context.types.ts`, `src/browser/server-context.ts`

Browser Control Server 的运行时状态：

```typescript
type BrowserServerState = {
  server?: Server | null;
  port: number;
  resolved: ResolvedBrowserConfig;
  profiles: Map<string, ProfileRuntimeState>;
};

type ProfileRuntimeState = {
  profile: ResolvedBrowserProfile;
  running: RunningChrome | null;  // 当前 Chrome 进程
  lastTargetId?: string | null;   // 最近使用的 tab（粘滞选择）
  reconcile?: {
    previousProfile: ResolvedBrowserProfile;
    reason: string;
  } | null;  // 配置变更时的调和信息
};
```

**lastTargetId（粘滞 tab 选择）：**

`snapshot` 和 `act` 操作可以不指定 `targetId`，此时系统使用 `lastTargetId`——上次操作的 tab。这保证了一个连续的 snapshot → act 序列始终操作同一个 tab，不会因为后台 tab 切换而串乱。

---

## 17.8 Browser Tool 的完整操作矩阵

**文件：** `src/agents/tools/browser-tool.ts`

Agent 通过 `browser` 工具访问所有浏览器能力：

| action | 说明 |
|--------|------|
| `status` | 浏览器服务状态、各 profile 是否运行 |
| `start` / `stop` | 启动/停止浏览器 |
| `profiles` | 列出所有 profile |
| `tabs` | 列出当前 tab |
| `open` | 打开新 URL |
| `focus` | 聚焦指定 tab |
| `close` | 关闭 tab |
| `snapshot` | 获取 ARIA 树快照（主要用于 AI 理解）|
| `screenshot` | 截图（PNG / JPEG）|
| `navigate` | 页面导航（`page.goto`）|
| `console` | 读取 console 输出 |
| `act` | 执行交互操作（click / type / press...）|
| `upload` | 文件上传 |
| `dialog` | 处理 alert / confirm / prompt |
| `pdf` | 将页面打印为 PDF |

---

## 17.9 安全：SSRF 防护与 noVNC 认证

**文件：** `src/infra/net/ssrf.ts`, `src/browser/novnc-auth.ts`

浏览器能访问的 URL 默认受 SSRF 策略约束：

```typescript
type SsrFPolicy = {
  blockPrivate?: boolean;   // 阻止访问内网 IP（10.x, 192.168.x, 127.x 等）
  allowHosts?: string[];    // 白名单主机
  denyHosts?: string[];     // 黑名单主机
};
```

防止 Agent 被恶意网页诱导访问内网服务（SSRF 攻击）。

**noVNC 认证：** 当 Browser 以 headful 模式运行且通过 noVNC 暴露时，访问需要携带 Gateway 认证令牌，防止未授权访问桌面。

---

## 17.10 Trace 支持

**文件：** `src/browser/pw-tools-core.trace.ts`

Playwright trace 记录每一步操作的截图、网络请求、DOM 状态，可用于调试失败的自动化任务：

```typescript
startTrace(): Promise<void>
stopTrace(): Promise<{ path: string }>   // 保存为 .zip
```

Trace 文件可在 Playwright Trace Viewer 中回放，逐步查看每个操作的效果。

---

## 17.11 本章要点

Browser 系统的三个关键设计：

1. **多 Profile 隔离**：不同任务用不同 Chrome Profile，端口独立，数据隔离
2. **Extension Relay**：复用用户现有的已登录 Chrome，无需重新认证
3. **ARIA Ref 系统**：基于语义角色而非 CSS selector 定位元素，对动态页面更健壮

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/browser/pw-session.ts` | ★★★ | Playwright 会话，roleRefs 机制 |
| `src/browser/config.ts` | ★★★ | Profile 配置解析，CDP 端口分配 |
| `src/browser/server-context.types.ts` | ★★ | 运行时状态结构 |
| `src/browser/extension-relay.ts` | ★★ | Chrome Extension Relay 实现 |
| `src/browser/pw-tools-core.interactions.ts` | ★★ | 交互操作实现 |
| `src/browser/pw-tools-core.snapshot.ts` | ★★ | ARIA 快照与增量快照 |
| `src/agents/tools/browser-tool.ts` | ★ | Agent 工具层 |
| `src/browser/routes/agent.act.ts` | ★ | act 路由处理 |
