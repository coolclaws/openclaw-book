# 第 14 章 工具系统实现

## 14.1 工具在 Agent 架构中的角色

工具（Tools）是 Agent 与外部世界的接口。当 LLM 决定需要执行操作时，它生成 `tool_use` block，OpenClaw 负责路由到对应实现。本章聚焦工具的具体实现层——各工具的内部机制、安全设计、以及多提供商兼容处理。工具的来源组装和策略过滤见第 10 章。

## 14.2 工具的多来源组装

工具不是来自单一位置，而是从五个来源逐层组装，经过策略管道过滤：

```
Layer 1: Pi Coding Tools（来自 pi-coding-agent 库）
  bash, read, write, edit, process, apply_patch
  
  Layer 2: OpenClaw 内置工具
    message, cron, gateway, canvas, nodes, session_status, agents_list,
    tts, image, pdf, web_search, web_fetch, browser
    
    Layer 3: 渠道特定工具
      discord_send, discord_react, telegram_send, slack_post, whatsapp_*
      
      Layer 4: 插件工具
        各扩展插件注册的自定义工具
        
        Layer 5: SDK 工具
          sessions_send, sessions_list, sessions_history, sessions_spawn,
          subagents, memory_search

→ tool-policy-pipeline（策略管道过滤）
→ owner-only 过滤
→ 模型兼容性过滤（不支持 tool calling 的模型移除所有工具）
→ 最终工具集（注入 system prompt + 传给 LLM API）
```

## 14.3 工具策略管道

`tool-policy-pipeline.ts` 实现了一个多步骤的策略管道，决定每个工具的最终可用性：

```typescript
const steps = buildDefaultToolPolicyPipelineSteps({
  cfg,
  sessionKey,
  agentId,
  senderIsOwner,
  sandbox,
  messageProvider,
  modelProvider,
});

const filteredTools = applyToolPolicyPipeline(allTools, steps);
```

### 管道步骤

| 步骤 | 来源 | 说明 |
|------|------|------|
| Profile Policy | `tool-policy-shared.ts` | 全局 tool allow/deny 配置 |
| Group Policy | `pi-tools.policy.ts` | 群组 session 的工具限制 |
| Subagent Policy | `pi-tools.policy.ts` | 子 Agent 的工具限制 |
| Sandbox Policy | `sandbox-tool-policy.ts` | Docker 沙箱的白名单/黑名单 |
| Owner-Only | `tool-policy.ts` | 仅 owner 可用的工具 |
| Message Provider | `pi-tools.ts` | 特定渠道的工具禁用（如 voice 禁用 tts） |
| Model Provider | `pi-tools.ts` | 模型特定的禁用（如 xAI 禁用 web_search） |

### Tool Groups

工具可以分组管理，一个 group 名代表多个工具：

```typescript
const TOOL_GROUPS: Record<string, string[]> = {
  "group:browser": ["browser"],
  "group:messaging": ["message", "discord_send", "telegram_send", "slack_post", ...],
  "group:sessions": ["sessions_send", "sessions_list", "sessions_history", "sessions_spawn"],
  "group:plugins": [/* 所有插件工具 */],
};
```

在 allow/deny 列表中可以使用 group 名：`deny: ["group:browser"]` 禁用所有浏览器相关工具。

## 14.4 核心工具详解

### Bash 工具（最复杂）

Bash 工具的复杂度来自它需要在两种环境中执行：宿主机和 Docker 沙箱。

```
bash-tools.ts                    # 工具定义入口
bash-tools.exec.ts               # 执行核心
bash-tools.exec-host-gateway.ts  # Gateway 宿主机执行
bash-tools.exec-host-node.ts     # 设备节点远程执行
bash-tools.exec-host-shared.ts   # 共享执行逻辑
bash-tools.exec-runtime.ts       # 运行时环境设置
bash-tools.exec-types.ts         # 类型定义
bash-tools.process.ts            # process 工具（进程管理）
bash-tools.shared.ts             # 共享工具函数
bash-process-registry.ts         # 进程注册表
```

**执行审批**（`bash-tools.exec-approval-request.ts`）：高风险命令可以配置需要人工确认。审批请求通过 Gateway WS 推送到 macOS app 或 Control UI，用户确认后才执行。

**进程注册表**（`bash-process-registry.ts`）：追踪所有由 bash 工具启动的子进程。当 session 被 abort 或 Agent 运行结束时，可以杀死所有未完成的子进程。

### Message 工具

```typescript
// tools/message-tool.ts
// action=send: 发送消息到指定渠道
// 支持跨渠道发送：Agent 在 Telegram 上运行，但可以发消息到 Discord
{
  name: "message",
  input_schema: {
    action: "send",
    channel: "telegram",       // 目标渠道
    to: "+1234567890",         // 目标用户/群组
    message: "Hello!",
    buttons: [[{text: "Yes", callback_data: "yes"}]]  // 可选：行内按钮
  }
}
```

message 工具是 Agent 主动触达用户的方式（区别于被动回复）。它支持：跨渠道发送、行内按钮、文件附件、轮询创建、消息反应。

### Web 工具集

```
tools/web-search.ts           # 网页搜索
tools/web-fetch.ts            # 获取网页内容
tools/web-fetch-utils.ts      # URL 解析、安全检查
tools/web-fetch-visibility.ts # 内容可见性过滤
tools/web-guarded-fetch.ts    # 安全 fetch（SSRF 防护）
tools/web-shared.ts           # 共享逻辑
tools/web-tools.ts            # Web 工具注册
```

`web-guarded-fetch.ts` 是安全的关键——它防止 SSRF（Server-Side Request Forgery）攻击，拒绝对内网地址（127.0.0.1、10.x、192.168.x）的请求。

### Session 工具集

```
tools/sessions-send-tool.ts    # 跨 session 发消息
tools/sessions-list-tool.ts    # 列出活跃 sessions
tools/sessions-history-tool.ts # 获取 session 历史
tools/sessions-spawn-tool.ts   # 派生新 session
tools/sessions-helpers.ts      # 共享辅助
tools/sessions-resolution.ts   # Session 解析
tools/sessions-access.ts       # 访问控制
```

Session 工具让 Agent 可以协调多个 session——在一个 session 中查看另一个 session 的历史，或者向另一个 session 发送消息。这是多 Agent 协作的基础。

### Browser 工具

```
tools/browser-tool.ts          # 浏览器工具主逻辑
tools/browser-tool.actions.ts  # 浏览器动作（点击、输入、截图、滚动）
tools/browser-tool.schema.ts   # 动作 schema
```

Browser 工具控制一个 OpenClaw 管理的 Chrome/Chromium 实例，通过 CDP 协议操作。支持的动作包括：导航、点击、输入文本、截图、获取页面快照、上传文件。

## 14.5 工具安全机制

### Before Tool Call Hook

`pi-tools.before-tool-call.ts` 在每次工具调用前执行：

```typescript
wrapToolWithBeforeToolCallHook(tool, {
  hookRunner,
  sessionKey,
  agentId,
  onBlock: () => { /* 记录被阻止的调用 */ }
});
```

插件可以通过 `before_tool_call` hook 阻止特定工具调用。

### Tool Result Guard

`session-tool-result-guard.ts` 检查工具返回的结果是否安全：
- 结果中是否包含敏感信息（API key、密码）
- 结果大小是否超过限制
- 结果是否包含可能的 prompt injection 内容

### Loop Detection

`tool-loop-detection.ts` 检测 Agent 是否陷入工具调用循环（如反复调用同一个工具却无进展）。配置通过 `tools.loopDetection`：

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

### File System Policy

`tool-fs-policy.ts` 控制 read/write/edit 工具的文件系统访问范围：

```typescript
const fsPolicy = createToolFsPolicy({
  workspaceRoot: "/home/user/workspace",
  workspaceOnly: true,  // 限制在 workspace 内
  // 或自定义 allow/deny 路径列表
});
```

## 14.6 工具 Schema 兼容性

不同 LLM 对工具 schema 的要求不同。OpenClaw 做了大量兼容性处理：

- **Google Gemini**（`pi-tools.schema.ts`）：`cleanToolSchemaForGemini` 移除 Gemini 不支持的 schema 特性
- **xAI**（`schema/clean-for-xai.ts`）：xAI 有自己的 web_search 工具，需要避免名称冲突
- **Claude Code Assist**：特殊的 tool call ID 清洗（`tool-call-id.ts`）
- **OpenAI function calling**：需要降级推理标签对（`downgradeOpenAIFunctionCallReasoningPairs`）

## 14.7 本章要点

- 工具从五个来源组装，经过七步策略管道过滤
- Tool Groups 允许批量管理工具的 allow/deny
- Bash 工具区分宿主执行和沙箱执行，支持执行审批
- Web 工具有 SSRF 防护，Session 工具支持多 Agent 协作
- 循环检测和结果守卫确保 Agent 行为安全
- 工具 schema 做了多提供商兼容处理

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/agents/pi-tools.ts` | ★★★ | 工具集构建入口 |
| `src/agents/tool-policy-pipeline.ts` | ★★★ | 策略管道实现 |
| `src/agents/tool-policy.ts` | ★★ | 工具策略定义 |
| `src/agents/bash-tools.ts` | ★★ | Bash 工具入口 |
| `src/agents/tools/message-tool.ts` | ★★ | 消息工具 |
| `src/agents/tools/web-guarded-fetch.ts` | ★ | SSRF 防护 |
| `src/agents/tool-loop-detection.ts` | ★ | 循环检测 |
