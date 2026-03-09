# 第 3 章 入口与 CLI 系统

## 3.1 程序入口：`src/entry.ts`

当你在终端执行 `openclaw` 命令时，实际调用的是 `openclaw.mjs`（npm bin wrapper），它会加载 `dist/entry.js`（由 `src/entry.ts` 编译而来）。

`entry.ts` 做了以下几件事：

**1. Main Module Guard**

```typescript
if (!isMainModule({ currentFile: fileURLToPath(import.meta.url), ... })) {
  // 作为依赖被导入时，跳过所有入口副作用
} else {
  // 作为主模块运行时，执行启动逻辑
}
```

这个 guard 很重要：构建工具可能会把 `entry.js` 作为共享依赖导入，没有这个 guard 就会启动两个 Gateway 实例。

**2. Node.js Respawn（实验性警告抑制）**

```typescript
function ensureExperimentalWarningSuppressed(): boolean {
  // 如果当前 Node 进程没有 --disable-warning=ExperimentalWarning
  // 就 spawn 一个新进程带上这个 flag
  const child = spawn(process.execPath,
    [EXPERIMENTAL_WARNING_FLAG, ...process.execArgv, ...process.argv.slice(1)],
    { stdio: "inherit", env: process.env }
  );
  // 父进程不再继续运行 CLI
  return true;
}
```

这是因为 OpenClaw 使用了一些实验性 Node.js API，需要在进程级别抑制警告。

**3. 快速路径**

`--version` 和 `--help` 有专门的快速路径，避免加载整个 CLI 栈：

```typescript
if (!tryHandleRootVersionFastPath(process.argv) && !tryHandleRootHelpFastPath(process.argv)) {
  import("./cli/run-main.js").then(({ runCli }) => runCli(process.argv));
}
```

**4. CLI Profile**

在启动 CLI 之前，会解析 `--profile` 参数并注入对应的环境变量，支持多配置切换。

## 3.2 库入口：`src/index.ts`

`index.ts` 是另一个入口，主要用于编程使用（`import` from `'openclaw'`）。它做了 `entry.ts` 不做的一些全局初始化：

```typescript
loadDotEnv({ quiet: true });           // 加载 .env
normalizeEnv();                         // 规范化环境变量
ensureOpenClawCliOnPath();             // 确保 openclaw 在 PATH 上
enableConsoleCapture();                // 捕获 console 输出到结构化日志
assertSupportedRuntime();              // 检查 Node 版本
```

然后导出一组公共 API 供编程使用。

## 3.3 CLI 程序构建：`src/cli/program.ts`

`buildProgram()` 使用 Commander.js 注册所有子命令：

```
openclaw
├── gateway          # 启动/管理 Gateway
├── agent            # 直接与 Agent 交互
├── message send     # 发送消息
├── channels         # 渠道管理（login, status, logout）
├── onboard          # 引导安装向导
├── config           # 配置管理
├── doctor           # 诊断工具
├── nodes            # 设备节点管理
├── pairing          # DM 配对管理
├── update           # 更新 OpenClaw
├── skills           # 技能管理
├── secrets          # 密钥管理
└── ...              # 还有更多子命令
```

## 3.4 依赖注入：`src/cli/deps.ts`

OpenClaw 使用一个简单但有效的依赖注入模式。`createDefaultDeps()` 创建一个 `CliDeps` 对象，包含配置加载、session 管理、文件系统访问等依赖。命令实现通过接收 `deps` 参数来获取这些依赖，便于测试时替换。

## 3.5 关键子命令：`src/commands/gateway.ts`

Gateway 命令是最重要的子命令，它启动整个 WebSocket 服务：

```
openclaw gateway --port 18789 --verbose
```

这个命令会：
1. 加载配置文件（`~/.openclaw/openclaw.json`）
2. 检查端口可用性
3. 获取 Gateway lock（防止重复启动）
4. 初始化所有渠道连接
5. 启动 WebSocket 服务器
6. 运行 boot sequence（`BOOT.md`）
7. 进入事件循环

## 3.6 关键子命令：`src/commands/agent.ts`

Agent 命令允许直接与 AI 交互而不经过任何聊天渠道：

```
openclaw agent --message "Ship checklist" --thinking high
```

这对开发和调试非常有用。

## 3.7 本章要点

- `entry.ts` 是程序入口，负责 Node respawn 和快速路径
- `index.ts` 是库入口，做全局初始化并导出公共 API
- CLI 基于 Commander.js，通过 `CliDeps` 进行依赖注入
- `gateway` 命令启动整个系统，`agent` 命令用于直接 AI 交互

### 推荐阅读的源文件

| 文件 | 说明 |
|------|------|
| `src/entry.ts` | 程序入口，理解启动流程 |
| `src/index.ts` | 库入口，理解全局初始化 |
| `src/cli/program.ts` | 所有子命令注册 |
| `src/cli/deps.ts` | 依赖注入模式 |
| `src/commands/gateway.ts` | Gateway 启动命令 |
| `src/commands/agent.ts` | Agent 直接交互命令 |
