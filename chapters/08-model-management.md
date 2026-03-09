# 第 8 章 模型管理与 Failover

## 8.1 多模型支持的设计挑战

OpenClaw 需要在运行时动态管理十几个 LLM 提供商、多种认证方式、以及复杂的 failover 链。这不仅仅是"调用不同的 API"，而是一个完整的**模型编排系统**。

核心挑战：
- 同一个提供商可能有多个账号（多个 Claude Pro 订阅）
- 不同模型的能力不同（tool calling 支持、context window 大小、vision 能力）
- 认证方式各异（OAuth、API Key、AWS IAM、Setup Token、Copilot Token）
- rate limit 后需要自动切换，恢复后需要切回
- 模型名在不同提供商间有别名和兼容问题

## 8.2 模型标识与规范化

OpenClaw 使用 `provider/model` 格式标识模型：

```
anthropic/claude-opus-4-6
openai/gpt-4.1
google/gemini-2.5-pro
ollama/llama3
openrouter/anthropic/claude-sonnet-4-5
```

**Provider ID 规范化**（`normalizeProviderId`）：

```typescript
function normalizeProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") return "zai";
  if (normalized === "bedrock" || normalized === "aws-bedrock") return "amazon-bedrock";
  if (normalized === "bytedance" || normalized === "doubao") return "volcengine";
  // ... 更多别名
  return normalized;
}
```

这处理了同一提供商的多种命名方式。例如 AWS Bedrock 可能被用户写成 `bedrock`、`aws-bedrock` 或 `amazon-bedrock`，规范化后统一为 `amazon-bedrock`。

**Model ID 规范化**（`normalizeProviderModelId`）：

Anthropic 模型支持简写别名：`opus-4.6` → `claude-opus-4-6`，`sonnet-4.5` → `claude-sonnet-4-5`。Google 模型和 OpenRouter 模型也有各自的规范化逻辑。

## 8.3 模型选择：优先级链

`model-selection.ts` 的 `resolveModelRefFromString` 解析模型引用，支持多种格式：

```
"claude-opus-4-6"                  → provider=anthropic, model=claude-opus-4-6
"anthropic/claude-opus-4-6"        → 显式指定
"anthropic/claude-opus-4-6@profile1" → 带 auth profile 后缀
"gpt-4.1"                          → 自动推断 provider=openai
```

模型选择的优先级链（从高到低）：

```
1. Session 级覆盖（/model 命令设置的）
2. Plugin hook 覆盖（before_model_resolve）
3. Agent 配置（agents.list[n].model 或 agents.defaults.model）
4. 全局配置（agent.model）
5. 环境变量
6. 内置默认值（anthropic/claude-opus-4-6）
```

## 8.4 Auth Profile 系统

这是 OpenClaw 最独特的设计之一——管理多个认证凭证的**轮转、cooldown 和恢复**。

### 数据模型

Auth Profile Store 持久化在磁盘上（`~/.openclaw/agents/<id>/auth-profiles.json`），包含：

```typescript
{
  profiles: {
    "claude-pro-1": {
      provider: "anthropic",
      mode: "oauth",         // 或 "api-key"、"aws-sdk"
      lastUsed: 1710000000,
      lastGood: 1710000000,
      failures: [],          // 失败记录
      cooldownUntil: null,   // cooldown 到期时间
    },
    "claude-pro-2": { ... },
    "claude-api": { ... }
  }
}
```

### Profile 排序

`resolveAuthProfileOrder` 决定 profile 的使用顺序：

```
1. 用户显式指定的 preferred profile
2. 配置中定义的 order
3. 按 lastUsed 排序（最近最少使用优先 —— 类似 LRU）
4. 按 lastGood 排序（最近成功优先）
```

### Cooldown 机制

当某个 profile 失败时（rate limit、billing error），`markAuthProfileFailure` 将它标记为 cooldown：

```typescript
markAuthProfileFailure({
  store: authStore,
  profileId: "claude-pro-1",
  reason: "rate_limit",  // 或 "billing"、"auth"、"overloaded"
  cfg, agentDir
});
```

cooldown 时长根据失败原因不同而不同（rate limit 通常较短，billing error 较长）。

`isProfileInCooldown` 检查 profile 是否仍在冷却期。冷却期过后自动恢复，不需要手动操作。

### 失败原因到 Cooldown 的映射

```typescript
function resolveAuthProfileFailureReason(failoverReason): AuthProfileFailureReason | null {
  // timeout 不标记为 profile 失败（超时是传输问题，不是 auth 问题）
  if (!failoverReason || failoverReason === "timeout") return null;
  return failoverReason;
}
```

这是一个重要的区分：timeout 被排除在外，因为超时通常是网络问题，不应该惩罚某个特定的 auth profile。

## 8.5 Model Failover：多模型回退链

当首选模型完全不可用（所有 profile 用尽），failover 系统切换到备选模型。

### Failover 链配置

```json
{
  "agent": {
    "model": "anthropic/claude-opus-4-6",
    "fallback": ["anthropic/claude-sonnet-4-6", "openai/gpt-4.1"]
  }
}
```

### FailoverError 机制

`failover-error.ts` 定义了一个特殊的错误类型，携带 failover 上下文：

```typescript
class FailoverError extends Error {
  reason: FailoverReason;     // "rate_limit" | "auth" | "billing" | "overloaded" | ...
  provider: string;
  model: string;
  status?: number;            // HTTP 状态码
}
```

`run.ts` 的外循环捕获 `FailoverError`，然后切换到 fallback 链中的下一个模型重试整个过程。

### Failover 候选收集

`model-fallback.ts` 的 `createModelCandidateCollector` 收集所有可能的 fallback 候选：

```
1. 主模型（primary）
2. 配置的 fallback 列表
3. 模型别名对应的候选
4. 如果有 allowlist → 仅保留 allowlist 中的候选
5. 去重
```

### Abort vs Failover 的区分

```typescript
function isFallbackAbortError(err: unknown): boolean {
  // 只有显式的 AbortError 才视为用户中止
  // "aborted" 类的错误消息不算（可能是超时）
  return err.name === "AbortError" && !isTimeoutError(err);
}
```

用户按"停止生成"产生的 AbortError 不应触发 failover（用户明确要停止），但超时产生的 abort 可以触发 failover（换个更快的模型）。

## 8.6 模型工具支持矩阵

`model-tool-support.ts` 维护每个模型的工具调用能力：

```typescript
const MODEL_TOOL_SUPPORT: Record<string, ToolSupportLevel> = {
  "claude-opus-4-6": { tools: true, parallel: true, streaming: true },
  "gpt-4.1": { tools: true, parallel: true, streaming: true },
  "gemini-2.5-pro": { tools: true, parallel: false, streaming: true },
  "llama3": { tools: false },
  // ...
};
```

如果当前模型不支持 tool calling，Agent 的行为会退化为纯文本对话——所有工具（bash、搜索、消息发送等）都不可用。

## 8.7 Provider 能力发现

某些提供商支持动态发现可用模型：

```
models-config.providers.discovery.ts  — 发现逻辑
models-config.providers.static.ts     — 静态模型列表
models-config.providers.ts            — provider 注册
models-config.merge.ts                — 合并多来源的模型信息
models-config.plan.ts                 — 模型配置计划
models-config.ts                      — 总入口
```

Ollama 是典型的动态发现案例——它在本地运行，可用模型列表取决于用户下载了什么。

## 8.8 本章要点

- 模型标识使用 `provider/model` 格式，有丰富的规范化和别名处理
- Auth Profile 系统支持多凭证轮转，带 cooldown、自动恢复和 transient probe
- FailoverError 携带结构化上下文，让外循环能精确判断是否触发模型切换
- Timeout 被特殊对待——不标记 profile 失败，不算用户 abort
- 工具支持矩阵决定 Agent 在不同模型下的能力边界

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/agents/model-selection.ts` | ★★★ | 模型解析和规范化 |
| `src/agents/model-fallback.ts` | ★★★ | Failover 链和候选收集 |
| `src/agents/auth-profiles.ts` | ★★★ | Auth profile 轮转与 cooldown |
| `src/agents/failover-error.ts` | ★★ | FailoverError 类型定义 |
| `src/agents/model-tool-support.ts` | ★★ | 工具支持矩阵 |
| `src/agents/model-catalog.ts` | ★ | 模型目录 |
| `src/agents/models-config.ts` | ★ | 模型配置合并 |
