# 附录 C：名词解释

本表收录 OpenClaw 源码与文档中出现的关键专有名词，按英文字母序排列。中文名词附英文对照，英文缩写附全称展开。

---

## A

**ACP（Agent Communication Protocol）**
外部 Agent 通信协议。OpenClaw 与外部编码 Agent（Claude Code、Codex、Gemini CLI 等）之间的对接层。OpenClaw 作为消息前端，外部 Agent 作为执行后端，通过 ACP 协议交换消息和工具调用。见第 20 章。

**ACPX**
ACP 扩展插件接口（ACP Extension）。供第三方实现新 ACP Runtime 后端的 SDK 接口，包含 `registerAcpRuntimeBackend` 等注册 API，让外部工具以插件形式接入 OpenClaw。

**Agent**
在 OpenClaw 中，Agent 是一个配置实体，定义了 AI 助手的行为规则（模型、工具策略、记忆路径等）。Agent 是无状态的配置；Session 才是有状态的对话历史。见第 10 章。

**AgentMessage**
Pi 引擎内部对单条对话消息的统一表示，包含角色（user / assistant / tool）、内容块、消息 ID 等。是 ContextEngine 接口各方法的基本数据单元。

**allow-from**
消息准入过滤规则。配置哪些发送方（用户 ID、角色、频道等）允许触发 Agent。未在 allow-from 规则内的消息默认被忽略。见 §6.x。

**API Key Rotation（API Key 轮转）**
当一个 API Key 请求失败时，自动切换到备用 Key 重试的机制。通过 `agents.auth-profiles` 配置多个凭据，系统自动管理轮转顺序。见 §24.10。

**AssembleResult**
`ContextEngine.assemble()` 的返回值，包含准备好送给模型的有序消息列表、估算 token 数，以及可选的引擎注入 system prompt 补充内容。

**Auth Profile（凭据档案）**
为同一 LLM Provider 配置多套凭据的机制，支持 API Key、OAuth Token 等类型。配合 Auth Profile 系统实现自动轮转、故障隔离和多账号管理。见 §24.10。

**auto-reply**
消息处理的主干流程模块（`src/auto-reply/`），负责消息封装、路由、分发、Agent 调用、回复分块、出境投递的完整链路。

---

## B

**Bootstrap（启动引导）**
①系统层面：Gateway 启动时按依赖顺序初始化各子系统的过程（见 §5.2）。
②ContextEngine 层面：`ContextEngine.bootstrap()` 方法，引擎在首次使用时导入历史消息，建立初始状态。
③Workspace 层面：`BOOTSTRAP.md` 文件，新 workspace 第一次运行时的引导脚本。

**Browser Control System（Browser 控制系统）**
基于 Playwright 的浏览器自动化模块，通过 `browser` 工具暴露给 Agent。支持截图、快照、点击、填表、导航等操作。沙箱模式下浏览器在独立 Docker 容器里运行。见第 17 章。

---

## C

**Channel（渠道）**
连接外部消息平台的适配层（Telegram、Discord、WhatsApp、Slack、Signal 等）。每个渠道实现 `OpenClawPlugin` 接口，将平台特定的消息格式转化为统一的内部表示。见第 22 章。

**Chunk（分块）**
长回复按字符/标记边界拆分后逐段发送的单元。分块策略避免单条消息过长，同时实现"打字机"效果。`pi-embedded-block-chunker` 负责分块逻辑，`outbound-delivery` 负责投递。见 §7.x。

**CLI（Command Line Interface）**
OpenClaw 的命令行入口（`openclaw` 命令），支持 `start`、`gateway`、`config`、`auth` 等子命令。见第 3 章。

**Compaction（历史压缩）**
当 Session 历史的 token 量接近模型上下文窗口上限时，将旧对话总结成摘要的过程。由 `compactEmbeddedPiSession` / `compactEmbeddedPiSessionDirect` 执行，支持分块、滚动摘要、渐进回退等策略。见 §13.5。

**Context Engine（上下文引擎）**
一个可插拔接口（`ContextEngine`），封装了"消息摄入 → 上下文组装 → 压缩"的全部生命周期。默认实现是 `LegacyContextEngine`，可通过 `plugins.slots.contextEngine` 替换为自定义引擎（如向量检索引擎）。见 §13.8。

**Context Window Guard（上下文窗口守卫）**
四层上下文防线的第一层。在每次 API 请求前检查消息总 token 是否超出模型窗口，超出时触发裁剪或 Compaction。见 §13.3。

**Cron（定时调度）**
内置调度引擎，支持 `"at"`（一次性）、`"every"`（固定间隔）、`"cron"`（Cron 表达式）三种调度类型。Cron job 可触发 systemEvent 或 isolated agentTurn。见第 9 章。

---

## D

**DM Scope（私信范围）**
消息路由时判断是否属于私信的规则维度，有 `"main"`、`"agent"`、`"all"`、`"none"` 四种取值。`"main"` 使跨渠道的私信共享同一个主会话。见 §6.6。

**Docker**
Sandbox 的底层容器运行时。OpenClaw 通过 Docker CLI 创建、管理隔离容器，为 Agent 的工具调用提供操作系统级隔离。见 §16.x。

---

## E

**Echo Tracker（回声追踪）**
消息去重机制，防止 Agent 自己发送的消息被自己监听到并再次触发回复（echo）。在群组场景尤为重要。见 §6.x。

**Exec Approval（执行审批）**
高安全级别配置下，Agent 在执行 `bash`/`exec` 工具前，向用户请求人工确认的机制。审批请求通过消息渠道发送，用户回复批准或拒绝。见 §24.9。

**Extension（扩展）**
比 Plugin 更轻量的扩展方式，通常以文件或目录形式加载，无需完整实现 Plugin 接口。可用于注入自定义 Prompt、工具或渠道行为。见第 23 章。

---

## F

**Failover（故障转移）**
当主模型请求失败时，自动切换到备用模型重试的机制。由 `model-fallback.ts` 实现，支持冷却探测（transient cooldown probe）和失败原因分类（`FailoverReason`）。见 §12.6。

---

## G

**Gateway**
OpenClaw 的后台守护进程，负责加载配置、初始化渠道、管理 Lane 队列、提供 WebSocket API 等。通过 `openclaw gateway start` 启动。见第 5 章。

**Group Gating（群组门控）**
群组消息过滤机制，决定群组里哪些消息应当触发 Agent 响应（如仅在被 @提及时响应）。见 §6.x。

**Group History（群组历史）**
多用户群组中，维护每个发送方消息上下文的子系统，确保 Agent 能区分不同用户的对话历史。见 §6.x。

---

## H

**Heartbeat（心跳）**
Gateway 定期向主会话发送的轮询消息，触发 Agent 检查是否有待办任务（邮件、日历、通知等）的机制。Agent 无需响应时回复 `HEARTBEAT_OK`。见 §5.x 和 AGENTS.md。

**Hook（钩子）**
Plugin 系统的扩展点。Gateway 在消息处理的关键节点（共 24 个 `PluginHookName`）触发对应 Hook，已注册的插件可在此注入自定义逻辑。见 §5.x 和 §21.3。

**Human Delay（人工延迟）**
模拟真人打字速度的延迟机制。回复发送前按字数计算等待时间，避免 AI 响应速度过快暴露机器人身份。见 §6.x。

---

## I

**Inbound Context（入站上下文）**
System Prompt 的一个可选段，包含由 OpenClaw 运行时生成的可信元数据（发送方信息、渠道类型、群组信息等），注入到 Agent 的系统提示中，与用户消息内容分开标注为可信。见 §11.2。

**Isolated Session（隔离会话）**
独立于主会话的会话，通常由 Cron job 或 Sub-agent 创建，拥有独立的历史和上下文，与主会话不共享状态。见 §9.5、§19.x。

---

## K

**Keyed Async Queue（键值异步队列）**
以 Session Key 为键的串行执行队列，保证同一 Session 的消息严格按顺序处理，避免并发竞态。Gateway 维护全局 Lane 注册表，每个 Session 对应一条 Lane。见 §5.x。

---

## L

**Lane（通道）**
Keyed Async Queue 的一个执行槽，对应一个 Session。同一 Lane 内的任务串行执行，不同 Lane 并行。Compaction 使用 Direct 版本（`compactEmbeddedPiSessionDirect`）以避免在 Lane 内部死锁。见 §5.x、§13.5。

**LanceDB**
一个嵌入式向量数据库，可作为 Context Engine 或 Memory 插件的存储后端，支持语义检索历史消息。通过 `memory-lancedb.d.ts` 暴露接口。见 §14.x。

**Legacy Context Engine**
默认的 ContextEngine 实现（`LegacyContextEngine`），将现有的四层上下文防线封装在 ContextEngine 接口后面，保持 100% 向后兼容。见 §13.8。

**LLM（Large Language Model，大语言模型）**
OpenClaw 调用的 AI 模型提供方（Anthropic Claude、OpenAI GPT、Google Gemini 等）。OpenClaw 通过统一的模型选择和 Failover 机制管理多个 LLM Provider。见第 12 章。

---

## M

**Main Session（主会话）**
与 Agent 所有者（Owner）进行私信的会话。同一 `dmScope="main"` 配置下，跨渠道的私信共享一个主会话。Agent 配置中 `agentId` 对应的主会话是权限最高的会话。

**Memory System（记忆系统）**
Agent 的长期与短期记忆机制，包括 Workspace 文件（`MEMORY.md`、`memory/*.md`）和可插拔的向量记忆引擎。通过 `memory_search` / `memory_get` 工具供 Agent 读写。见第 14 章。

**MsgContext**
消息上下文对象，消息在系统内流转的核心数据结构，包含 60+ 字段，涵盖路由信息、发送方身份、媒体附件、群组元数据、会话键等。见 §6.3。

---

## N

**Native Commands（原生命令）**
在 Discord、Slack 等支持服务端注册 Slash Command 的渠道里，以渠道原生方式（带自动补全和参数菜单）注册的命令，对比纯文本的 `/command` 形式更结构化。见 §22.5。

**Node（节点）**
配对到 OpenClaw Gateway 的物理或虚拟设备（手机、树莓派等），可通过 `nodes` 工具访问其摄像头、屏幕、通知、位置等能力。见 §26.x。

---

## O

**OpenClaw**
本书分析的开源 AI 助手网关系统。核心定位是：让 LLM 能够通过多种消息渠道（Telegram、Discord 等）与用户交互，同时管理工具调用、会话历史、安全隔离和扩展机制。

**Outbound Delivery（出境投递）**
处理 Agent 回复从内部格式到渠道格式转换、分块发送、重试、附件上传的子系统。见第 7 章。

**Owner（所有者）**
OpenClaw 的配置者/管理员。Owner 发送的消息拥有最高权限（senderIsOwner=true），可使用全部工具，不受 allow-from 限制。见 §24.x。

---

## P

**Pi Engine（Pi 引擎）**
OpenClaw 内置的 Agent 运行时，基于 `@mariozechner/pi-agent-core`。实现了外循环（消息入队）、中循环（提示构建与 API 调用）、内循环（流式处理与工具执行）的三层结构。见第 10 章。

**Plugin（插件）**
实现 `OpenClawPlugin` 接口的外部模块，可扩展渠道、注册工具、注入 Hook，通过 `plugins.paths` 加载。与 Extension 的区别：Plugin 遵循严格接口，生命周期由 Gateway 管理。见第 21 章。

**Plugin SDK**
OpenClaw 开放给插件开发者的类型定义和工具函数集合，位于 `dist/plugin-sdk/`，是开发渠道插件和 Context Engine 的官方接口。见第 21 章。

**Plugin Slot（插件槽）**
系统级可替换点，通过 `plugins.slots.*` 配置选择哪个插件占据该槽。目前有两个槽：`contextEngine`（上下文引擎）和 `memory`（记忆系统）。见 §13.8、§14.x。

**Prompt Caching（提示缓存）**
Anthropic 等 Provider 支持的 API 级别缓存机制，将高频重复的 System Prompt 内容标记为可缓存块，减少 token 费用。OpenClaw 在 System Prompt 组装时自动插入缓存控制标记。见 §11.2。

**Prompt Injection（提示注入）**
攻击者在用户消息中嵌入伪装的系统指令，试图操控 Agent 行为的攻击方式。OpenClaw 通过 `sanitizeInboundSystemTags` 过滤消息中的 `<system>` 等标签来防御。见 §6.x。

---

## R

**Reasoning（推理级别）**
控制模型思考深度的配置（`off` / `low` / `medium` / `high` / `max`）。支持推理的模型（如 Claude 3.7、o3）会在正式回复前输出思维链。可通过 `/reasoning` 命令实时切换。见 §12.4。

**Reply Dispatcher（回复分发器）**
将 Agent 的文本输出路由到正确会话和渠道的组件，处理预留 pending（防竞态）、Promise 链、Human Delay 等机制。见 §6.x。

**Route Resolution（路由解析）**
确定一条消息应由哪个 Agent 处理的过程，包含七层优先级匹配（thread 继承、角色匹配、DM 范围、频道来源等）和三层缓存。见 §6.6。

---

## S

**Sandbox（沙箱）**
基于 Docker 的操作系统级隔离机制，将 Agent 的工具执行限制在容器内，保护宿主机文件系统和网络。默认关闭，通过 `sandbox.mode` 开启。见第 16 章。

**Secret Ref（密钥引用）**
在配置中以 `$SECRET:xxx` 形式引用外部密钥，而不是直接明文写入配置文件的机制。OpenClaw 的 `secrets/` 模块在运行时解析这些引用，从环境变量或密钥存储中读取实际值。见 §24.6。

**Session（会话）**
Agent 与某个发送方之间的持久化对话历史，以 JSONL 文件形式存储在 `~/.openclaw/agents/{agentId}/sessions/` 目录。Session Key 唯一标识一个会话（含渠道、发送方、线程等信息）。见 §10.x。

**Skill（技能）**
可被 Agent 动态加载的 Markdown 指令文件（`SKILL.md`），由技能系统在运行时读取后注入 System Prompt，从而赋予 Agent 完成特定任务（如代码审查、天气查询）的能力。见第 18 章。

**Slash Command（斜杠命令）**
用户以 `/` 开头发送的命令（如 `/status`、`/compact`），在进入 Pi 引擎之前被系统拦截处理，不消耗 LLM token。支持文本形式（所有渠道）和原生注册形式（Discord、Slack）。见 §22.5。

**SSRF（Server-Side Request Forgery，服务端请求伪造）**
攻击者通过 Agent 的网络工具发起恶意内部请求的攻击方式。OpenClaw 在 `ssrf.ts` 中实现 IP 范围校验，阻止对内网地址的访问。见 §24.x。

**Sub-agent（子 Agent）**
由父 Agent 通过 `sessions_spawn` 工具派生的独立 Agent 实例，拥有独立的会话和上下文。父 Agent 等待子 Agent 通过广播（announce）回报完成状态后汇总结果。见第 19 章。

**System Prompt（系统提示）**
每次 API 请求时由 OpenClaw 组装并注入给 LLM 的上下文，包含工具列表、Skill 指令、记忆召回、日期时间等内容。组装顺序固定，部分区块会按条件开启。见第 11 章。

---

## T

**Thread Ownership（线程归属）**
消息线程（Thread）与特定 Agent 绑定的机制，确保同一线程内的后续消息自动路由到最初响应的 Agent，而非重新匹配路由。见 §6.6 和 `thread-ownership.d.ts`。

**Token Budget（Token 预算）**
分配给上下文组装和各子系统（工具结果、附件、历史消息等）的最大 token 量。Context Window Guard 和 Compaction 系统以此为触发阈值。见 §13.x。

**Tool Loop Detection（工具循环检测）**
防止 Agent 陷入重复工具调用的安全机制，维护 30 条调用历史的滑动窗口，检测四种循环模式（`generic_repeat`、`known_poll_no_progress`、`global_circuit_breaker`、`ping_pong`），分 `warning` 和 `critical` 两级处置。见 §15.8。

**Tool Policy（工具策略）**
决定 Agent 在某次会话中可使用哪些工具的配置规则，通过 allow/deny 列表和多级策略管道（全局→Agent→Session→动态）实现细粒度授权。见第 15 章。

**Tool Result Context Guard（工具结果上下文守卫）**
四层上下文防线的第二层，限制单次工具调用结果能写入上下文的最大 token 量，防止大型工具输出（如文件读取）撑爆上下文窗口。见 §13.4。

---

## W

**Workspace（工作目录）**
Agent 的主要工作文件目录，默认为 `~/.openclaw/workspace/`，存放 `MEMORY.md`、`SOUL.md`、`USER.md`、Skill 文件等持久化内容。Sub-agent 可以继承父 Agent 的 workspace 目录。见第 14 章、§19.x。
