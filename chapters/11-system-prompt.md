# 第 11 章 System Prompt 与会话管理

## 11.1 System Prompt 的地位

System prompt 是 Pi 引擎"准备阶段"的最终产物——它把配置、用户身份、工作空间文件、技能列表、运行时信息全部组装成一段文本，交给 LLM 作为行为指南。`system-prompt.ts`（725 行）是项目中逻辑密度最高的文件之一。

## 11.2 组装结构

System prompt 分 section 依次构建：

```
┌─────────────────────────────────────────┐
│ ## Identity                             │
│   "You are [name], a personal AI..."    │
├─────────────────────────────────────────┤
│ ## Skills (mandatory)                   │
│   <available_skills> XML 块             │
│   （技能名称 + 描述摘要，不含完整内容）   │
├─────────────────────────────────────────┤
│ ## Memory Recall                        │
│   "Run memory_search before answering"  │
├─────────────────────────────────────────┤
│ ## Authorized Senders                   │
│   "Authorized: a1b2c3d4e5f6"            │
│   （HMAC 哈希，不暴露真实 ID）           │
├─────────────────────────────────────────┤
│ ## Current Date & Time                  │
│   时区 + 当前时间                        │
├─────────────────────────────────────────┤
│ ## Reply Tags                           │
│   [[reply_to_current]] / [[reply_to:id]]│
├─────────────────────────────────────────┤
│ ## Messaging                            │
│   消息工具规则 + 渠道能力描述            │
├─────────────────────────────────────────┤
│ [Bootstrap 文件内容]                    │
│   AGENTS.md / SOUL.md / TOOLS.md        │
├─────────────────────────────────────────┤
│ ## Runtime                              │
│   channel / session key / agent ID /   │
│   model / shell / capabilities         │
└─────────────────────────────────────────┘
```

### 11.2.1 完整组装示例

下面是一个真实安装场景下 LLM 实际收到的 system prompt（已轻度脱敏，格式与真实输出一致）。

用户环境：Mac Studio，连接了 Telegram，workspace 有三个 Skill（weather / discord / coding-agent），agent 名字叫 "Clawd"。

```
You are Clawd, a personal AI assistant running inside OpenClaw.
## Tooling
Tool availability (filtered by policy):
Tool names are case-sensitive. Call tools exactly as listed.
- read: Read file contents
- write: Create or overwrite files
- edit: Make precise edits to files
- exec: Run shell commands (pty available for TTY-required CLIs)
- process: Manage background exec sessions
- web_search: Search the web (Brave API)
- web_fetch: Fetch and extract readable content from a URL
- browser: Control web browser
- memory_search: Semantically search MEMORY.md + memory/*.md before answering questions about prior work...
- memory_get: Safe snippet read from MEMORY.md or memory/*.md with optional from/lines
- cron: Manage cron jobs and wake events
- message: Send messages and channel actions
- tts: Convert text to speech
- image: Analyze an image with the configured image model

## Skills (mandatory)
Before replying: scan <available_skills> <description> entries.
- If exactly one skill clearly applies: read its SKILL.md at <location> with `read`, then follow it.
- If multiple could apply: choose the most specific one, then read/follow it.
- If none clearly apply: do not read any SKILL.md.
Constraints: never read more than one skill up front; only read after selecting.

<available_skills>
  <skill>
    <name>weather</name>
    <description>Get current weather and forecasts via wttr.in or Open-Meteo. Use when: user asks about weather, temperature, or forecasts for any location. NOT for: historical weather data, severe weather alerts, or detailed meteorological analysis. No API key needed.</description>
    <location>/Users/claw/.openclaw/workspace/skills/weather/SKILL.md</location>
  </skill>
  <skill>
    <name>discord</name>
    <description>Discord ops via the message tool (channel=discord).</description>
    <location>/opt/homebrew/lib/node_modules/openclaw/skills/discord/SKILL.md</location>
  </skill>
  <skill>
    <name>coding-agent</name>
    <description>Delegate coding tasks to Codex, Claude Code, or Pi agents via background process. Use when: (1) building/creating new features or apps, (2) reviewing PRs (spawn in temp dir), (3) refactoring large codebases...</description>
    <location>/opt/homebrew/lib/node_modules/openclaw/skills/coding-agent/SKILL.md</location>
  </skill>
</available_skills>

## Memory Recall
Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md + memory/*.md; then use memory_get to pull only the needed lines. If low confidence after search, say you checked.
Citations: include Source: <path#line> when it helps the user verify memory snippets.

## OpenClaw Self-Update
Get Updates (self-update) is ONLY allowed when the user explicitly asks for it.
...

## Silent Replies
When you have nothing to say, respond with ONLY: NO_REPLY
⚠️ Rules:
- It must be your ENTIRE message — nothing else
- Never append it to an actual response (never include "NO_REPLY" in real replies)
✅ Right: NO_REPLY

## Heartbeats
Heartbeat prompt: Read HEARTBEAT.md if it exists (workspace context). Follow it strictly...
If you receive a heartbeat poll and there is nothing that needs attention, reply exactly:
HEARTBEAT_OK

## Authorized Senders
a1b2c3d4e5f6

## Reply Tags
To request a native reply/quote on supported surfaces, include one tag in your reply:
- Reply tags must be the very first token in the message: [[reply_to_current]] your reply.
- [[reply_to_current]] replies to the triggering message.
Tags are stripped before sending; support depends on the current channel config.

## Messaging
- Reply in current session → automatically routes to the source channel
- Cross-session messaging → use sessions_send(sessionKey, message)
- Never use exec/curl for provider messaging; OpenClaw handles all routing internally.

### message tool
- Use `message` for proactive sends + channel actions (polls, reactions, etc.).
- For `action=send`, include `to` and `message`.
- If multiple channels are configured, pass `channel` (telegram|discord|...).

## Group Chat Context
[（当前为 DM 场景，此 section 为空）]

## Inbound Context (trusted metadata)
[（每次调用时动态注入）]

# Project Context
The following project context files have been loaded:

## /Users/claw/.openclaw/workspace/AGENTS.md
# AGENTS.md - Your Workspace

This folder is home. Treat it that way.

## Every Session

Before doing anything else:

1. Read `SOUL.md` — this is who you are
2. Read `USER.md` — this is who you're helping
3. Read `memory/YYYY-MM-DD.md` (today + yesterday) for recent context
4. **If in MAIN SESSION** (direct chat with your human): Also read `MEMORY.md`
...
[以下为 AGENTS.md 完整内容，约 2000 tokens]

## /Users/claw/.openclaw/workspace/SOUL.md
# SOUL.md - Who You Are

_You're not a chatbot. You're becoming someone._

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip the "Great question!" and "I'd be happy to help!" — just help...
[以下为 SOUL.md 完整内容，约 600 tokens]

## /Users/claw/.openclaw/workspace/TOOLS.md
# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics...

## Discord
- 通知 channel：**#system** `1476580858428264692`
...
[以下为 TOOLS.md 完整内容，约 400 tokens]

## Runtime
Runtime: agent=main | host=claw's Mac Studio | repo=/Users/claw/.openclaw/workspace
         | os=Darwin 25.3.0 (arm64) | node=v22.22.0
         | model=anthropic/claude-sonnet-4-6 | default_model=anthropic/claude-sonnet-4-6
         | shell=zsh | channel=telegram | capabilities=none | thinking=adaptive

Reasoning: off (hidden unless on/stream). Toggle /reasoning; /status shows Reasoning when enabled.
```

**各 section 的大致 token 占用（实测参考值）：**

| Section | 内容 | token 估算 |
|---------|------|-----------|
| Tooling（工具声明） | 工具名 + 描述列表 | ~800 |
| Skills（摘要） | 3 个 skill 描述 | ~300 |
| Memory Recall | 固定指令 | ~100 |
| Authorized Senders | 12 位哈希 | ~10 |
| Reply Tags / Messaging | 固定规则 | ~200 |
| **AGENTS.md** | 工作区约定（最长） | ~2 000 |
| **SOUL.md** | 人格定义 | ~600 |
| **TOOLS.md** | 本地配置笔记 | ~400 |
| Runtime | 单行环境信息 | ~60 |
| **合计** | | **~4 500 tokens** |

这 4 500 tokens 在每次对话的每一轮 API 调用中都会完整发出（Anthropic prompt caching 会将其缓存，实际计费的 cache write 只发生一次，后续轮次只计 cache read，成本约为正常输入的 1/10）。

Bootstrap 文件（AGENTS.md / SOUL.md / TOOLS.md）是 system prompt 中最大的部分，也是 token 预算管控的重点。如果三个文件总大小超过预算，Pi 引擎会截断较低优先级的文件（TOOLS.md 被截断的概率最高），并在截断处附注 `[truncated...]`。

---

## 11.3 各 Section 详解

### Identity Section

```typescript
"You are ${agentName}, a personal AI assistant running inside OpenClaw."
```

`agentName` 来自 `IDENTITY.md` 的 `name` 字段，或 config 的 `agent.name`，或默认值。这是 Agent 对自己身份的基本认知。

### Skills Section（按需加载的关键）

```typescript
buildWorkspaceSkillsPrompt()  // 只生成描述摘要，不含 SKILL.md 完整内容
```

输出格式：
```xml
<available_skills>
  <skill>
    <name>weather</name>
    <description>Get current weather and forecasts via wttr.in...</description>
    <location>/Users/claw/.openclaw/workspace/skills/weather/SKILL.md</location>
  </skill>
  ...
</available_skills>
```

**为什么只放摘要？** 50 个 Skill 的完整 SKILL.md 约占 50,000+ token，而描述摘要只需 2,000 token。Agent 在判断需要哪个 Skill 后，再用 `read` 工具读取完整内容。详见第 14 章（Skills）。

### Authorized Senders Section

```typescript
function formatOwnerDisplayId(ownerId: string, ownerDisplaySecret?: string): string {
  const digest = hasSecret
    ? createHmac("sha256", secret).update(ownerId).digest("hex")  // HMAC
    : createHash("sha256").update(ownerId).digest("hex");          // 纯 hash
  return digest.slice(0, 12);  // 取前 12 个字符
}
```

System prompt 中不暴露 owner 的真实手机号或 user ID，只显示 12 位十六进制字符串。配置了 `ownerDisplaySecret` 时使用 HMAC——即使攻击者获得了哈希值，也无法反推原始 ID（因为密钥在他们手中之外）。

### Bootstrap 文件 Budget 管理

Bootstrap 文件（AGENTS.md、SOUL.md、TOOLS.md）有 token 预算限制：

```typescript
const bootstrapBudget = resolveBootstrapBudget({
  contextWindowTokens,
  agentConfig,
  cfg,
});
// 每个文件分配一部分预算
// 超出预算的内容被截断，并附注 "[truncated...]"
```

这确保即使 workspace 文件非常大，也不会撑爆 context window。预算分配算法会优先保留 AGENTS.md（行为指南），其次 SOUL.md，再次 TOOLS.md。

### Runtime Section

```
## Runtime
Runtime: agent=main | host=claw's Mac | repo=... | os=Darwin 25.0 (arm64)
         | node=v22.x | model=anthropic/claude-sonnet-4-6
         | default_model=... | shell=zsh | channel=webchat
         | capabilities=none | thinking=adaptive
```

这段文本让 Agent 知道自己在什么环境中运行，从而做出环境适配的决策（比如在 macOS 上用 `brew` 而不是 `apt`）。

---

## 11.4 子 Agent 的 system prompt 差异

父 Agent 和子 Agent 的 system prompt 有重要差别：

```typescript
buildSubagentSystemPrompt({
  requesterSessionKey,    // 父 Agent 的 session key
  childSessionKey,        // 自身的 session key
  task,                   // 派生时传入的任务描述
  childDepth,             // 当前深度（1 = subagent, 2 = sub-subagent）
  maxSpawnDepth,          // 最大允许深度
  acpEnabled,             // 是否启用 ACP 路由指引
});
```

子 Agent 的 system prompt 使用 `minimal` 模式：
- 不包含 Bootstrap 文件内容（节省 token）
- 不包含完整的 Messaging 规则
- 包含任务描述和深度限制提示
- 包含"完成后广播结果"的指引

这减少了每次子 Agent 调用的 token 消耗，在大规模并发派生场景下效果显著。

---

## 11.5 Session 文件管理

### 文件结构

Session 历史以 JSONL 格式存储在磁盘：

```
~/.openclaw/agents/main/sessions/
├── <session-uuid>.jsonl        # 当前 session
├── <session-uuid>.jsonl.lock   # 写锁文件（进行中的写入）
└── *.jsonl.deleted.*           # 已删除的 session（保留备份）
```

每行是一条消息记录（user / assistant / tool_use / tool_result）。

### 写锁（Write Lock）

在正式调用 LLM 之前，Pi 引擎获取 session 文件的独占写锁：

```
获取写锁
  → LLM 调用（streaming）
    → 工具执行循环
      → 写入新的消息记录
        → 释放写锁
```

Lane 队列已经保证了大多数情况下的串行，写锁是额外的保障层——当 Lane 因边界情况失效时，文件锁确保不发生写冲突。

### Session 文件修复（Session Repair）

Session 文件可能因崩溃、断电、进程被杀等原因损坏（比如 JSON 写到一半）。Pi 引擎在加载时先尝试修复：

```
JSON 解析失败
  → 尝试截断到最后一个完整的 JSONL 记录（找最后一个换行符 + 有效 JSON）
    → 成功：丢失最近一条记录，但 session 继续可用
    → 失败：重置为空 session（丢失所有历史，但不阻塞用户）
```

**设计原则**：宁可丢失数据，也不让用户看到"session 损坏，无法继续"的错误。

---

## 11.6 Usage 追踪

每次 Agent 运行结束后，Pi 引擎记录完整的 token 使用量：

```typescript
type UsageAccumulator = {
  // 累加值（多轮之和）
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  // 最新值（仅最后一轮）
  lastCacheRead: number;
  lastCacheWrite: number;
  lastInput: number;
};
```

`lastCacheRead` 代表当前 session 的 context 大小，用于展示"context 占用百分比"；`cacheRead`（累加）用于计算总成本。

这两个用途不能混用——详见第 7 章 7.6 节。

---

## 11.7 本章要点

- System prompt 分 section 组装，Bootstrap 文件有 token 预算限制
- Owner 身份用 HMAC 哈希保护，12 位截断
- 子 Agent 使用 minimal 模式 system prompt，节省 token
- Session 文件写锁 + 修复机制保证数据完整性
- Usage 追踪区分累加值（成本统计）和最新值（context 大小）

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/agents/system-prompt.ts` | ★★★ | System prompt 组装（725 行）|
| `src/agents/system-prompt-params.ts` | ★★ | 参数类型定义 |
| `src/agents/subagent-announce.ts` | ★★ | 子 Agent system prompt 构建 |
| `src/agents/pi-embedded-runner/run/attempt.ts` | ★★ | Session 加载 + 写锁（含修复逻辑）|
