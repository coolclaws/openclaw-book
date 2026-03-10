# 第 20 章 ACP：外部 Agent 通信协议

## 20.1 ACP 是什么，为什么需要它

Sub-agent（第 15 章）解决了"让另一个 OpenClaw Pi 引擎帮我做任务"的问题。但有一类需求超出了 Pi 的能力范围：**调用外部编码 Agent**——Claude Code、Codex、Gemini CLI 这类专为代码任务设计、运行在用户终端的工具。

这些工具有自己的执行环境、文件系统访问、工具集和交互协议，OpenClaw 无法直接"内嵌"运行它们。ACP（Agent Communication Protocol）就是专门为此设计的对接层：

```
用户（Discord / Telegram / Webchat）
       ↕  消息
   OpenClaw Gateway
       ↕  ACP 协议
   外部 Agent Runtime（Claude Code / Codex / acpx / ...）
       ↕  工具调用
   文件系统 / 代码仓库
```

ACP 的定位：**OpenClaw 作为前端（消息路由、权限管控、流式输出），外部 Agent 作为执行后端（代码理解、编写、运行）**。

---

## 20.2 整体架构

```
┌───────────────────────────────────────────────────────────────┐
│  消息流水线 / sessions_spawn 工具                              │
│  触发 ACP 任务                                                 │
└────────────────────────┬──────────────────────────────────────┘
                         │
┌────────────────────────▼──────────────────────────────────────┐
│  ACP 控制平面（Control Plane）                                 │
│                                                                │
│  AcpSessionManager（全局单例）                                 │
│  ├── SessionActorQueue   — 每 session 串行化操作队列            │
│  ├── RuntimeCache        — 活跃 runtime handle 缓存（TTL 淘汰）│
│  └── activeTurnBySession — 正在运行的 turn（用于 cancel）      │
└────────────────────────┬──────────────────────────────────────┘
                         │ ensureSession / runTurn / cancel / close
┌────────────────────────▼──────────────────────────────────────┐
│  AcpRuntime 接口（插件层）                                     │
│  registerAcpRuntimeBackend()                                   │
│  ├── acpx 后端（Claude Code / OpenCode 等）                    │
│  └── 其他自定义后端                                            │
└───────────────────────────────────────────────────────────────┘
```

整个系统分三层：**控制平面**（会话生命周期管理）、**接口层**（`AcpRuntime` 插件契约）、**后端实现**（具体 Agent 适配器）。

---

## 20.3 AcpRuntime 接口：插件契约

**文件：** `src/acp/runtime/types.ts`

任何外部 Agent 适配器必须实现 `AcpRuntime` 接口：

```typescript
interface AcpRuntime {
  // 确保 session 存在（首次调用时创建，已有则复用）
  ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;

  // 执行一次对话 turn，返回流式事件
  runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent>;

  // 取消当前 turn（可选）
  cancel(input: { handle, reason? }): Promise<void>;

  // 关闭 session（释放资源）
  close(input: { handle, reason }): Promise<void>;

  // 可选能力
  getCapabilities?(input): Promise<AcpRuntimeCapabilities> | AcpRuntimeCapabilities;
  getStatus?(input): Promise<AcpRuntimeStatus>;
  setMode?(input): Promise<void>;           // 切换 Agent 运行模式
  setConfigOption?(input): Promise<void>;   // 设置后端配置项
  doctor?(): Promise<AcpRuntimeDoctorReport>; // 环境诊断
}
```

**注册后端：**

```typescript
registerAcpRuntimeBackend({
  id: "acpx",
  runtime: myAcpRuntime,
  healthy?: () => boolean,  // 健康检查
});
```

Plugin SDK 通过 `acpx.d.ts` 导出这组类型，让第三方插件可以自己实现后端并注入。

---

## 20.4 流式事件协议

`runTurn` 返回 `AsyncIterable<AcpRuntimeEvent>`，定义了 OpenClaw 与 Agent 之间的实时通信协议：

```typescript
type AcpRuntimeEvent =
  | {
      type: "text_delta";    // 流式文字输出
      text: string;
      stream?: "output" | "thought";  // 正式输出 or 思考链
      tag?: AcpSessionUpdateTag;
    }
  | {
      type: "status";        // 进度状态（工具调用中、搜索中...）
      text: string;
      tag?: AcpSessionUpdateTag;
      used?: number;         // 已用 token
      size?: number;
    }
  | {
      type: "tool_call";     // 工具调用事件
      text: string;
      tag?: AcpSessionUpdateTag;
      toolCallId?: string;
      status?: string;       // "started" | "done" | "error"
      title?: string;
    }
  | {
      type: "done";
      stopReason?: string;
    }
  | {
      type: "error";
      message: string;
      code?: string;
      retryable?: boolean;
    };
```

### AcpSessionUpdateTag 的作用

```typescript
type AcpSessionUpdateTag =
  | "agent_message_chunk"
  | "agent_thought_chunk"
  | "tool_call"
  | "tool_call_update"
  | "usage_update"
  | "available_commands_update"
  | "current_mode_update"
  | "config_option_update"
  | "session_info_update"
  | "plan"
  | (string & {});  // 允许后端自定义 tag
```

Tag 用于流输出的**可见性控制**。配置 `acp.stream.tagVisibility` 可以按 tag 决定哪些事件显示给用户、哪些静默处理：

```typescript
type AcpStreamConfig = {
  coalesceIdleMs?: number;      // 合并小块的 idle 窗口（ms）
  maxChunkChars?: number;       // 单块最大字符数
  repeatSuppression?: boolean;  // 抑制重复的 status/tool 行
  deliveryMode?: "live" | "final_only"; // 实时推送 or 只推最终结果
  hiddenBoundarySeparator?: "none" | "space" | "newline" | "paragraph";
  maxOutputChars?: number;      // 转发给用户的最大输出字符
  maxSessionUpdateChars?: number;
  tagVisibility?: Partial<Record<AcpSessionUpdateTag, boolean>>;
};
```

`live` 模式：每个 `text_delta` 立刻推给用户，实时看到 Agent 的输出流。
`final_only` 模式：等 `done` 事件后一次性推送，适合不需要逐字显示的场景。

---

## 20.5 会话模式：oneshot vs persistent

```typescript
type AcpRuntimeSessionMode = "persistent" | "oneshot";
```

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| `oneshot` | 任务完成后关闭 session | 一次性代码生成、文件修改 |
| `persistent` | session 保持活跃，等待下一次输入 | Discord/Telegram thread 绑定，多轮编码对话 |

**Prompt 模式：**

```typescript
type AcpRuntimePromptMode = "prompt" | "steer";
```

- `prompt`：新任务开始，发送完整的任务描述
- `steer`：在已运行的 turn 中途插入指导（如"不对，改用 TypeScript"）

---

## 20.6 控制平面：AcpSessionManager

**文件：** `src/acp/control-plane/manager.core.ts`

`AcpSessionManager` 是全局单例，负责所有 ACP session 的生命周期。

### SessionActorQueue：每 session 串行化

```typescript
class SessionActorQueue {
  run<T>(actorKey: string, op: () => Promise<T>): Promise<T>;
}
```

同一个 sessionKey 的所有操作（初始化、runTurn、cancel、close）都通过 Actor Queue 串行执行，**绝对不会有两个并发操作同时操作同一 session**。这消除了大量竞态条件。

```
session-A: init → runTurn-1 → runTurn-2（排队等 runTurn-1 完成）
session-B: init → runTurn-1   ← 与 session-A 完全并行，互不影响
```

### RuntimeCache：TTL 淘汰

```typescript
class RuntimeCache {
  get(actorKey, { touch?: boolean }): CachedRuntimeState | null;
  set(actorKey, state): void;
  collectIdleCandidates({ maxIdleMs }): CachedRuntimeSnapshot[];
}

type CachedRuntimeState = {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  backend: string;
  agent: string;
  mode: AcpRuntimeSessionMode;
  cwd?: string;
  appliedControlSignature?: string; // 已应用的 runtime controls 签名
};
```

`get` 带 `touch: true` 参数时刷新 `lastTouchedAt`（类 LRU）。定期（每次 `runTurn` 后）调用 `collectIdleCandidates` 找出超过 TTL 的 session，调用 `runtime.close()` 释放资源。默认 TTL 通过 `acp.runtime.ttlMinutes` 配置。

### 并发 session 上限

```typescript
private enforceConcurrentSessionLimit(cfg, agentId): void;
```

`acp.maxConcurrentSessions` 限制同时活跃的 ACP session 数，超限时拒绝新建。

### Session 状态机

```
none（未初始化）
  → ready（ensureSession 成功）
    → running（runTurn 进行中）
    → ready（runTurn 完成）
  stale（runtime 不可用或错误）
```

```typescript
type AcpSessionResolution =
  | { kind: "none"; sessionKey }       // 从未初始化
  | { kind: "stale"; sessionKey; error } // 曾经初始化，但 runtime 出错
  | { kind: "ready"; sessionKey; meta }; // 正常可用
```

---

## 20.7 Session Identity：跨重启的身份恢复

**文件：** `src/acp/runtime/session-identity.ts`

ACP session 关联三类标识符：

```typescript
type SessionAcpIdentity = {
  backendSessionId?: string;  // 后端内部 session ID（如 acpx 的 record id）
  agentSessionId?: string;    // 上游 Agent 自己的 session ID（如 Claude Code session）
  resolvedAt?: number;        // 最后一次成功解析的时间戳
};
```

**为什么需要 identity 恢复？**

Gateway 重启后，`RuntimeCache` 被清空，但磁盘上的 session meta 文件还在。恢复时需要将 session meta 里保存的 `backendSessionId` / `agentSessionId` 重新注入到新建的 runtime handle，确保 Agent 能续接上次的上下文。

```typescript
// 启动时调用，批量恢复所有 pending identity
reconcilePendingSessionIdentities({ cfg }): Promise<AcpStartupIdentityReconcileResult>;

// 结果
type AcpStartupIdentityReconcileResult = {
  checked: number;  // 扫描了多少 session
  resolved: number; // 成功恢复了多少
  failed: number;   // 恢复失败（后端无响应、session 已过期等）
};
```

`mergeSessionIdentity` 处理并发更新冲突——两个请求同时更新同一 session 的 identity 时，以更完整的那份为准。

---

## 20.8 Persistent Bindings：频道与 Session 绑定

**文件：** `src/acp/persistent-bindings.ts`

ACP 最强大的能力之一：**将特定 Discord/Telegram 对话（或 thread）与一个 ACP session 永久绑定**。

```typescript
type ConfiguredAcpBindingSpec = {
  channel: "discord" | "telegram";
  accountId: string;
  conversationId: string;        // thread id 或 chat id
  parentConversationId?: string; // 父频道（用于 thread 绑定）
  agentId: string;
  acpAgentId?: string;           // ACP 后端的 agent id（可与 agentId 不同）
  mode: AcpRuntimeSessionMode;
  cwd?: string;
  backend?: string;
  label?: string;
};
```

**绑定机制：**

1. 用户在某个 Discord thread 发消息
2. 消息流水线调用 `resolveConfiguredAcpRoute` 查询是否有绑定
3. 有绑定 → `ensureConfiguredAcpRouteReady` 确保 session 就绪（不存在则创建）
4. 路由到绑定 session 的 ACP runtime 执行

```typescript
// 消息路由中的 ACP 路径判断
resolveConfiguredAcpRoute({ cfg, route, channel, accountId, conversationId })
  → { configuredBinding, route, boundSessionKey?, boundAgentId? }
```

这让 Discord 的一个 thread 天然成为 coding agent 的"工作区"——所有发到该 thread 的消息都直接进入 Agent 的上下文，实现真正的多轮编码对话。

**Session 原地重置：**

```typescript
resetAcpSessionInPlace({ cfg, sessionKey, reason: "new" | "reset" })
```

不销毁 session 绑定，只重置 runtime 状态，相当于"在同一个 thread 开一个新的编码任务"。

---

## 20.9 Spawn：按需创建 ACP 任务

**文件：** `src/agents/acp-spawn.ts`

除了 persistent binding（预配置绑定），Agent 还可以在运行时通过 `sessions_spawn` 工具动态发起 ACP 任务：

```typescript
type SpawnAcpParams = {
  task: string;          // 给 Agent 的任务描述
  agentId?: string;      // 使用哪个 ACP agent
  mode?: "run" | "session"; // oneshot or 持久会话
  thread?: boolean;      // 是否创建绑定 thread（Discord/Telegram）
  sandbox?: "inherit" | "require"; // sandbox 策略
  streamTo?: "parent";   // 是否将输出 relay 回父 session
  cwd?: string;
  label?: string;
};

type SpawnAcpResult = {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
  runId?: string;
  mode?: SpawnAcpMode;
  streamLogPath?: string; // 用于 parent stream relay
  note?: string;
  error?: string;
};
```

### Parent Stream Relay

**文件：** `src/agents/acp-spawn-parent-stream.ts`

当 `streamTo: "parent"` 时，子 ACP session 的流式输出会实时 relay 到父 session：

```typescript
startAcpSpawnParentStreamRelay({
  runId,
  parentSessionKey,
  childSessionKey,
  agentId,
  logPath?,
  streamFlushMs?,       // 流式推送间隔
  noOutputNoticeMs?,    // 多久无输出发提醒
  noOutputPollMs?,      // 无输出时的轮询间隔
  maxRelayLifetimeMs?,  // relay 最大存活时间
  emitStartNotice?,
}): AcpSpawnParentRelayHandle
```

这让用户可以在主聊天窗口实时看到 coding agent 的工作进度，而不需要切换到专用 thread。

### 权限策略

```typescript
resolveAcpSpawnRuntimePolicyError({
  cfg,
  requesterSessionKey?,
  requesterSandboxed?,
  sandbox?,
}): string | undefined  // 返回错误原因，undefined = 允许
```

策略检查顺序：
1. `acp.enabled` 全局开关
2. 请求方 session 是否有权发起 ACP spawn
3. 沙箱策略（sandboxed session 能否发起非沙箱 ACP）
4. `allowedAgents` 白名单

---

## 20.10 策略与配置

**文件：** `src/acp/policy.ts`, `src/config/types.acp.ts`

```typescript
type AcpConfig = {
  enabled?: boolean;                // 全局开关（默认 false，需显式开启）
  backend?: string;                 // 默认后端 id（如 "acpx"）
  defaultAgent?: string;            // 默认 agent id
  allowedAgents?: string[];         // 白名单（空 = 不限制）
  maxConcurrentSessions?: number;   // 并发 session 上限

  dispatch?: {
    enabled?: boolean;              // 消息流水线中的 ACP dispatch 开关
  };

  stream?: AcpStreamConfig;         // 流式输出控制（见 16.4）

  runtime?: {
    ttlMinutes?: number;            // 空闲 session TTL（分钟）
    installCommand?: string;        // /acp install 显示的安装指引
  };
};
```

**策略函数：**

```typescript
isAcpEnabledByPolicy(cfg): boolean
resolveAcpDispatchPolicyState(cfg): "enabled" | "acp_disabled" | "dispatch_disabled"
isAcpAgentAllowedByPolicy(cfg, agentId): boolean
resolveAcpAgentPolicyError(cfg, agentId): AcpRuntimeError | null
```

---

## 20.11 ACP 与 Sub-agent 的对比

虽然都是"让另一个 agent 来帮忙"，两者的定位截然不同：

| 维度 | Sub-agent（第 15 章）| ACP |
|------|---------------------|-----|
| 执行环境 | OpenClaw Pi 引擎（内部）| 外部独立进程（Claude Code 等）|
| 工具集 | OpenClaw 工具（memory、browser 等）| Agent 自有工具（文件系统、shell 等）|
| 协议 | Pi 内部 session 机制 | AcpRuntime 接口（流式事件协议）|
| 持久化 | 任务完成即销毁（默认）| 可 persistent，跨 turn 保持状态 |
| 适合场景 | 数据处理、信息检索、跨 session 协作 | 代码编写、调试、大规模文件修改 |
| 绑定 | 无频道绑定 | 可绑定 Discord/Telegram thread |

---

## 20.12 完整流程：一次 ACP 编码任务

```
用户在 Discord thread 发："帮我给 cryptosurf 加一个暗色模式"
  ↓
消息流水线
  → resolveConfiguredAcpRoute() 查询绑定
  → 该 thread 绑定了一个 persistent ACP session（agentId: "claude-code"）
  ↓
AcpSessionManager
  → resolveSession()：session 状态为 "ready"
  → actorQueue.run(sessionKey, () => runTurn())：入队
  → ensureRuntimeHandle()：从 RuntimeCache 取 handle
  ↓
AcpRuntime.runTurn({ handle, text: "帮我给 cryptosurf 加...", mode: "prompt" })
  → AsyncIterable<AcpRuntimeEvent>
    → { type: "status", text: "Reading codebase..." }
    → { type: "tool_call", title: "Read file: tailwind.config.ts" }
    → { type: "text_delta", text: "我看了配置，建议在..." }
    → { type: "tool_call", title: "Edit: tailwind.config.ts" }
    → { type: "text_delta", text: "已完成修改，共改动 3 个文件" }
    → { type: "done", stopReason: "end_turn" }
  ↓
流式输出 coalescer（AcpStreamConfig）
  → 合并小块，抑制重复 status 行
  → 实时推送给用户（deliveryMode: "live"）
  ↓
用户看到 Agent 的实时工作进度 + 最终结果
```

---

## 20.13 本章要点

ACP 是 OpenClaw 对接外部编码 Agent 的完整解决方案，核心设计原则：

- **接口驱动**：`AcpRuntime` 接口让任何 Agent 都能接入，而不绑定特定工具
- **串行安全**：`SessionActorQueue` 确保每个 session 的操作无竞态
- **持久绑定**：频道 → session 的持久绑定让 Discord thread 天然成为编码工作区
- **流式协议**：事件类型 + tag 体系支持细粒度的输出控制
- **跨重启续接**：session identity 机制保证 Gateway 重启后 Agent 上下文不丢失

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/acp/runtime/types.ts` | ★★★ | AcpRuntime 接口、事件协议、会话模式 |
| `src/acp/control-plane/manager.core.ts` | ★★★ | 控制平面主入口 |
| `src/acp/control-plane/session-actor-queue.ts` | ★★ | 串行化队列实现 |
| `src/acp/control-plane/runtime-cache.ts` | ★★ | TTL 缓存 |
| `src/acp/persistent-bindings.*.ts` | ★★ | 频道绑定全套逻辑 |
| `src/agents/acp-spawn.ts` | ★★ | 动态 spawn + 权限策略 |
| `src/agents/acp-spawn-parent-stream.ts` | ★ | Parent stream relay |
| `src/acp/policy.ts` | ★ | 策略函数 |
| `src/config/types.acp.ts` | ★ | 完整配置项 |
