# 第 15 章 辅助子系统

## 15.1 记忆系统：`src/memory/`

记忆系统让 Agent 能够跨 session 记住信息。

```
src/memory/
├── search.ts          # 记忆搜索
├── store.ts           # 记忆存储
├── index.ts           # 入口
└── ...

extensions/memory-core/     # 记忆核心插件
extensions/memory-lancedb/  # LanceDB 向量存储后端
```

记忆是一个特殊的插件槽位——同一时间只能有一个记忆插件激活。Agent 通过 `memory_search` 工具查询记忆。

## 15.2 浏览器控制：`src/browser/`

OpenClaw 可以控制一个专属的 Chrome/Chromium 实例：

```
src/browser/
├── launch.ts          # 浏览器启动
├── snapshot.ts        # 页面快照
├── actions.ts         # 浏览器动作（点击、输入等）
├── profiles.ts        # 浏览器配置文件
├── upload.ts          # 文件上传
└── ...
```

使用 CDP（Chrome DevTools Protocol）控制浏览器。Agent 通过 `browser` 工具执行网页操作、截图、填表等。

## 15.3 定时任务：`src/cron/`

```
src/cron/
├── scheduler.ts       # 调度器
├── store.ts           # 任务持久化
├── executor.ts        # 任务执行
└── ...
```

Agent 可以通过 `cron` 工具创建定时任务，如每天早上 8 点发送天气预报。任务持久化到文件系统，Gateway 重启后恢复。

## 15.4 基础设施：`src/infra/`

`infra/` 是一个大型基础设施目录（2.1MB），提供底层支撑：

| 文件/子目录 | 说明 |
|------------|------|
| `env.ts` | 环境变量规范化 |
| `dotenv.ts` | .env 文件加载 |
| `ports.ts` | 端口管理（可用性检查、占用检测） |
| `binaries.ts` | 外部二进制管理（signal-cli 等） |
| `runtime-guard.ts` | Node.js 版本检查 |
| `is-main.ts` | 主模块检测 |
| `errors.ts` | 错误格式化 |
| `path-env.ts` | PATH 环境变量管理 |
| `warning-filter.ts` | Node.js 警告过滤 |
| `unhandled-rejections.ts` | 未处理 Promise rejection |
| `git-commit.ts` | Git commit hash 解析 |

## 15.5 日志系统：`src/logging/`

```
src/logging/
├── subsystem.ts       # 子系统日志器
├── structured.ts      # 结构化日志
└── ...

src/logging.ts         # 全局日志入口（console capture）
src/logger.ts          # 基础 logger
```

日志系统将 `console.log/warn/error` 捕获为结构化日志，同时保持 stdout/stderr 行为。每个子系统（gateway、agent、channel 等）有自己的 logger。

## 15.6 进程管理：`src/process/`

```
src/process/
├── exec.ts            # 命令执行（runExec, runCommandWithTimeout）
├── child-process-bridge.ts  # 子进程桥接（信号转发）
└── ...
```

提供统一的子进程执行接口，处理超时、信号转发、输出捕获等。

## 15.7 TTS（文本转语音）：`src/tts/`

```
src/tts/
├── elevenlabs.ts      # ElevenLabs 集成
├── provider.ts        # TTS provider 接口
└── ...
```

用于 Voice Wake 和 Talk Mode 场景，将 Agent 回复转为语音。

## 15.8 Daemon 管理：`src/daemon/`

```
src/daemon/
├── install.ts         # 安装为系统服务（launchd/systemd）
├── uninstall.ts       # 卸载服务
├── status.ts          # 服务状态
└── ...
```

`openclaw onboard --install-daemon` 会将 Gateway 安装为系统后台服务。

## 15.9 Context Engine：`src/context-engine/`

上下文引擎处理 Agent 的上下文构建——如何组装发送给 LLM 的完整上下文（system prompt + 历史消息 + 工具结果 + 附件）。

## 15.10 Link Understanding：`src/link-understanding/`

当消息中包含链接时，自动获取链接内容并注入上下文，让 Agent 能够理解引用的网页内容。

## 15.11 Skills 平台

Skills 在 `src/agents/skills*.ts` 和 `skills/` 目录中：

```
src/agents/
├── skills.ts                    # Skills 主逻辑
├── skills-install.ts            # 技能安装
├── skills-install-download.ts   # 技能下载
├── skills-install-extract.ts    # 技能解压
├── skills-status.ts             # 技能状态
└── ...

skills/                          # 内置技能目录（50+）
```

技能可以从 ClawHub（`clawhub.ai`）安装，也可以手动放置在 workspace 中。

## 15.12 本章要点

本章覆盖的辅助子系统各自独立，按需阅读即可。最重要的是理解它们的存在和职责，在需要时知道去哪里找代码。

### 推荐阅读的源文件

| 文件 | 说明 |
|------|------|
| `src/memory/` | 记忆系统（如果你对 RAG 感兴趣） |
| `src/browser/` | 浏览器控制（如果你对 Agent 自动化感兴趣） |
| `src/infra/ports.ts` | 端口管理（理解 Gateway 启动机制） |
| `src/agents/skills.ts` | Skills 平台 |
| `src/cron/` | 定时任务 |
