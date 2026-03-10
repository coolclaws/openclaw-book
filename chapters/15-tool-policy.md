# 第 15 章 工具策略

## 15.1 工具授权的问题

工具是 Agent 与外界交互的唯一通道。哪些工具可以用、谁能用、在什么场景下用——这些问题不是"全开或全关"的二选一，而是需要精细的分层授权。OpenClaw 用一套**多层策略管道（Policy Pipeline）**解决这个问题，同时在工具实现层提供安全边界。

## 15.2 工具的六个来源

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

汇聚后经过**策略管道**过滤，再经过模型兼容性过滤（不支持 tool calling 的模型移除所有工具），最终形成当次请求可用的工具集。

---

## 15.3 工具组（Tool Groups）

**文件：** `src/agents/tool-policy-shared.ts`

工具按功能分组，策略中可以直接引用组名：

```typescript
const TOOL_GROUPS = {
  all: [...],       core: [...],      messaging: [...],
  channels: [...],  memory: [...],    sessions: [...],
  subagents: [...], browser: [...],   canvas: [...],
  nodes: [...],     cron: [...],      gateway: [...],
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

插件工具可以通过插件 ID 整体引用：

```json
{ "toolPolicy": { "allow": ["core", "plugin:my-discord-bot"] } }
```

---

## 15.4 策略管道（Policy Pipeline）

**文件：** `src/agents/tool-policy-pipeline.ts`

### 默认管道步骤（优先级从低到高）

```typescript
buildDefaultToolPolicyPipelineSteps({
  globalPolicy,          // 全局策略（最低优先级）
  globalProviderPolicy,  // 全局 × provider 级
  agentPolicy,           // agent 级
  agentProviderPolicy,   // agent × provider 级
  groupPolicy,           // 群组 session 策略
  profilePolicy,         // auth profile 级（最高优先级）
  providerProfilePolicy, // auth profile × provider 级
});
```

应用逻辑：

```
初始：tools = 全量工具集
for each step（低 → 高优先级）：
  if allow 存在 → tools = tools ∩ expandGroups(allow)
  if deny 存在  → tools = tools - expandGroups(deny)
```

高优先级步骤完全覆盖低优先级结论：全局可以开放宽松策略，对特定 auth profile 精准收紧。

### 管道步骤的完整来源

| 步骤 | 来源文件 | 说明 |
|------|---------|------|
| Profile Policy | `tool-policy-shared.ts` | 全局 allow/deny 配置 |
| Group Policy | `pi-tools.policy.ts` | 群组 session 限制 |
| Subagent Policy | `pi-tools.policy.ts` | 子 Agent 工具限制 |
| Sandbox Policy | `sandbox-tool-policy.ts` | Docker 沙箱白名单（见第 12 章）|
| Owner-Only | `tool-policy.ts` | 仅 owner 可用 |
| Message Provider | `pi-tools.ts` | 渠道特定禁用（voice 禁用 tts）|
| Model Provider | `pi-tools.ts` | 模型特定禁用（xAI 禁用 web_search）|

### 策略调试

每个步骤都有 `label` 字段，出现策略冲突时可追踪到具体来源：

```
[policy:global]   allow=[core, messaging]
[policy:agent]    deny=[gateway]
[policy:group]    deny=[nodes, canvas]
[policy:profile]  allow=[core]      ← 最终生效：只有 core 工具
```

---

## 15.5 Owner-Only 工具

**文件：** `src/agents/tool-policy.ts`

```typescript
function applyOwnerOnlyToolPolicy(
  tools: AnyAgentTool[],
  senderIsOwner: boolean
): AnyAgentTool[];
```

`senderIsOwner = false` 时（Discord 群里的非 owner 用户），owner-only 工具自动从工具集移除：

- `gateway`（修改 OpenClaw 配置、重启服务）
- 高权限 `exec`（`elevated: true`）
- 某些 node 管理工具（device 配对、远程执行）

---

## 15.6 核心工具详解

### Bash 工具（最复杂）

Bash 工具需要在两种环境执行：宿主机和 Docker 沙箱。

```
bash-tools.ts                     # 工具定义入口
bash-tools.exec.ts                # 执行核心
bash-tools.exec-host-gateway.ts   # Gateway 宿主机执行
bash-tools.exec-host-node.ts      # 设备节点远程执行
bash-tools.exec-host-shared.ts    # 共享执行逻辑
bash-tools.exec-runtime.ts        # 运行时环境设置
bash-tools.process.ts             # process 工具（进程管理）
bash-process-registry.ts          # 进程注册表
```

**执行审批**（`bash-tools.exec-approval-request.ts`）：高风险命令可配置需要人工确认，审批请求通过 Gateway WS 推送到 macOS app 或 Control UI。

**进程注册表**：追踪所有由 bash 工具启动的子进程，session abort 或运行结束时统一清理。

### Message 工具

```typescript
// 支持跨渠道发送：Agent 在 Telegram 运行，但可发消息到 Discord
{
  action: "send",
  channel: "discord",
  to: "#general",
  message: "任务完成！",
  buttons: [[{ text: "查看详情", url: "https://..." }]]
}
```

支持：跨渠道发送、行内按钮、文件附件、消息轮询创建、消息反应。

### Web 工具集

```
tools/web-search.ts            # 网页搜索
tools/web-fetch.ts             # 获取网页内容
tools/web-guarded-fetch.ts     # 安全 fetch（SSRF 防护）
tools/web-fetch-visibility.ts  # 内容可见性过滤
```

`web-guarded-fetch.ts` 防止 SSRF 攻击，拒绝对内网地址（127.0.0.1、10.x、192.168.x）的请求。

### Session 工具集

```
tools/sessions-send-tool.ts    # 跨 session 发消息
tools/sessions-spawn-tool.ts   # 派生新 session
tools/sessions-list-tool.ts    # 列出活跃 sessions
tools/sessions-history-tool.ts # 获取 session 历史
tools/sessions-access.ts       # 访问控制
```

Session 工具是多 Agent 协作的基础——父 Agent 可以查看子 Agent 的历史，或向另一个 session 发送消息。

### Browser 工具

```
tools/browser-tool.ts          # 浏览器工具主逻辑
tools/browser-tool.actions.ts  # 动作（点击、输入、截图、滚动）
tools/browser-tool.schema.ts   # 动作 schema
```

通过 CDP 协议控制 OpenClaw 管理的 Chrome/Chromium 实例。支持：导航、点击、输入、截图、页面快照、文件上传。

---

## 15.7 工具安全机制

### Before Tool Call Hook

```typescript
wrapToolWithBeforeToolCallHook(tool, {
  hookRunner, sessionKey, agentId,
  onBlock: () => { /* 记录被阻止的调用 */ }
});
```

插件通过 `before_tool_call` hook 可以在工具执行前拦截特定调用。

### Tool Result Guard

`session-tool-result-guard.ts` 检查工具返回结果：
- 是否包含敏感信息（API key、密码）
- 结果大小是否超限
- 是否包含可能的 prompt injection 内容

### Loop Detection

```json
{
  "tools": {
    "loopDetection": {
      "enabled": true,
      "maxConsecutive": 5,
      "windowSize": 10
    }
  }
}
```

`tool-loop-detection.ts` 检测 Agent 是否陷入无意义的重复调用（比如反复调用同一工具无进展）。

### File System Policy

```typescript
createToolFsPolicy({
  workspaceRoot: "/home/user/workspace",
  workspaceOnly: true,  // 限制 read/write/edit 在 workspace 内
});
```

---

## 15.8 工具 Schema 兼容性

不同 LLM 对工具 schema 要求不同：

| Provider | 处理文件 | 说明 |
|---------|---------|------|
| Google Gemini | `pi-tools.schema.ts` | 移除 Gemini 不支持的 schema 特性 |
| xAI | `schema/clean-for-xai.ts` | 避免与 xAI 自带 web_search 名称冲突 |
| Claude Code Assist | `tool-call-id.ts` | 特殊的 tool call ID 清洗 |
| OpenAI | `pi-tools.ts` | 降级推理标签对 |

---

## 15.9 本章要点

- 工具来自六个来源，经过多层策略管道 + 模型兼容性双重过滤
- 策略管道是覆盖式的，高优先级策略完全替代低优先级结论
- Owner-only 工具在非 owner 场景自动移除
- Bash 工具区分宿主 / 沙箱执行，支持高风险命令的人工审批
- Web 工具有 SSRF 防护，Session 工具支持多 Agent 协作
- 循环检测 + 结果守卫防止 Agent 行为失控

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/agents/pi-tools.ts` | ★★★ | 工具集构建入口 |
| `src/agents/tool-policy-pipeline.ts` | ★★★ | 策略管道实现 |
| `src/agents/tool-policy-shared.ts` | ★★★ | 工具组定义 |
| `src/agents/tool-policy.ts` | ★★ | Owner-only 策略 |
| `src/agents/bash-tools.ts` | ★★ | Bash 工具入口 |
| `src/agents/tools/web-guarded-fetch.ts` | ★★ | SSRF 防护 |
| `src/agents/tool-loop-detection.ts` | ★ | 循环检测 |
