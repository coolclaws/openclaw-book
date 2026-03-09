# 第 18 章 安全模型

## 13.1 威胁模型

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

## 13.2 DM 配对：身份验证第一道防线

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

## 13.3 安全审计系统

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

## 13.4 Sandbox 隔离

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

## 13.5 Prompt Injection 防御

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

## 13.6 认证安全

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

## 13.7 危险配置检测

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

## 13.8 本章要点

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

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `SECURITY.md` | ★★★ | 安全策略全文（必读） |
| `src/security/audit.ts` | ★★★ | 审计入口 |
| `src/security/audit-channel.ts` | ★★ | 渠道配置审计 |
| `src/agents/sandbox/context.ts` | ★★ | 沙箱上下文创建 |
| `src/pairing/` | ★★ | DM 配对机制 |
| `src/security/external-content.ts` | ★ | 外部内容安全边界 |
| `src/gateway/auth-rate-limit.ts` | ★ | 认证限速 |
