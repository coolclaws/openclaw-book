# 第 24 章 安全模型

## 24.1 威胁模型

OpenClaw 连接到真实的消息平台并执行 bash 命令——这意味着安全模型必须同时应对两种攻击面：

**外部攻击面**：任何能向你的 bot 发 DM 的人都是潜在攻击者。他们可能尝试：
- Prompt injection：通过消息内容让 Agent 执行非预期操作
- 社工攻击：冒充 owner 获取权限
- 资源滥用：大量消息触发 API 调用消耗配额

**内部攻击面**：Agent 拥有 bash 执行能力，如果被 prompt injection 成功：
- 文件系统访问：读取敏感文件
- 命令执行：运行恶意命令
- 网络请求：SSRF 攻击内网服务
- 凭证泄露：暴露 API key 或 OAuth token

OpenClaw 的安全设计原则（来自 `SECURITY.md`）：**安全默认值 + 显式风险控制**。Main session 信任 owner（因为这是你自己的助手），非 main session（群聊、公共渠道）默认隔离。

## 24.2 DM 配对：身份验证第一道防线

默认情况下，未知发送者无法与助手对话：

```
陌生人 DM → bot 返回一个 6 位配对码 → owner 在终端确认 → 加入白名单
```

### 配置级别

```json
{
  "channels": {
    "telegram": {
      "dmPolicy": "pairing",       // 默认：需要配对
      "allowFrom": ["+1234567890"] // 预置白名单
    }
  }
}
```

三种 DM 策略：
- **`pairing`**（默认）：未知发送者收到配对码，需要 owner 批准
- **`open`**：接受所有 DM（需要显式 opt-in 且在 allowFrom 中包含 `"*"`）
- **`locked`**：拒绝所有非白名单 DM

### 实现细节

`src/pairing/` 实现了配对流程。配对码有效期有限，使用后失效。白名单持久化在 `~/.openclaw/` 下的 channel-specific store 中。

## 24.3 安全审计系统

`src/security/audit*.ts` 实现了全面的安全审计，`openclaw doctor` 命令触发：

### 审计维度

**配置审计**（`audit-channel.ts`）：
- DM 策略是否过于开放（`dmPolicy="open"` + `allowFrom: ["*"]` → **critical**）
- 白名单是否包含不安全的条目（如 Discord 用户名可以被修改）
- Telegram 白名单是否使用了不安全的用户名而非 user ID
- 是否启用了危险的配置标志

**文件系统审计**（`audit-fs.ts`）：
- 配置文件权限是否过于宽松（如 world-readable）
- 凭证文件权限检查
- OAuth 目录权限检查

**工具策略审计**（`audit-tool-policy.ts`）：
- 非 main session 是否有过多工具权限
- 沙箱策略是否配置正确

**异步审计**（`audit-extra.async.ts`）：
- Docker 沙箱镜像是否为过期版本
- Skill 文件是否有不安全的权限
- 包含文件（includes）路径是否安全

### 严重度分级

```typescript
type SecurityAuditSeverity = "info" | "warn" | "critical";
```

- **info**：信息性提示（如某功能被禁用）
- **warn**：潜在风险（如白名单使用了可变标识符）
- **critical**：严重安全问题（如 DM 完全开放）

## 24.4 Sandbox 隔离

非 main session 可以启用 Docker 沙箱，这是最重要的安全边界：

### 沙箱架构

```
Main Session（信任）：
  bash → 直接在宿主机执行
  read/write → 访问完整文件系统

Non-Main Session（隔离）：
  bash → 在 per-session Docker 容器中执行
  read/write → 仅访问容器内文件系统
  工具白名单：bash, process, read, write, edit, sessions_*
  工具黑名单：browser, canvas, nodes, cron, discord, gateway
```

### 沙箱配置

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main",  // 非 main session 使用沙箱
        "image": "ghcr.io/openclaw/sandbox:latest",
        "browser": {
          "image": "ghcr.io/openclaw/sandbox-browser:latest"
        }
      }
    }
  }
}
```

### 容器生命周期

```
sandbox/
├── config.ts      # 沙箱配置解析
├── context.ts     # 为 session 创建/获取容器上下文
├── docker.ts      # Docker CLI 封装
├── manage.ts      # 容器管理（列出、删除、清理）
├── constants.ts   # 默认镜像名、安全常量
└── runtime-status.ts  # 运行时状态
```

每个非 main session 有独立的容器。容器在 session 不活跃一段时间后自动清理（`sandbox-prune`）。

### Browser 沙箱

浏览器控制有自己的沙箱镜像（`Dockerfile.sandbox-browser`），与命令执行沙箱分离。这是因为浏览器需要 GUI 支持（headless Chromium），安全要求也不同。

## 24.5 Prompt Injection 防御

### 入站文本清洗

`auto-reply/reply/inbound-text.ts` 中的 `sanitizeInboundSystemTags` 转义用户消息中可能干扰 system prompt 结构的标记。

### 外部内容隔离

`security/external-content.ts` 处理来自链接、文件等外部内容的安全边界。外部内容在注入 Agent 上下文时会被标记为"不可信"（`UntrustedContext`），Agent 的 system prompt 指示它区别对待可信和不可信内容。

### Owner 身份保护

System prompt 中不暴露 owner 的真实身份（手机号、用户 ID），而是用哈希值。即使 prompt injection 成功提取了 system prompt 内容，攻击者也无法获取 owner 的联系方式。

### 工具调用参数验证

`session-tool-result-guard.ts` 在工具执行后检查返回结果：
- 检测结果中是否包含凭证泄露
- 检测结果中是否包含潜在的 prompt injection payload（嵌套攻击）
- 限制结果大小防止 context 溢出

## 24.6 认证安全

### 凭证存储

```
~/.openclaw/credentials/    # 渠道登录凭证
~/.openclaw/agents/*/       # Agent 特定凭证
```

`src/secrets/` 目录（429KB）管理所有密钥：

```
secrets/
├── command-config.ts       # 命令行密钥配置
├── runtime.ts              # 运行时密钥快照
├── runtime-gateway-auth-surfaces.ts  # Gateway 认证面检查
└── ...
```

### Gateway 认证

`src/gateway/auth.ts` + `connection-auth.ts` + `auth-rate-limit.ts` 三层防护：

1. **连接级认证**：WS 连接建立时验证身份
2. **认证模式策略**（`auth-mode-policy.ts`）：根据 `gateway.auth.mode` 决定认证方式
3. **Rate limiting**（`auth-rate-limit.ts`）：限制认证尝试频率，防暴力破解

### Tailscale 安全集成

当通过 Tailscale Serve/Funnel 暴露 Gateway 时：

- **Serve 模式**（tailnet 内）：信任 Tailscale 身份 header，可选密码
- **Funnel 模式**（公网）：**必须**启用密码认证（代码强制要求）

```typescript
// Funnel 拒绝在没有密码的情况下启动
if (mode === "funnel" && !passwordAuth) {
  throw new Error("Funnel requires gateway.auth.mode: 'password'");
}
```

## 24.7 危险配置检测

`security/dangerous-config-flags.ts` 检测可能降低安全性的配置：

```typescript
const DANGEROUS_FLAGS = [
  "channels.*.dmPolicy === 'open'",
  "channels.*.allowFrom includes '*'",
  "agents.defaults.sandbox.mode === 'off'",
  // ...
];
```

`security/dangerous-tools.ts` 标记可能被滥用的高权限工具。

## 24.8 本章要点

OpenClaw 安全模型的分层设计：

| 层次 | 机制 | 说明 |
|------|------|------|
| 身份验证 | DM Pairing | 未知发送者需要配对码确认 |
| 网络边界 | Tailscale + 密码 | 公网暴露强制密码 |
| 执行隔离 | Docker Sandbox | 非 main session 容器化执行 |
| 工具控制 | Policy Pipeline | 七步策略管道过滤工具可用性 |
| 文本清洗 | Inbound Sanitization | 防止 system prompt 结构干扰 |
| 身份保护 | Owner Hash | system prompt 中不暴露真实身份 |
| 结果检查 | Tool Result Guard | 检查工具返回的凭证泄露和嵌套攻击 |
| 持续审计 | Security Audit | `openclaw doctor` 全面安全扫描 |

---

## 24.9 Exec 安全审批系统

**文件：** `src/infra/exec-approvals.ts`, `src/infra/exec-safe-bin-policy.ts`

`exec` 工具赋予 Agent 执行 bash 命令的能力。这是 OpenClaw 最强大也最危险的功能。Exec 安全审批系统提供了细粒度的控制层。

### 三维控制模型

每次 exec 调用有两个独立的控制维度：

**security（最终执行权限）：**
```
deny      → 完全拒绝执行
allowlist → 只允许 allowlist 中的命令模式
full      → 允许所有命令
```

**ask（审批要求）：**
```
off       → 不需要用户审批
on-miss   → allowlist 没命中时才请求审批
always    → 每次都需要用户审批
```

两个维度组合，形成完整策略：

| security | ask | 效果 |
|----------|-----|------|
| `full` + `off` | 允许一切，不审批 | Main session 默认行为 |
| `allowlist` + `on-miss` | 白名单免审，其余需审批 | 推荐的平衡模式 |
| `deny` + `off` | 完全禁止 bash | 高隔离 session |

### Allowlist 与 glob 匹配

```typescript
type ExecAllowlistEntry = {
  id?: string;
  pattern: string;       // glob 模式，如 "git *" 或 "npm run *"
  lastUsedAt?: number;
  lastUsedCommand?: string;
  lastResolvedPath?: string;
};
```

allowlist 支持 glob 模式（`*` 匹配任意字符）。命中 allowlist 的命令免除用户审批；未命中时根据 `ask` 设置决定是拒绝还是请求审批。

`autoAllowSkills: true` 会自动将已安装 Skill 的脚本路径加入 allowlist，避免每次执行 Skill 都弹出审批框。

### Unix Socket IPC 审批流程

当命令需要用户审批时（`requiresExecApproval = true`），流程如下：

```
Agent 请求执行命令
  ↓
ExecApprovalRequest（含命令、参数、cwd、来源 session 等）
  ↓
通过 Unix Socket 发送到 Gateway
  ↓
Gateway 将审批请求推送给所有活跃的 TUI / 前端客户端
  ↓
用户看到审批提示：allow-once / allow-always / deny
  ↓
决定通过 Socket 返回 Agent
  ↓
Agent 根据决定执行或跳过
```

审批请求有超时（默认 120 秒），超时未响应按 `deny` 处理。

`allow-always` 会将该命令模式自动加入 allowlist，后续相同命令不再询问。

### Safe-Bin Policy Profiles

**文件：** `src/infra/exec-safe-bin-policy.ts`

预定义的"安全二进制"策略 profiles，开箱即用：

| Profile | 包含的命令 |
|---------|-----------|
| `developer` | git, npm, yarn, pnpm, node, python, pip, cargo, go... |
| `system` | ls, cat, grep, find, ps, curl, wget... |
| `minimal` | 极少数绝对安全的命令（echo, pwd, date 等）|

用户不需要手写 allowlist，选择一个 profile 即可快速配置。

---

## 24.10 Auth Profiles：凭据管理系统

**文件：** `src/agents/auth-profiles/`

OpenClaw 支持为同一个 LLM Provider 配置多套凭据（Auth Profiles），实现**自动轮转、故障隔离和多账号管理**。

### 三种凭据类型

```typescript
type AuthProfileCredential =
  | {
      type: "api_key";
      provider: string;
      key?: string;
      keyRef?: SecretRef;   // 引用 Secrets 系统中的密钥
      email?: string;
      metadata?: Record<string, string>; // AWS Account ID、Gateway ID 等
    }
  | {
      type: "token";        // 静态 Bearer Token（不自动刷新）
      provider: string;
      token?: string;
      tokenRef?: SecretRef;
      expires?: number;     // 过期时间戳
      email?: string;
    }
  | OAuthCredentials & {
      type: "oauth";        // 完整 OAuth2（自动刷新 access token）
      provider: string;
      clientId?: string;
      email?: string;
    };
```

### Round-Robin 轮转与 Circuit Breaker

**文件：** `src/agents/auth-profiles/usage.ts`（85 行）

多个 profile 之间自动 round-robin 轮转，遇到故障自动切换：

```typescript
// 失败原因分类（影响 cooldown 时长）
type AuthProfileFailureReason =
  | "auth"           // 认证失败（key 无效）→ 长期禁用
  | "auth_permanent" // 永久性认证失败 → 永久禁用
  | "billing"        // 账单问题 → 长期禁用
  | "rate_limit"     // 速率限制 → 短期 cooldown
  | "overloaded"     // 服务过载 → 短期 cooldown
  | "timeout"        // 超时 → 短期 cooldown
  | "model_not_found"// 模型不存在 → 中期禁用
  | "session_expired"// 会话过期（OAuth）→ 触发刷新
  | "unknown";       // 未知错误 → 短期 cooldown
```

**Circuit Breaker 模式：**

```
profile 失败
  → 根据 failureReason 设置 cooldownUntil 或 disabledUntil
  → 轮转到下一个可用 profile
  
cooldown 到期（clearExpiredCooldowns）
  → 清除 cooldownUntil/disabledUntil
  → 重置 errorCount（半开状态）
  → 下次轮转时可以再次尝试
```

注意：`clearExpiredCooldowns` 设计为懒执行——在下次 `markAuthProfileUsed/Failure` 时触发，而不是定时扫描，避免不必要的 I/O。

### External CLI Sync

**文件：** `src/agents/auth-profiles/external-cli-sync.ts`

OpenClaw 可以自动从外部 CLI 工具同步凭据，无需手动配置：

| CLI 工具 | 同步内容 |
|---------|---------|
| Claude Code（`claude`）| Anthropic OAuth credentials |
| OpenAI Codex | OpenAI API key / OAuth |
| GitHub Copilot | Copilot auth token |

当检测到这些工具已安装且已登录时，OpenClaw 自动将其凭据注册为对应 provider 的 auth profile，实现零配置接入。

### per-agent 顺序覆盖

```typescript
type AuthProfileStore = {
  profiles: Record<string, AuthProfileCredential>;
  order?: Record<string, string[]>; // agentId → profile 顺序
  lastGood?: Record<string, string>; // agentId → 上次成功的 profileId
  usageStats?: Record<string, ProfileUsageStats>;
};
```

`order` 字段允许为特定 agent 锁定 profile 优先级——例如，coding agent 专用高配额的 API key，chat agent 使用标准配额的 key，互不干扰，无需修改全局配置。

---

## 24.10.1 v2026.3.12 安全加固

> **📦 v2026.3.12 新增**

v2026.3.12 包含 20+ 项安全修复，是 OpenClaw 历史上安全加固力度最大的单次发版。以下按类别整理：

### 1. Exec 审批防绕过（5 个 CVE）

| 漏洞 | 攻击手法 | 修复 |
|------|---------|------|
| Unicode 隐形字符 | 在命令中插入零宽字符绕过 allowlist 匹配 | 命令规范化时先剥离所有 Unicode 控制字符 |
| Ruby `-r` 标志 | `ruby -r malicious_lib` 通过 `-r` 加载恶意代码 | 标志检测扩展覆盖 Ruby 特有的 `-r`/`-e` 模式 |
| Inline loader | 利用 `node --require` / `python -c` 内联执行 | 增加 inline code execution 模式检测 |
| Shell payload 绑定 | 通过环境变量 `ENV=...` 前缀绑定 payload | 检测并阻断 `KEY=VALUE command` 模式中的可疑 payload |
| pnpm/npx 脚本 | `pnpm exec` / `npx` 执行未审核的 package 脚本 | 将 `pnpm exec`、`npx` 纳入需审批命令列表 |

### 2. 设备配对安全

- **配对码改为短期 bootstrap token**：配对码不再是静态 6 位数字，改为带 TTL 的一次性 bootstrap token，过期自动失效
- **设备 token scope 上限**：配对设备获取的 token 有明确的权限上限，不再继承 owner 的完整权限

### 3. WebSocket 安全

- **预认证帧大小限制**：在 WS 连接完成认证之前，限制单帧最大字节数，防止未认证客户端发送巨帧消耗内存
- **共享 token scope 清除**：共享 token（用于多设备连接）的权限范围在 token 失效时完整清除，不留残余授权

### 4. Plugin 安全

- **工作区插件禁止自动加载（GHSA-99qw-6mr3-36qr）**：此前 workspace 目录下的插件会被自动加载，攻击者可以通过在共享 workspace 中放置恶意插件实现代码执行。修复后工作区插件必须在配置中显式声明才会加载

### 5. 沙箱写入修复

- **空文件 bug**：沙箱中写入空文件时不再静默失败，正确创建零字节文件
- **Stage 写入锁定父目录**：写入 staging 区域时锁定父目录，防止 TOCTOU 竞态导致写入到非预期位置

### 6. 命令权限

- **`/config`、`/debug` 要求 owner 身份**：这两个命令可暴露敏感配置信息，现在要求消息发送者是 owner
- **`session_status` 沙箱可见性**：沙箱环境中的 session 状态查询不再泄露宿主机路径和进程信息

### 7. Browser 控制

- **阻止 `browser.request` 持久化 admin 操作**：攻击者可能通过 prompt injection 让 Agent 使用 browser 工具访问管理界面。修复后，browser 工具的请求会被检查目标 URL，阻止对 Gateway admin 端点的持久化操作（如配置修改、权限变更）

### 8. Webhook 安全

| 渠道 | 修复内容 |
|------|---------|
| 飞书（Feishu）| 实施双验证（签名 + 事件 token），防止伪造 webhook |
| LINE | 修复空事件签名验证绕过——空 body 不再被视为合法事件 |
| Zalo | 新增暴力破解限速，防止攻击者枚举 webhook secret |
| Slack/Teams | 切换到稳定 ID 路由——使用 team_id + channel_id 组合而非可变的 workspace name |

### 9. 其他安全修复

- **SecretRef exec 遍历拒绝**：`exec` 工具尝试通过 SecretRef 路径遍历（`../../secrets/key`）时直接拒绝
- **Secret 文件路径竞争加固**：secret 文件的读写操作加锁，防止并发竞争导致读到不完整的 secret
- **归档解压 symlink 逃逸修复**：解压归档文件时检测并拒绝包含指向外部路径的符号链接，防止 zip slip 攻击

---

## 24.11 本章要点（更新）

| 层次 | 机制 | 说明 |
|------|------|------|
| 身份验证 | DM Pairing | 未知发送者需要配对码确认 |
| 网络边界 | Tailscale + 密码 | 公网暴露强制密码 |
| 执行隔离 | Docker Sandbox | 非 main session 容器化执行 |
| **Exec 控制** | **Security + Ask 双维度** | **命令白名单 + 用户审批流程** |
| 工具控制 | Policy Pipeline | 七步策略管道过滤工具可用性 |
| 文本清洗 | Inbound Sanitization | 防止 system prompt 结构干扰 |
| 身份保护 | Owner Hash | system prompt 中不暴露真实身份 |
| 结果检查 | Tool Result Guard | 检查工具返回的凭证泄露和嵌套攻击 |
| **凭据管理** | **Auth Profiles + Circuit Breaker** | **多账号轮转，故障自动切换** |
| 持续审计 | Security Audit | `openclaw doctor` 全面安全扫描 |

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `SECURITY.md` | ★★★ | 安全策略全文（必读）|
| `src/infra/exec-approvals.ts` | ★★★ | Exec 审批：类型、Socket IPC、allowlist |
| `src/agents/auth-profiles/usage.ts` | ★★★ | Circuit Breaker、轮转、cooldown |
| `src/agents/auth-profiles/types.ts` | ★★ | 三种凭据类型 |
| `src/security/audit.ts` | ★★ | 审计入口 |
| `src/infra/exec-safe-bin-policy.ts` | ★★ | Safe-Bin 预设 profiles |
| `src/agents/auth-profiles/external-cli-sync.ts` | ★ | CLI 凭据同步 |
| `src/agents/sandbox/context.ts` | ★ | 沙箱上下文创建 |
