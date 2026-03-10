# 第 11 章 记忆系统

## 11.1 为什么需要记忆系统

LLM 是无状态的：每次调用结束，它就"忘了"。OpenClaw 的上下文管理（第 10 章）解决的是**当前会话的 token 控制问题**，而记忆系统（Memory）解决的是**跨会话的长期知识积累问题**。

两者的定位根本不同：

| | 上下文管理 | 记忆系统 |
|--|--|--|
| 范围 | 单次会话 | 跨会话、持久化 |
| 存储 | 内存 / session 文件 | 磁盘（Markdown + SQLite） |
| 操作主体 | Pi 引擎自动管理 | Agent 主动写入 + 系统自动索引 |
| 信息来源 | 当前对话历史 | Markdown 文件 + 历史会话记录 |
| 访问方式 | 直接注入 LLM context | 语义搜索按需检索 |

记忆系统的核心思路：**把重要信息写到 Markdown 文件里，由索引引擎自动向量化，需要时通过语义搜索按需取出，而不是把所有历史全部塞进 context**。

---

## 11.2 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    工具层（Agent 可用）                   │
│  memory_search(query)    memory_get(path, from, lines)   │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                  MemorySearchManager 接口                 │
│  search()  readFile()  sync()  status()  probe*()        │
└──────────────────┬────────────────────┬─────────────────┘
                   │                    │
     ┌─────────────▼──────┐  ┌──────────▼──────────────┐
     │  MemoryIndexManager │  │    QmdMemoryManager      │
     │  （builtin 后端）   │  │   （qmd 外部工具后端）   │
     │                     │  │                          │
     │  SQLite + 向量扩展  │  │  qmd CLI / mcporter MCP  │
     │  本地 embedding     │  │  独立索引 + 多集合管理   │
     └─────────────────────┘  └──────────────────────────┘
```

**两个后端**，统一接口：

```typescript
type MemoryBackend = "builtin" | "qmd";
```

- **builtin**（默认）：纯 Node.js 实现，使用 `node:sqlite` 内置模块 + 可选 SQLite 向量扩展，直接内嵌在 Gateway 进程里
- **qmd**：调用外部 `qmd` 命令行工具（或通过 `mcporter` MCP 运行时），适合需要高级索引能力或多文档集合管理的场景

---

## 11.3 信息来源：两种 Source

```typescript
type MemorySource = "memory" | "sessions";
```

### memory — Markdown 文件

位于 workspace 目录下的所有 Markdown 文件（`MEMORY.md`、`memory/*.md` 等）。

```typescript
// 判断一个路径是否属于 memory source
export declare function isMemoryPath(relPath: string): boolean;

// 列出所有 memory 文件
export declare function listMemoryFiles(
  workspaceDir: string,
  extraPaths?: string[]
): Promise<string[]>;
```

内容由 Agent 自主维护——在对话中学到的知识、用户偏好、项目背景，Agent 写入这些文件，系统自动索引。

### sessions — 历史会话记录

过去的对话记录（session JSONL 文件）。系统将它们渲染为 Markdown 文本后进行索引，让 Agent 能搜索到"上周讨论过 XX 话题"这类跨会话记忆。

```typescript
// Session 文件的 delta 追踪（增量同步用）
sessionDeltas: Map<string, {
  lastSize: number;
  pendingBytes: number;
  pendingMessages: number;
}>;
```

QMD 后端还支持将 session 导出为独立的 Markdown 文件集合，通过 `memory.qmd.sessions.exportDir` 配置导出目录。

---

## 11.4 builtin 后端：索引机制

### 文件监控与触发同步

**文件：** `src/memory/manager-sync-ops.ts`

builtin 后端通过 **三种机制** 感知文件变化：

```
┌──────────────────────────────────────────────────────────┐
│ 1. chokidar watcher（文件系统事件）                       │
│    监控 workspace/*.md，文件创建/修改/删除后 debounce 触发 │
├──────────────────────────────────────────────────────────┤
│ 2. Session Listener（会话事件订阅）                       │
│    订阅 Gateway 内部事件，新消息写入 session 文件后触发    │
├──────────────────────────────────────────────────────────┤
│ 3. Interval Sync（周期兜底同步）                         │
│    固定间隔强制全量扫描，确保没有漏网之鱼                  │
└──────────────────────────────────────────────────────────┘
```

三种机制互为补充：watcher 处理手动编辑文件的情况，Session Listener 处理对话实时写入，Interval Sync 是最后保障。

### 文档分块（Chunking）

```typescript
export declare function chunkMarkdown(
  content: string,
  chunking: { tokens: number; overlap: number }
): MemoryChunk[];

type MemoryChunk = {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
};
```

大文件被切成带重叠的块（overlap 保证跨块的语义连贯性），每块记录在原文中的行号区间，搜索结果可以精确定位到源文件的哪几行。

Session JSONL 文件会被展平为纯文本后分块，再通过 `remapChunkLines` 将块内行号映射回原始文件位置：

```typescript
export declare function remapChunkLines(
  chunks: MemoryChunk[],
  lineMap: number[] | undefined
): void;
```

### SQLite 存储结构

**文件：** `src/memory/memory-schema.ts`

底层用 `node:sqlite`（Node.js 22+ 内置，无外部依赖）：

```typescript
export declare function ensureMemoryIndexSchema(params: {
  db: DatabaseSync;
  embeddingCacheTable: string; // embedding 结果缓存表
  ftsTable: string;            // 全文搜索索引表
  ftsEnabled: boolean;
}): { ftsAvailable: boolean; ftsError?: string };
```

两张核心表：

| 表 | 内容 |
|---|------|
| `embeddingCacheTable` | 文本块 → embedding 向量的缓存，按 provider key 区分 |
| `ftsTable` | FTS5 全文索引，SQLite 内置，无需额外扩展 |

向量搜索用 `sqlite-vec` 扩展（可选），未安装时自动降级到 FTS 纯文本搜索。

### Embedding 提供商

**文件：** `src/memory/manager-embedding-ops.ts`

builtin 后端支持 5 种 embedding 提供商：

```typescript
type EmbeddingProvider = "openai" | "gemini" | "voyage" | "mistral" | "ollama";
```

| 提供商 | 特点 |
|--------|------|
| OpenAI | 最常用，`text-embedding-3-*` 系列 |
| Gemini | Google，需 API Key（当前环境用此项） |
| Voyage | Anthropic 系生态，高质量代码检索 |
| Mistral | 欧洲合规，自托管友好 |
| Ollama | 完全本地，无 API Key，适合隐私场景 |

**批量 embedding（Batch）：**

```typescript
protected batch: {
  enabled: boolean;
  wait: boolean;
  concurrency: number;
  pollIntervalMs: number;
  timeoutMs: number;
};
```

首次索引大量文件时，批量模式异步提交 → 轮询等待 → 失败有重试 + 指数退避，防止 rate limit 打爆。

**自动降级（Fallback）：**

```typescript
protected fallbackFrom?: "openai" | "local" | "gemini" | "voyage" | "mistral" | "ollama";
protected fallbackReason?: string;
```

embedding 提供商不可用时（API key 失效、网络超时），自动降级到下一可用提供商，降级原因记录在 status 中。

**provider key 机制：**

```typescript
protected computeProviderKey(): string;
```

每种提供商 + 模型组合计算出唯一的 `providerKey`。当 provider 或模型切换时，已有的 embedding 缓存不能混用（维度不同），系统会触发重新索引（reindex）。

---

## 11.5 混合搜索：向量 + FTS

**文件：** `src/memory/manager.ts`

```
search(query)
  ↓
┌─────────────────┐  ┌──────────────────┐
│  searchVector() │  │ searchKeyword()   │
│  余弦相似度搜索  │  │  FTS5 全文搜索    │
│  （语义匹配）   │  │  （关键词匹配）   │
└────────┬────────┘  └────────┬─────────┘
         └──────────┬─────────┘
              mergeHybridResults()
                    ↓
            按 score 排序的结果列表
```

两种搜索各有所长：

| | 向量搜索 | FTS 搜索 |
|--|--|--|
| 优势 | 语义理解，"类似的意思"也能搜到 | 精确关键词，专有名词不会失真 |
| 劣势 | 需要 embedding，有成本 | 无语义理解，同义词搜不到 |
| 依赖 | sqlite-vec 扩展 + embedding | SQLite FTS5（内置）|

`mergeHybridResults` 合并两路结果，去重后按综合 score 排序，返回最终的 `MemorySearchResult[]`：

```typescript
type MemorySearchResult = {
  path: string;        // 文件相对路径
  startLine: number;   // 块在文件中的起始行
  endLine: number;     // 块在文件中的结束行
  score: number;       // 相关性分数（0-1）
  snippet: string;     // 文本摘要片段
  source: MemorySource; // "memory" | "sessions"
  citation?: string;   // 可选：引用格式字符串
};
```

搜索还支持按 sessionKey 过滤，只搜与特定会话相关的历史：

```typescript
search(query, { maxResults?, minScore?, sessionKey? })
```

---

## 11.6 qmd 后端

`qmd` 是 OpenClaw 配套的独立文档索引工具，支持更复杂的多集合管理场景。

### 运行方式

```typescript
type MemoryQmdMcporterConfig = {
  enabled?: boolean;    // 通过 mcporter MCP 运行时调用
  serverName?: string;  // mcporter 服务名称（默认 "qmd"）
  startDaemon?: boolean; // 自动启动 mcporter daemon
};
```

两种调用方式：
- **直接模式**：每次搜索 spawn 一个 `qmd` 子进程，有启动延迟
- **mcporter 模式**：`qmd mcp` 作为 MCP server 保持 alive，通过 mcporter 守护进程调用，消除启动延迟

### 集合（Collection）管理

qmd 后端将文件组织为"集合"，每个集合对应一个目录：

```typescript
type ResolvedQmdCollection = {
  name: string;     // 集合名称
  path: string;     // 目录路径
  pattern: string;  // glob 匹配模式
  kind: "memory" | "custom" | "sessions";
};
```

QmdMemoryManager 的启动流程：

```
initialize()
  → bootstrapCollections()    — 确保 qmd 已初始化
  → ensureCollections()       — 创建/绑定集合（对比已有集合 vs 需要的集合）
    → migrateLegacyUnscopedCollections()  — 处理旧版本集合迁移
    → addCollection() / removeCollection() — 增删集合
  → symlinkSharedModels()     — 共享预装 ML 模型（避免重复下载）
```

集合管理有专门的自愈逻辑：

```typescript
// 三种常见损坏场景的修复
private tryRepairNullByteCollections();       // 数据库 null byte 损坏
private tryRepairDuplicateDocumentConstraint(); // 重复文档约束冲突
private tryRebindConflictingCollection();      // 路径冲突时重新绑定
```

### 搜索模式

```typescript
type MemoryQmdSearchMode = "query" | "search" | "vsearch";
```

| 模式 | 说明 |
|------|------|
| `query` | 混合语义+关键词（默认） |
| `search` | 纯关键词 |
| `vsearch` | 纯向量语义 |

### Session 导出

qmd 后端通过 `sessionExporter` 将会话记录渲染为 Markdown 文件，存入独立集合，供索引。渲染方法 `renderSessionMarkdown` 将 JSONL 格式的消息流转为可读的对话文档。

---

## 11.7 配置

**文件：** `src/config/types.memory.ts`

```typescript
type MemoryConfig = {
  backend?: "builtin" | "qmd"; // 默认 builtin
  citations?: "auto" | "on" | "off"; // 引用模式
  qmd?: MemoryQmdConfig;
};
```

**citations 模式**控制搜索结果是否附带源文件引用：

| 模式 | 行为 |
|------|------|
| `auto` | 由系统判断（默认）|
| `on`  | 始终附带 `Source: path#line` 引用 |
| `off` | 不附带引用 |

**qmd 后端完整配置：**

```typescript
type MemoryQmdConfig = {
  command?: string;           // qmd 可执行文件路径
  mcporter?: { ... };        // mcporter 配置
  searchMode?: "query" | "search" | "vsearch";
  includeDefaultMemory?: boolean; // 是否包含默认 memory 集合
  paths?: MemoryQmdIndexPath[];   // 自定义索引路径
  sessions?: {
    enabled?: boolean;
    exportDir?: string;
    retentionDays?: number;
  };
  update?: {
    interval?: string;       // 增量更新间隔
    debounceMs?: number;
    onBoot?: boolean;
    waitForBootSync?: boolean;
    embedInterval?: string;  // embedding 更新间隔（可以比更新间隔长）
    commandTimeoutMs?: number;
    updateTimeoutMs?: number;
    embedTimeoutMs?: number;
  };
  limits?: {
    maxResults?: number;
    maxSnippetChars?: number;
    maxInjectedChars?: number; // 注入 context 的字符上限
    timeoutMs?: number;
  };
};
```

---

## 11.8 Agent 工具接口

记忆系统向 Agent 暴露两个工具：

### memory_search

```
memory_search(query, maxResults?, minScore?) → MemorySearchResult[]
```

语义搜索，返回最相关的文件片段。每次 Agent 回答关于"之前讨论过的内容"、"用户偏好"、"项目背景"时，应先调用此工具而不是靠 context 里的记忆（context 里的记忆在 compaction 后已经是摘要）。

### memory_get

```
memory_get(path, from?, lines?) → { text, path }
```

精确读取记忆文件的指定行范围。通常在 `memory_search` 返回了文件路径和行号后，用此工具取出完整内容。

### 典型调用模式

```
用户："上次我们说 CryptoSurf 的版本号规则是什么？"
  ↓
Agent: memory_search("CryptoSurf 版本号规则")
  → [{ path: "MEMORY.md", startLine: 12, endLine: 18, score: 0.92, ... }]
  ↓
Agent: memory_get("MEMORY.md", from=12, lines=6)
  → 版本号规则的具体内容
  ↓
Agent: 回答用户
```

---

## 11.9 Status 与可观测性

`MemoryProviderStatus` 包含完整的运行时诊断信息：

```typescript
type MemoryProviderStatus = {
  backend: "builtin" | "qmd";
  provider: string;          // 当前 embedding 提供商
  model?: string;
  requestedProvider?: string; // 用户配置的，可能和实际不同（fallback 后）
  files?: number;             // 已索引文件数
  chunks?: number;            // 已索引文本块数
  dirty?: boolean;            // 是否有待同步的文件
  sources?: MemorySource[];
  sourceCounts?: Array<{ source, files, chunks }>;
  cache?: { enabled, entries?, maxEntries? };  // embedding 缓存状态
  fts?: { enabled, available, error? };        // FTS 状态
  fallback?: { from, reason? };                // 降级信息
  vector?: {
    enabled, available?, extensionPath?,
    loadError?, dims?                          // sqlite-vec 状态
  };
  batch?: {
    enabled, failures, limit, wait,
    concurrency, pollIntervalMs, timeoutMs,
    lastError?, lastProvider?                  // 批量 embedding 状态
  };
};
```

运行时问题可通过 status 快速定位：
- `fallback.from` 非空 → embedding 提供商降级了（检查 API key）
- `vector.loadError` 非空 → sqlite-vec 扩展加载失败（退化到纯 FTS）
- `fts.available = false` → FTS5 不可用（SQLite 编译时未启用）
- `dirty = true` + `chunks = 0` → 文件变了但还没索引（等待下次同步）

---

## 11.10 内存系统全景图

```
┌─────────────────────────────────────────────────────────────────┐
│  Agent 写入层                                                    │
│  memory_search / memory_get 工具 → Pi 引擎 → workspace/*.md     │
│                                                 memory/*.md      │
└──────────────────────────────────────┬──────────────────────────┘
                                       │ chokidar / session listener
                                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  索引层                                                          │
│  chunkMarkdown() → EmbeddingProvider → SQLite                   │
│                                                                  │
│  memory 文件 ──────────────────────────────────────────────┐   │
│  session JSONL → renderSessionMarkdown → chunkMarkdown ────┤   │
│                                                             ▼   │
│                    embeddingCacheTable   vectors_table(可选) │   │
│                    fts5_table                               │   │
└──────────────────────────────────┬──────────────────────────────┘
                                   │
┌──────────────────────────────────▼──────────────────────────────┐
│  搜索层                                                          │
│  searchVector(query embedding)    搜索结果                       │
│  searchKeyword(query text)     → mergeHybridResults → sorted[]  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 11.11 本章要点

记忆系统的设计哲学：**不把所有历史推入 context，而是按需检索**。

| 问题 | 解决方案 |
|------|---------|
| Agent 跨会话记忆丢失 | workspace Markdown 文件 + 自动索引 |
| 搜索精度不够 | 向量搜索（语义）+ FTS（关键词）混合 |
| Embedding 服务不稳定 | 多提供商 + 自动降级 + 批量重试 |
| 大量文件首次索引慢 | 异步 batch embedding + 并发控制 |
| 向量扩展不可用 | 自动退化到纯 FTS |
| 跨场景不同需求 | builtin 内嵌 vs qmd 外部两套后端 |

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/memory/types.ts` | ★★★ | 核心类型：MemorySearchResult、MemoryProviderStatus |
| `src/memory/manager.ts` | ★★★ | builtin 后端主入口，搜索逻辑 |
| `src/memory/manager-sync-ops.ts` | ★★ | 文件监控、分块、同步流水线 |
| `src/memory/manager-embedding-ops.ts` | ★★ | embedding 批量处理 + fallback |
| `src/memory/internal.ts` | ★★ | chunkMarkdown、cosineSimilarity 等基础算法 |
| `src/memory/qmd-manager.ts` | ★ | qmd 后端（多集合管理场景） |
| `src/config/types.memory.ts` | ★ | 完整配置项说明 |
