# 第 26 章 辅助子系统

## 26.1 本章范围

本章收录那些贯穿整个系统、但不属于某一核心模块的辅助子系统。它们是 OpenClaw 稳定运行的"地基层"。

---

## 26.2 日志系统（`src/logging/`）

OpenClaw 使用分层结构化日志系统：

```
logger.ts         — 基础 logger（console capture）
logging.ts        — 全局日志入口
logging/
  subsystem.ts    — 子系统日志器（每个模块独立命名空间）
  structured.ts   — 结构化输出（JSON 格式）
  redact.ts       — 凭证 redaction（自动遮蔽 API key 等）
  diagnostic.ts   — 诊断日志（写入磁盘，用于问题排查）
  levels.ts       — 日志级别（debug/info/warn/error）
```

**console capture**：将 `console.log/warn/error` 捕获为结构化日志，同时维持 stdout/stderr 原有行为。这让第三方依赖库的输出也能被统一采集。

**redact 机制**：`redact-identifier.ts` 识别并遮蔽 API key、token 等敏感标识符。规则基于已知 provider 的 key 格式（`sk-...`、`eyJ...` 等）。

---

## 26.3 进程管理（`src/process/`）

```
process/
  exec.ts           — exec 工具的底层实现
  supervisor/       — 进程监督器
    supervisor.ts   — 子进程生命周期管理
    adapters/       — PTY、child_process 适配器
    registry.ts     — 活跃进程注册表
  kill-tree.ts      — 终止进程树（含子进程）
  lanes.ts          — 进程通道（并发控制）
  command-queue.ts  — 命令队列
```

**进程监督器（Supervisor）：**

Agent 执行的 bash 命令通过 Supervisor 管理。Supervisor 提供：
- PTY 支持（`adapters/pty.ts`）：终端模拟，支持交互式程序
- 进程树终止：`kill-tree.ts` 确保杀死父进程时子进程不留存
- 后台运行：`background: true` 时进程在后台持续运行，Agent 可稍后通过 `process` 工具查看输出
- 注册表：`registry.ts` 跟踪所有活跃进程，支持按 session 列出和管理

---

## 26.4 基础设施层（`src/infra/`）

`infra/` 是全系统的底层支撑库，约 400+ 文件。核心模块：

### 网络与 HTTP

```
infra/net/
  fetch-guard.ts    — 全局 fetch 拦截（超时、SSRF 检查）
  proxy-fetch.ts    — 代理支持（HTTP_PROXY 环境变量）
  ssrf.ts           — SSRF 防护（阻止内网请求）
  hostname.ts       — hostname 解析与验证
```

`fetch-guard.ts` 包装全局 `fetch`，为所有出站 HTTP 请求添加默认超时和 SSRF 检查。这是系统级防护，无论 Agent 使用哪个工具发起请求，都会经过这层。

### 文件系统安全

```
infra/path-guards.ts      — 路径遍历防护（../.. 攻击）
infra/hardlink-guards.ts  — 硬链接攻击防护
infra/path-safety.ts      — 路径白名单检查
infra/boundary-path.ts    — 工作区边界检查
```

### 重启与进程管理

```
infra/restart.ts              — Gateway 重启逻辑
infra/restart-sentinel.ts     — 重启哨兵文件（防死循环重启）
infra/restart-stale-pids.ts   — 清理遗留 PID 文件
```

重启哨兵：如果 Gateway 在极短时间内连续崩溃（如配置错误导致启动失败），哨兵机制会停止自动重启，避免无限循环。

### Backoff 与重试

```
infra/backoff.ts      — 指数退避算法
infra/retry.ts        — 通用重试包装
infra/retry-policy.ts — 重试策略配置
```

系统内的所有网络重试（embedding 请求、channel API 调用、ACP runtime 操作）都使用统一的 backoff/retry 基础设施。

---

## 26.5 Secrets 管理（`src/secrets/`）

**文件：** `src/secrets/`（约 20 个模块）

Secrets 系统管理所有敏感配置值（API key、token 等），提供三种存储方式：

```typescript
type SecretRef =
  | { kind: "env";    name: string }        // 从环境变量读取
  | { kind: "file";   path: string }        // 从文件读取
  | { kind: "inline"; value: string }       // 内联（不推荐生产使用）
```

**Target Registry（注入目标注册）：**

```
secrets/target-registry*.ts
```

Secrets 可以"注入"到特定的配置字段或环境变量中，而不是在代码里显式读取。Target Registry 维护一个 "secret name → 注入目标" 的映射，让 secrets 的流向可追踪。

**Runtime Config Collectors：**

```
secrets/runtime-config-collectors*.ts
```

在 Gateway 启动时，扫描配置中所有 `SecretRef` 引用，批量解析为实际值，生成运行时快照（`runtime.ts`）。运行时快照是只读的，不持久化到磁盘。

---

## 26.6 TTS 语音合成（`src/tts/`）

**文件：** `src/tts/tts.ts`, `src/tts/tts-core.ts`

```typescript
// tts 工具：将文本转为语音并投递到当前 session
tts({ text, channel? })
```

TTS 系统将文本发送到配置的 TTS 提供商（ElevenLabs、OpenAI TTS 等），返回音频文件，由投递系统将音频以语音消息格式发送到目标 channel。

在支持语音消息的 channel（Telegram、WhatsApp、Discord）上，用户收到的是可以直接播放的音频，而不是文字。

---

## 26.7 Link Understanding（`src/link-understanding/`）

**文件：** `src/link-understanding/`

消息中包含 URL 时，`link-understanding` 子系统在 Agent 处理前提取链接内容：

```
detect.ts   — 检测消息中的 URL
runner.ts   — 提取链接内容（fetch + 解析）
format.ts   — 将内容格式化为 LLM 可读形式
apply.ts    — 将结果注入 MsgContext
defaults.ts — 默认配置（哪些 scheme 处理，内容长度上限等）
```

与 `web_fetch` 工具的区别：Link Understanding 是**自动的、被动的**——不需要 Agent 主动调用，系统在消息处理阶段自动触发。适合"用户分享了一个链接，Agent 需要看懂链接内容再回复"的场景。

---

## 26.8 Diagnostics 与 OpenTelemetry（`src/diagnostics-otel.ts`）

OpenClaw 支持将诊断数据导出到 OpenTelemetry 兼容的后端：

```
diagnostics-otel.ts   — OTEL 初始化与导出配置
infra/diagnostic-events.ts  — 诊断事件发射
infra/diagnostic-flags.ts   — 诊断开关（按子系统控制）
```

诊断数据包括：模型调用延迟、工具执行时间、channel 投递结果等。在生产部署中，接入 Grafana/Jaeger 可以获得完整的 trace 视图。

---

## 26.9 Markdown 处理（`src/markdown/`）

```
markdown/
  ir.ts       — Markdown 中间表示（IR）
  render.ts   — IR → 各 channel 格式渲染
  tables.ts   — 表格处理
  fences.ts   — 代码块处理
  whatsapp.ts — WhatsApp 特定格式转换
```

不同 channel 的富文本格式各不相同：Discord 支持 Markdown、Telegram 支持 MarkdownV2 和 HTML、WhatsApp 有自己的格式规范。

`markdown/ir.ts` 将 Markdown 解析为统一的中间表示，再由各 channel adapter 渲染为目标格式。这避免了为每个 channel 写独立的解析逻辑。

---

## 26.10 本章总结

辅助子系统虽然"不起眼"，但它们是 OpenClaw 可靠运行的基础。几个关键点：

| 子系统 | 核心价值 |
|--------|---------|
| 日志系统 | 结构化 + redact，安全可观测 |
| 进程管理 | PTY 支持 + 进程树终止，bash 工具稳定运行 |
| infra/net | 全局 fetch 超时 + SSRF 防护 |
| Secrets 管理 | SecretRef 间接引用，secrets 不落盘 |
| TTS | 语音消息投递 |
| Link Understanding | 自动 URL 内容提取 |
| Markdown IR | 跨 channel 富文本格式适配 |
