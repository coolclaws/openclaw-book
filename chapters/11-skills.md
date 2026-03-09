# 第 11 章 Skill 平台

## 11.1 Skill 的本质

Skill 不是代码插件，而是**给 Agent 看的操作手册**。每个 Skill 是一个 Markdown 文件（`SKILL.md`），描述一项特定能力的操作方法：调用哪些工具、按什么顺序、用什么参数。

```
用户："帮我查天气"
  → Agent 扫描 system prompt 中的 <available_skills>
  → 发现 weather skill 的描述匹配
  → read("/path/to/weather/SKILL.md")
  → 按 SKILL.md 指引调用 web_fetch 获取数据
  → 格式化返回给用户
```

这是**纯提示词层面的扩展**，不需要修改代码，不需要重启服务。任何人都可以写一个 SKILL.md 来扩展 Agent 的能力。

---

## 11.2 Skill 文件结构

一个完整的 Skill 目录：

```
skills/weather/
├── SKILL.md      # 主文件（必须）
├── assets/       # 可选：辅助资源
└── scripts/      # 可选：可执行脚本
```

### SKILL.md 的 frontmatter

```yaml
---
name: weather
description: >
  Get current weather and forecasts via wttr.in or Open-Meteo.
  Use when user asks about weather, temperature, or forecasts.
  NOT for: historical data, severe alerts.
always: false
skillKey: weather
primaryEnv: OPENWEATHER_KEY
emoji: 🌤
homepage: https://clawhub.com/skills/weather
os: [darwin, linux]
requires:
  bins: [curl]
  anyBins: [wget, curl]
  env: [OPENWEATHER_KEY]
  config: [weather.apiKey]
install:
  - kind: brew
    formula: wttr
    bins: [wttr]
  - kind: node
    package: weather-cli
    bins: [weather]
---

# Weather Skill

## 使用方法

当用户询问天气时...
（以下是完整的操作说明）
```

---

## 11.3 完整类型定义

```typescript
type OpenClawSkillMetadata = {
  always?: boolean;          // true = 始终注入完整内容，无需 Agent 主动读取
  skillKey?: string;         // 唯一标识符（用于过滤和 env 覆盖）
  primaryEnv?: string;       // 主依赖环境变量
  emoji?: string;
  homepage?: string;
  os?: string[];             // ["darwin", "linux", "win32"]（平台限制）
  requires?: {
    bins?: string[];         // 全部都要有（AND 关系）
    anyBins?: string[];      // 有一个就行（OR 关系）
    env?: string[];          // 需要的环境变量
    config?: string[];       // 需要的 openclaw.json config 字段
  };
  install?: SkillInstallSpec[];
};

type SkillInstallSpec = {
  kind: "brew" | "node" | "go" | "uv" | "download";
  label?: string;
  bins?: string[];           // 安装后提供的命令行工具
  os?: string[];             // 限定操作系统
  formula?: string;          // brew formula
  package?: string;          // npm/go/uv 包名
  module?: string;           // node 模块名（如果 package 和 module 不同）
  url?: string;              // 下载 URL（kind=download）
  archive?: string;          // 压缩包内路径
  extract?: boolean;         // 是否解压
  stripComponents?: number;  // tar --strip-components
  targetDir?: string;        // 安装目标目录
};
```

---

## 11.4 四个来源与优先级

```typescript
// 1. 内置 Skill（随 OpenClaw 打包）
resolveBundledAllowlist()    // 按 config 的 allowlist 过滤
isBundledSkillAllowed()      // 是否在白名单中

// 2. Workspace Skill（用户自定义）
loadWorkspaceSkillEntries()  // 扫描 ~/workspace/skills/*/SKILL.md

// 3. 插件 Skill
plugin-skills.ts             // 插件通过 SDK 注册

// 4. 远程 Skill（从 clawhub.com 安装）
syncSkillsToWorkspace()      // 同步到本地 workspace
```

**同名冲突优先级（高 → 低）：** Workspace > 插件 > 内置

这允许用户通过在 workspace 放置同名 SKILL.md 来覆盖内置 Skill，实现个性化定制。

---

## 11.5 按需加载设计

### Step 1：构建描述摘要（system prompt 构建时）

```typescript
buildWorkspaceSkillsPrompt()
```

输出：

```xml
<available_skills>
  <skill>
    <name>weather</name>
    <description>Get current weather and forecasts...</description>
    <location>/Users/claw/.openclaw/workspace/skills/weather/SKILL.md</location>
  </skill>
  <skill>
    <name>discord</name>
    <description>Discord ops via the message tool...</description>
    <location>/opt/homebrew/.../skills/discord/SKILL.md</location>
  </skill>
  ...（最多几十个 skill，只含名称+描述+路径）
</available_skills>
```

### Step 2：Agent 按需读取（运行时）

```
Agent 判断需要 weather skill
  → read("/path/to/weather/SKILL.md")  // 消耗约 500-2000 token
  → 获得完整操作手册
  → 按手册操作
```

### Token 节省效果

| 场景 | 消耗 |
|------|------|
| 预加载所有 50 个 Skill 的完整内容 | ~50,000 token/次 |
| 按需加载（通常只需 1-2 个）| ~2,000 + 1,000 × n token |

在 Agent 只需要 2 个 Skill 的典型场景下，按需加载节省约 46,000 token——相当于节省了大约 23% 的 200k context window。

### 约束：每次最多预读一个

System prompt 中有明确约束：

```
"Constraints: never read more than one skill up front; only read after selecting."
```

防止 Agent 一次性读取多个 Skill 导致 context 被快速消耗。

---

## 11.6 always: true 的 Skill

标记 `always: true` 的 Skill 会在每次请求时自动注入完整内容，不需要 Agent 主动读取：

```yaml
---
always: true
---
```

适用场景：
- Skill 内容很短（< 500 token）
- Agent 几乎每次请求都需要它
- Skill 的描述本身就需要读完整内容才能判断是否需要

例如 memory 相关的 Skill 通常标记为 `always: true`，因为 Agent 在几乎每次请求前都需要执行 memory recall。

---

## 11.7 Skill Commands（命令快捷方式）

每个 Skill 可以注册用户可调用的 slash 命令：

```typescript
type SkillCommandSpec = {
  name: string;           // 命令名（如 "weather"）
  skillName: string;      // 对应的 Skill
  description: string;
  dispatch?: SkillCommandDispatchSpec;
};

type SkillCommandDispatchSpec = {
  kind: "tool";
  toolName: string;   // 直接调用这个工具
  argMode?: "raw";    // 将用户参数原样传入
};
```

### 短路 dispatch

`dispatch.kind = "tool"` + `argMode = "raw"` 实现了"绕过 LLM 直接调工具"的路径：

```
用户：/weather 北京
  ↓ 不经过 LLM
  → 直接调用 weather_fetch(args="北京")
  → 返回结果
  → 节省一次 LLM 调用
```

这对高频、低复杂度的操作（查天气、查汇率）有显著的延迟和成本优势。

---

## 11.8 调用策略

```typescript
type SkillInvocationPolicy = {
  userInvocable: boolean;           // 用户可以用 slash 命令触发
  disableModelInvocation: boolean;  // 禁止 Agent 自主触发
};
```

`disableModelInvocation = true` 用于高权限或高成本的 Skill（发邮件、发 Twitter、修改系统配置），确保只有用户明确要求时才执行，Agent 不会自作主张。

---

## 11.9 环境变量覆盖

**文件：** `src/agents/skills/env-overrides.ts`

Skill 可以声明依赖的环境变量（通过 `primaryEnv`），用户可以在 config 中为特定 Skill 配置覆盖值：

```json
{
  "skills": {
    "weather": {
      "env": {
        "OPENWEATHER_KEY": "your_api_key_here"
      }
    }
  }
}
```

`applySkillEnvOverrides` 在 Skill 执行时将这些变量注入到工具的执行环境中，不污染全局进程环境。

---

## 11.10 Skill 的资格检查

在将 Skill 包含到 system prompt 之前，`filterWorkspaceSkillEntries` 检查资格：

```typescript
type SkillEligibilityContext = {
  remote?: {
    platforms: string[];      // 当前平台（"darwin", "linux"...）
    hasBin: (bin) => boolean; // 检查命令是否存在
    hasAnyBin: (bins) => boolean;
    note?: string;
  };
};
```

检查项：
1. **平台匹配**：Skill 的 `os` 字段是否包含当前平台
2. **依赖工具**：`requires.bins`（ALL）/ `requires.anyBins`（ANY）是否都存在
3. **环境变量**：`requires.env` 中的变量是否已设置
4. **Config 字段**：`requires.config` 中的字段是否已配置

不满足条件的 Skill 不出现在 `<available_skills>` 列表中，避免 Agent 尝试调用一个注定失败的 Skill。

---

## 11.11 本章要点

- Skill 是纯 Markdown 的操作手册，不是代码插件——零代码扩展能力
- 按需加载设计在典型场景下节省约 46,000 token/次
- 四个来源，Workspace 优先级最高，允许用户覆盖内置 Skill
- Skill Commands 支持短路 dispatch，绕过 LLM 直接调用工具
- `disableModelInvocation` 保护高权限 Skill 不被 Agent 自主触发
- 资格检查确保 Agent 不会尝试使用不满足依赖的 Skill

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/agents/skills/types.ts` | ★★★ | 完整类型定义 |
| `src/agents/skills/workspace.ts` | ★★★ | Skill 加载 + prompt 生成 |
| `src/agents/skills/config.ts` | ★★ | 内置 Skill 配置与过滤 |
| `src/agents/skills/filter.ts` | ★★ | 资格检查逻辑 |
| `src/agents/skills/env-overrides.ts` | ★ | 环境变量覆盖 |
| `src/agents/skills/frontmatter.ts` | ★ | frontmatter 解析 |
