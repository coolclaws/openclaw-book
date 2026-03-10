# 第 16 章 Sandbox

## 16.1 为什么需要沙箱

Agent 运行用户提供的代码或处理不可信输入时，宿主机的安全边界完全依赖工具策略——但策略是软件层的，可以被绕过（比如通过 bash 工具访问宿主机敏感文件）。Sandbox 在操作系统层提供强隔离：Agent 的所有操作都在 Docker 容器内执行，容器外的文件系统和网络默认不可达。

## 16.2 启用方式：默认关闭，需显式配置

**沙箱默认不启用。** 需要在配置文件中显式设置 `sandbox.mode` 才会生效。

### 三种模式

```typescript
type AgentSandboxConfig = {
  mode?: "off" | "non-main" | "all";
};
```

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| `"off"` | 完全不启用（**默认值**）| 个人使用，信任所有输入 |
| `"non-main"` | 只对非主会话启用沙箱 | **推荐安全设置**：保护宿主机但不影响日常对话 |
| `"all"` | 所有会话（含 main）都在沙箱中运行 | 极高安全要求，一般不用 |

### 配置方式

可在全局默认或单个 agent 中设置：

```yaml
# 全局默认（agents.defaults）
agents:
  defaults:
    sandbox:
      mode: non-main   # 非主会话全部进沙箱

# 或单个 agent
agents:
  list:
    - id: research
      sandbox:
        mode: all      # 这个 agent 的所有会话都在沙箱里
```

### 哪些场景会触发沙箱

当 `mode` 配置了 `"non-main"` 时，以下场景的 exec / bash 工具调用会在 Docker 容器里执行：

- **群组消息**：Discord / Slack / Telegram 群组里的陌生人发来的消息（非主会话）
- **子 Agent（Sub-agent）**：父 Agent 派生的子任务，inherit 模式下跟随父配置，require 模式下强制沙箱
- **Cron isolated 任务**：`sessionTarget: "isolated"` 的 cron job 创建的 session
- **ACP 会话**：外部编码 Agent 的 session（非主 session）

**主会话（main session）不受 `"non-main"` 影响**——因为 main session 默认是你自己在用，完全信任。

### 前提条件

Sandbox 依赖 Docker，启用前需要：
1. 宿主机安装并运行 Docker
2. `openclaw` 进程有权限执行 `docker` 命令
3. 首次使用时会自动拉取默认镜像（`ghcr.io/openclaw/sandbox:latest`）

---

## 16.3 文件组织

```
src/agents/sandbox/
├── config.ts          # 沙箱配置解析（镜像、资源限制等）
├── constants.ts       # 默认镜像名、超时常量、安全默认值
├── context.ts         # 沙箱上下文（workspace volume 映射）
├── docker.ts          # Docker 命令执行（run, exec, kill, rm）
├── manage.ts          # 容器生命周期管理（列出、清理）
├── runtime-status.ts  # 运行时状态检测（容器是否存活）
├── tool-policy.ts     # 工具白名单（硬编码，不可被用户覆盖）
└── types.ts           # 类型定义
```

---

## 16.4 沙箱工具策略（固定规则）

沙箱的工具策略是**硬编码**的，不受 `openclaw.json` 配置影响，也不受用户的 toolPolicy 设置覆盖：

**允许（白名单）：**
```
bash, process, read, write, edit, apply_patch
sessions_list, sessions_history, sessions_send, sessions_spawn
```

**禁止（黑名单）：**
```
browser, canvas, nodes, cron, gateway
discord_*, telegram_*, slack_*, whatsapp_*（全部渠道工具）
```

**为什么是硬编码？** 沙箱的意义是"不可绕过的安全边界"。如果用户可以通过 toolPolicy 配置允许 `gateway`，沙箱就失去了意义。固定规则确保无论配置如何，沙箱内的 Agent 都无法访问 Gateway 或外部渠道。

沙箱中的 `bash` 工具被替换为沙箱专用版本，命令在容器内执行，无法访问宿主机文件系统（除映射的 workspace 目录外）。

---

## 16.5 沙箱生命周期

```
session 创建，且 sandbox=require（或配置默认启用）
  ↓
docker run <image> —— 启动容器
  ↓
挂载 workspace 目录为 volume（可读写）
  ↓
Agent 执行
  所有 bash 命令 → docker exec → 在容器内运行
  read/write/edit → 通过 volume 映射访问 workspace
  ↓
session 结束 / 超时
  ↓
docker stop / docker kill —— 停止容器
  ↓
sandbox-prune（定期任务）—— 清理停止的容器和临时数据
```

`runtime-status.ts` 在每次工具调用前检查容器是否仍然存活，如果容器意外退出（OOM、内核 kill），Pi 引擎会得到通知并终止当前 session，而不是让工具调用挂起。

---

## 16.6 两种触发方式

**文件：** `src/agents/subagent-spawn.ts`

```typescript
const SUBAGENT_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
```

| 模式 | 行为 |
|------|------|
| `inherit` | 跟随父 Agent 的沙箱配置（默认）|
| `require` | 强制启用沙箱，无论父 Agent 是否在沙箱中运行 |

`require` 模式的典型场景：
- 处理外部用户提交的代码执行请求
- 运行来自不可信来源的自动化任务
- Cron job 派生的子 Agent（避免定时任务影响宿主机）

---

## 16.7 沙箱 vs 工具策略的关系

沙箱和工具策略（第 11 章）是两个不同层次的安全机制：

| | 工具策略 | 沙箱 |
|--|---------|------|
| 隔离层次 | 软件层（哪些工具可调用）| OS 层（操作在哪里执行）|
| 可绕过性 | 受配置影响 | 不可绕过（硬编码规则）|
| 主要保护 | 权限范围 | 文件系统 + 进程隔离 |
| 开销 | 零 | 容器启动/停止开销 |

两者配合使用：工具策略决定"能用哪些工具"，沙箱决定"这些工具的操作在哪里执行"。

---

## 16.8 本章要点

- 沙箱在 OS 层提供隔离，工具策略是软件层——两者互补
- 沙箱工具策略硬编码，不可被用户配置覆盖
- workspace 目录通过 volume 映射到容器内，是唯一的文件系统通道
- `require` 模式强制启用，适合处理不可信输入
- 容器意外退出时 Pi 引擎主动终止 session，不挂起

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/agents/sandbox/tool-policy.ts` | ★★★ | 硬编码工具白名单 |
| `src/agents/sandbox/context.ts` | ★★★ | 沙箱上下文 + volume 映射 |
| `src/agents/sandbox/docker.ts` | ★★ | Docker 命令执行 |
| `src/agents/sandbox/manage.ts` | ★★ | 容器生命周期管理 |
| `src/agents/sandbox/runtime-status.ts` | ★ | 运行时状态检测 |
| `src/agents/sandbox/config.ts` | ★ | 沙箱配置解析 |
