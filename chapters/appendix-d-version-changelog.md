# 附录 D：版本更新追踪

> **成书版本：`v2026.3.9`**
>
> 本附录持续追踪成书后的版本变化。每个版本按影响的章节分类，老读者可直接跳到感兴趣的章节复习。

---

## v2026.3.12

**发布日期：** 2026 年 3 月 12 日

### 🆕 新功能 · 按章节索引

| 变更 | 涉及章节 |
|------|---------|
| Control UI v2 全面重构：模块化 dashboard、命令面板、移动端底栏、斜杠命令、消息搜索与导出 | [第 25 章 · 前端与伴侣应用](/chapters/25-frontend) |
| Fast Mode 支持（GPT-5.4 / Anthropic Claude）：`/fast` 开关、`params.fastMode`、`service_tier` 透传 | [第 12 章 · 模型选择](/chapters/12-model-selection) |
| Ollama、vLLM、SGLang 迁移至 Provider Plugin 架构，支持 onboarding 钩子和 model picker | [第 12 章 · 模型选择](/chapters/12-model-selection) · [第 21 章 · Plugin SDK](/chapters/21-plugin-sdk) |
| `sessions_yield` 工具：让编排器主动结束当前 turn，跳过剩余 tool work | [第 19 章 · Sub-agent 系统](/chapters/19-subagent) |
| Slack Block Kit 消息：通过 `channelData.slack.blocks` 发送 Block Kit 格式回复 | [第 22 章 · 消息渠道实现](/chapters/22-channels) |
| 记忆系统：compaction 后即时重新索引（`postCompactionForce`） | [第 14 章 · 记忆系统](/chapters/14-memory) |
| 上下文引擎：`sessionKey` 透传至 lifecycle 各阶段（bootstrap、assembly、compaction） | [第 13 章 · 上下文管理](/chapters/13-context-management) |
| Cron 主动投递修复：隔离直投不再进入重发队列，防止重启后重复发送 | [第 9 章 · Cron 调度引擎](/chapters/09-cron) |
| ACP：末尾消息快照（`end_turn` 前保留最终 assistant text） | [第 20 章 · ACP：外部 Agent 通信协议](/chapters/20-acp) |
| Kubernetes 安装路径（raw manifests + Kind）| 暂无对应章节（新增部署形态） |

### 🔒 安全修复

> 本版本包含 **20+ 个安全修复**，覆盖面极广。建议关注安全章节的读者整体重读。

**涉及章节：[第 24 章 · 安全模型](/chapters/24-security)**

主要修复包括：

- **exec 审批防绕过**：Unicode 不可见字符转义、Ruby `-r` 加载标志、内联 loader 和 shell payload 绑定（5 个 CVE）
- **设备配对**：配对码改为短期 bootstrap token；设备 token scope 上限收紧
- **WebSocket 预认证**：缩短 unauthenticated 握手保留时长，拒绝超大预认证帧
- **Plugin 隔离**：禁用工作区插件自动加载（`GHSA-99qw-6mr3-36qr`）
- **沙箱写入**：修复 sandbox `write` 创建空文件的 bug；stage 写入锁定到验证父目录
- **命令权限**：`/config`、`/debug` 要求发送方为 owner；`sessions_yield` 会话树可见性限制
- **WebSocket 共享 token**：清除未绑定设备的自声明 scope
- **Browser 控制**：阻止通过 `browser.request` 持久化 admin 级操作
- **Webhook 安全**：Feishu、LINE、Zalo、Slack、Teams 均修复了签名/授权验证漏洞

---

## v2026.3.11

**发布日期：** 2026 年 3 月 11 日

### ⚠️ Breaking Change

| 变更 | 涉及章节 |
|------|---------|
| **Cron 隔离投递收紧**：cron job 不再允许通过临时 agent send 或 main-session 汇总投递，需用 `openclaw doctor --fix` 迁移旧存储 | [第 9 章 · Cron 调度引擎](/chapters/09-cron) |

### 🆕 新功能 · 按章节索引

| 变更 | 涉及章节 |
|------|---------|
| 记忆系统：多模态索引（图片 + 音频），新增 `gemini-embedding-2-preview` embedding 支持，可配置输出维度 | [第 14 章 · 记忆系统](/chapters/14-memory) |
| ACP：`sessions_spawn` 新增 `resumeSessionId`，可恢复已有 Codex/ACPX 会话 | [第 20 章 · ACP：外部 Agent 通信协议](/chapters/20-acp) |
| Gateway：节点挂起队列原语（`node.pending.enqueue` / `node.pending.drain`），为离线节点工作投递奠基 | [第 5 章 · Gateway 控制平面](/chapters/05-gateway) |
| CLI：子进程环境注入 `OPENCLAW_CLI` 标记 | [第 3 章 · 入口与 CLI 系统](/chapters/03-entry-and-cli) |
| iOS：Home Canvas 重构（欢迎屏、固定工具栏）；push relay（App Attest + 收据验证） | [第 25 章 · 前端与伴侣应用](/chapters/25-frontend) |
| macOS：chat UI 新增模型选择器，thinking level 跨重启保持 | [第 25 章 · 前端与伴侣应用](/chapters/25-frontend) |
| 渠道：Discord 自动归档时长可配置（`autoArchiveDuration`）；Mattermost 新增 `replyToMode` | [第 22 章 · 消息渠道实现](/chapters/22-channels) |
| Onboarding：Ollama 本地/混合模式一键配置；OpenCode Go provider | [第 3 章 · 入口与 CLI 系统](/chapters/03-entry-and-cli) · [第 12 章 · 模型选择](/chapters/12-model-selection) |

### 🔒 安全修复

**涉及章节：[第 24 章 · 安全模型](/chapters/24-security)**

- **WebSocket 跨站劫持**：`trusted-proxy` 模式下强制执行 browser origin 验证（`GHSA-5wcw-8jjv-m286`）

---

## 如何使用本附录

1. **刚读完本书的读者**：从 `v2026.3.11` 的 Breaking Change 开始看，确认 Cron 用法是否受影响。
2. **只关心安全的读者**：直接看 `v2026.3.12` 安全修复一节，配合[第 24 章](/chapters/24-security)全面补课。
3. **关注 Agent 编排的读者**：关注 `sessions_yield`（[第 19 章](/chapters/19-subagent)）和 `resumeSessionId`（[第 20 章](/chapters/20-acp)）两处新增。
4. **后续版本**：每次 OpenClaw 更新后，本附录会同步更新，新增版本条目追加在顶部。
