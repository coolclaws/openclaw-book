# 第 12 章 模型选择

## 12.1 多模型支持的设计挑战

OpenClaw 需要在运行时动态管理十几个 LLM 提供商、多种认证方式、以及复杂的 failover 链。核心挑战：

- 同一提供商可能有多个账号（多个 Claude Pro 订阅、多个 API Key）
- 不同模型的能力不同（tool calling、context window、vision、reasoning）
- 认证方式各异（OAuth、API Key、AWS IAM、Bearer Token、Copilot Token）
- Rate limit 后需要自动切换，恢复后需要切回
- 模型名在不同提供商间有别名和兼容问题
- 某些模型支持 thinking/reasoning，级别各不相同

---

## 12.2 模型标识与规范化

**文件：** `src/agents/model-selection.ts`

### provider/model 格式

```
anthropic/claude-opus-4-6
openai/gpt-4.1
google/gemini-2.5-pro
ollama/llama3
openrouter/anthropic/claude-sonnet-4-5
amazon-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0
```

### Provider 规范化

```typescript
function normalizeProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  // 别名映射
  if (normalized === "z.ai" || normalized === "z-ai")          return "zai";
  if (normalized === "bedrock" || normalized === "aws-bedrock") return "amazon-bedrock";
  if (normalized === "bytedance" || normalized === "doubao")    return "volcengine";
  // ... 更多别名
  return normalized;
}

// Auth 查找时的 provider 规范化（coding-plan 变体与 base 共享 auth）
function normalizeProviderIdForAuth(provider: string): string;
```

### Model 规范化

Anthropic 模型支持简写别名：

```
"opus-4.6"    → "claude-opus-4-6"
"sonnet-4.5"  → "claude-sonnet-4-5"
"haiku-3.5"   → "claude-haiku-3-5"
```

Google、OpenRouter 模型也有各自的规范化逻辑。

### 模型引用解析（resolveModelRefFromString）

支持多种格式：

```
"claude-opus-4-6"                      → provider=anthropic, model=claude-opus-4-6
"anthropic/claude-opus-4-6"            → 显式指定 provider
"anthropic/claude-opus-4-6@profile1"   → 带 auth profile 后缀
"gpt-4.1"                              → 自动推断 provider=openai
"my-alias"                             → 从 aliasIndex 查找
```

### 模型别名索引（ModelAliasIndex）

```typescript
type ModelAliasIndex = {
  byAlias: Map<string, { alias: string; ref: ModelRef }>;
  byKey: Map<string, string[]>;
};
```

`buildModelAliasIndex` 从 config 中构建别名映射，允许用户在 config 中定义自己的模型别名，比如把 `"my-fast-model"` 映射到 `"anthropic/claude-haiku-3-5"`。

---

## 12.3 模型选择的优先级链

模型选择的最终结果由多个来源按优先级叠加决定：

```
1. Session 级覆盖（/model 命令设置）          ← 最高优先级
2. Plugin hook 覆盖（before_model_resolve）
3. Sub-agent spawn 指定（model 参数）
4. Agent 配置（agents.list[n].model）
5. Agent 默认配置（agents.defaults.model）
6. 全局配置（agent.model）
7. 环境变量（OPENCLAW_MODEL）
8. 内置默认值（anthropic/claude-opus-4-6）   ← 最低优先级
```

`resolveDefaultModelForAgent` 按此优先级链解析最终模型。

### Sub-agent 模型解析

Sub-agent 的模型选择有额外逻辑：

```typescript
// 来自 spawn 调用时的 model 参数
resolveSubagentSpawnModelSelection({
  cfg, agentId, modelOverride
});
```

`normalizeModelSelection` 处理 model 参数可能是字符串或 `{primary?: string}` 对象两种形式，统一规范化为字符串。

---

## 12.4 Thinking / Reasoning 级别

**文件：** `src/agents/model-selection.ts`

不同模型对"思考"能力有不同的支持：

```typescript
type ThinkLevel =
  | "off"       // 不思考
  | "minimal"   // 最小思考（如 budget=1024）
  | "low"       // 低（budget=4096）
  | "medium"    // 中（budget=8192）
  | "high"      // 高（budget=16384）
  | "xhigh"     // 极高（budget=32768）
  | "adaptive"; // 模型自决（不设 budget，让模型自己决定）
```

`resolveThinkingDefault` 根据模型能力自动选择默认 thinking level。`resolveReasoningDefault` 决定推理模式（对 DeepSeek R1 等推理模型默认为 `"on"`，其他默认 `"off"`）。

### Thinking 降级

当模型返回 thinking level 相关错误时，外循环自动降级：

```
high → medium → low → minimal → off
```

降级后重试，直到成功或所有级别都失败。

---

## 12.5 Auth Profile 系统

**文件：** `src/agents/auth-profiles/`

这是 OpenClaw 最独特的设计之一——多凭证轮转 + cooldown + 自动恢复。

### 凭证类型

```typescript
// API Key
type ApiKeyCredential = {
  type: "api_key";
  provider: string;
  key?: string;
  keyRef?: SecretRef;    // 从 secrets 存储引用（不明文存储）
  email?: string;
  metadata?: Record<string, string>;  // provider 特定元数据
};

// 静态 Bearer Token
type TokenCredential = {
  type: "token";
  provider: string;
  token?: string;
  tokenRef?: SecretRef;
  expires?: number;      // 过期时间戳
  email?: string;
};

// OAuth
type OAuthCredential = OAuthCredentials & {
  type: "oauth";
  provider: string;
  clientId?: string;
  email?: string;
};
```

### Auth Profile Store 结构

```typescript
type AuthProfileStore = {
  version: number;
  profiles: Record<string, AuthProfileCredential>;  // profileId → 凭证
  order?: Record<string, string[]>;  // 每个 agent 的 profile 排列顺序覆盖
  lastGood?: Record<string, string>; // 每个 provider 最后成功的 profileId
  usageStats?: Record<string, ProfileUsageStats>;  // 每个 profile 的使用统计
};

type ProfileUsageStats = {
  lastUsed?: number;        // 最后使用时间戳
  cooldownUntil?: number;   // 冷却到期时间
  disabledUntil?: number;   // 禁用到期时间（billing/permanent auth 失败）
  disabledReason?: AuthProfileFailureReason;
  errorCount?: number;      // 连续失败次数（影响 cooldown 时长）
  failureCounts?: Partial<Record<AuthProfileFailureReason, number>>;
  lastFailureAt?: number;
};
```

### 失败原因的完整分类

```typescript
type AuthProfileFailureReason =
  | "auth"            // 认证失败（可能可恢复）
  | "auth_permanent"  // 永久认证失败（禁用更长时间）
  | "format"          // 凭证格式错误
  | "overloaded"      // 服务过载
  | "rate_limit"      // 速率限制
  | "billing"         // 账单/额度问题（禁用更长时间）
  | "timeout"         // 超时（不标记 profile 失败）
  | "model_not_found" // 模型不存在
  | "session_expired" // session 过期
  | "unknown";        // 未知错误
```

**重要设计：`timeout` 不标记 profile 失败。** 超时通常是网络问题，不应该惩罚某个特定的 auth profile。

### Profile 排序（resolveAuthProfileOrder）

```typescript
resolveAuthProfileOrder({
  cfg,
  store,
  provider,
  preferredProfile?,  // 用户显式指定的优先 profile
});
```

排序逻辑：

```
1. preferredProfile（显式指定，排在最前）
2. config 中定义的 order 覆盖（agent 级）
3. store 中记录的 order 覆盖（运行时设置的）
4. 按 lastUsed 排序（最近最少使用优先，LRU 风格）
5. 按 lastGood 排序（最近成功的排靠前）
```

LRU 风格的排序确保负载均匀分布在多个凭证之间，避免一个凭证被频繁使用而另一个闲置。

### Cooldown 计算（指数退避）

```typescript
function calculateAuthProfileCooldownMs(errorCount: number): number;
// errorCount=1: ~1分钟
// errorCount=2: ~5分钟
// errorCount=3: ~25分钟
// errorCount=4+: 最长 1 小时
```

连续失败次数越多，冷却时间越长（指数退避）。这防止一个频繁失败的 profile 不断被尝试。

### Cooldown 过期清理（clearExpiredCooldowns）

```typescript
function clearExpiredCooldowns(store: AuthProfileStore, now?: number): boolean;
```

这个函数解决了一个微妙 bug：如果不清理过期 cooldown，`errorCount` 会一直累积。下一次**任何**失败都会基于已经很高的 `errorCount` 计算出极长的 cooldown，导致 profile 看起来"卡住了"。

正确行为：cooldown 过期后（电路断路器半开 → 闭合），清除 `cooldownUntil`、`disabledUntil` 和 `errorCount`，给 profile 一个全新的开始。

### Transient Cooldown Probe

当**所有** profile 都在 cooldown 时，Pi 引擎不是直接放弃，而是尝试"探测"：

```
检查是否允许 transient probe
  → 允许（非关键任务、probe session）：
      选 cooldown 最短的 profile 试一下
      成功 → 立刻切换过来
      失败 → 继续等待
  → 不允许（关键任务）：
      抛 FailoverError
```

探测调用有频率限制（`MIN_PROBE_INTERVAL_MS = 30,000ms`），防止对同一 provider 频繁探测：

```typescript
export const _probeThrottleInternals = {
  readonly lastProbeAttempt: Map<string, number>;
  readonly MIN_PROBE_INTERVAL_MS: 30000;
  readonly PROBE_MARGIN_MS: number;
  readonly resolveProbeThrottleKey: typeof resolveProbeThrottleKey;
};
```

---

## 12.6 Model Failover：多模型回退链

**文件：** `src/agents/model-fallback.ts`

### 回退链配置

```json
{
  "agent": {
    "model": "anthropic/claude-opus-4-6",
    "fallback": [
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-4.1",
      "google/gemini-2.5-pro"
    ]
  }
}
```

### runWithModelFallback

```typescript
function runWithModelFallback<T>(params: {
  cfg,
  provider,
  model,
  agentDir?,
  fallbacksOverride?,    // 显式覆盖 fallback 列表（优先于 config）
  run: ModelFallbackRunFn<T>,
  onError?: ModelFallbackErrorHandler,
}): Promise<ModelFallbackRunResult<T>>;

type ModelFallbackRunResult<T> = {
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];  // 所有尝试记录（包括失败的）
};

type FallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: FailoverReason;
  status?: number;   // HTTP 状态码（如 429, 529, 401）
  code?: string;
};
```

### FailoverError

```typescript
class FailoverError extends Error {
  reason: FailoverReason;
  // "rate_limit" | "auth" | "billing" | "overloaded" |
  // "context_overflow" | "model_not_found" | "timeout" | ...
  provider: string;
  model: string;
  status?: number;
}
```

`FailoverError` 携带结构化上下文，让外循环能精确判断应该触发哪种恢复策略（切换 profile？切换模型？降级 thinking？指数退避？）。

### Abort vs Failover 的区分

```typescript
function isFallbackAbortError(err: unknown): boolean {
  // 用户按"停止生成"产生的 AbortError → 不触发 failover
  // 超时产生的 abort → 可以触发 failover（换个更快的模型）
  return err.name === "AbortError" && !isTimeoutError(err);
}
```

### 图片模型的 Failover

```typescript
function runWithImageModelFallback<T>(params: {
  cfg,
  modelOverride?,    // 覆盖图片模型选择
  run: (provider, model) => Promise<T>,
  onError?,
}): Promise<ModelFallbackRunResult<T>>;
```

图片分析（`image` 工具）有独立的 failover 链，与主模型的 failover 分开管理。

---

## 12.7 模型工具支持矩阵

**文件：** `src/agents/model-tool-support.ts`

```typescript
// 每个模型的工具调用能力
const MODEL_TOOL_SUPPORT: Record<string, ToolSupportLevel> = {
  "claude-opus-4-6":   { tools: true, parallel: true,  streaming: true },
  "gpt-4.1":           { tools: true, parallel: true,  streaming: true },
  "gemini-2.5-pro":    { tools: true, parallel: false, streaming: true },
  "deepseek-r1":       { tools: true, parallel: false, streaming: true },
  "llama3":            { tools: false },
  // ...
};
```

如果当前模型不支持 tool calling，Agent 退化为纯文本对话：所有工具（bash、搜索、消息发送）都不可用。这种退化是**静默的**——Agent 仍然可以回答问题，只是无法执行操作。

### 模型 Allowlist

```typescript
function buildAllowedModelSet(params: {
  cfg, catalog, defaultProvider, defaultModel?
}): {
  allowAny: boolean;          // true = 未配置 allowlist，允许所有模型
  allowedCatalog: ModelCatalogEntry[];
  allowedKeys: Set<string>;   // 允许的 "provider/model" key 集合
};
```

如果配置了模型 allowlist，`resolveAllowedModelRef` 在选择模型时会验证模型是否在 allowlist 中，拒绝未授权的模型（不管是用户请求还是 failover 链）。

---

## 12.8 Provider 能力发现

**文件：** `src/agents/models-config/`

```
models-config.providers.discovery.ts  # 动态发现（Ollama 等）
models-config.providers.static.ts     # 静态模型列表
models-config.providers.ts            # provider 注册
models-config.merge.ts                # 合并多来源模型信息
models-config.plan.ts                 # 模型配置计划
models-config.ts                      # 总入口
```

Ollama 是典型的动态发现案例——在本地运行，可用模型列表取决于用户下载了什么：

```
GET http://localhost:11434/api/tags
→ 返回已下载的模型列表
→ 合并到 OpenClaw 的模型目录
→ Agent 可以通过 /model 命令选择本地模型
```

---

## 12.9 模型目录（Model Catalog）

**文件：** `src/agents/model-catalog.ts`

Model Catalog 是一个内置的模型元数据库，包含已知模型的：

- 支持的功能（tool calling、vision、reasoning）
- Context window 大小
- 推荐的 thinking level 默认值
- 提供商特定配置

Catalog 与运行时配置合并：Catalog 提供基础值，用户的 config 可以覆盖（比如把某个模型的 context window 从 128k 改为 200k）。

---

## 12.10 Hook Gmail 模型

```typescript
function resolveHooksGmailModel(params: {
  cfg, defaultProvider
}): ModelRef | null;
```

Gmail hook（当新邮件到达时的处理逻辑）可以配置使用独立的模型，而不是 Agent 的主模型。这允许用邩便宜/快速的模型处理邮件分类，用高质量模型处理需要回复的邮件。

---

## 12.11 本章要点

模型管理系统的核心设计：

| 机制 | 解决的问题 |
|------|---------|
| Provider/Model 规范化 | 多种命名方式统一为一种 |
| Auth Profile 轮转 | 多凭证负载均衡 + cooldown 保护 |
| 指数退避 Cooldown | 失败越多，等待越长 |
| Transient Probe | 所有凭证都在等待时，探测最可能恢复的那个 |
| FailoverError | 结构化错误信息，精确触发恢复策略 |
| Thinking 降级 | 模型不支持高 thinking level 时自动降级 |
| Abort vs Timeout 区分 | 用户停止 ≠ 网络超时，后者可以 failover |
| Model Allowlist | 防止未授权模型被使用 |

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/agents/model-selection.ts` | ★★★ | 模型解析和规范化 |
| `src/agents/model-fallback.ts` | ★★★ | Failover 链和候选收集 |
| `src/agents/auth-profiles/usage.ts` | ★★★ | Cooldown 计算和清理 |
| `src/agents/auth-profiles/types.ts` | ★★★ | 凭证类型和 ProfileUsageStats |
| `src/agents/auth-profiles/order.ts` | ★★ | Profile 排序和资格检查 |
| `src/agents/failover-error.ts` | ★★ | FailoverError 类型 |
| `src/agents/model-tool-support.ts` | ★★ | 工具支持矩阵 |
| `src/agents/model-catalog.ts` | ★ | 模型元数据目录 |
| `src/agents/models-config.ts` | ★ | 模型配置合并入口 |
