# 第 8 章 媒体理解：音频、图像、视频与 PDF

## 8.1 为什么媒体理解是独立子系统

消息不只是文字。用户发来的语音条、截图、视频、PDF 文件，在 LLM 能"看到"它们之前，需要先被转换为 LLM 能处理的形式。

媒体理解系统的职责：**在消息流水线的处理阶段，将非文本附件转化为文本描述或转写稿，无缝注入到 Agent 的上下文中**。

它是独立子系统，而不是工具调用，原因是：
- 用户不需要显式"要求"理解附件，系统自动处理
- 有自己的 provider 体系、缓存机制、并发控制
- 和 `image` / `pdf` 工具（手动触发）形成互补

---

## 8.2 三类能力

**文件：** `src/media-understanding/types.ts`

```typescript
type MediaUnderstandingKind =
  | "audio.transcription"  // 语音转文字
  | "image.description"    // 图像理解
  | "video.description";   // 视频描述

type MediaUnderstandingCapability = "audio" | "image" | "video";
// PDF 归入 image（逐页截图分析）或 native provider（原生解析）
```

每次处理产出 `MediaUnderstandingOutput`：

```typescript
type MediaUnderstandingOutput = {
  kind: MediaUnderstandingKind;
  attachmentIndex: number; // 对应消息中的第几个附件
  text: string;            // 转写稿或描述文字
  provider: string;        // 使用了哪个 provider
  model?: string;          // 使用了哪个模型
};
```

---

## 8.3 Provider 体系

**文件：** `src/media-understanding/providers/`

`MediaUnderstandingProvider` 接口定义了统一契约：

```typescript
type MediaUnderstandingProvider = {
  id: string;
  capabilities?: MediaUnderstandingCapability[];

  transcribeAudio?:  (req: AudioTranscriptionRequest)  => Promise<AudioTranscriptionResult>;
  describeVideo?:    (req: VideoDescriptionRequest)     => Promise<VideoDescriptionResult>;
  describeImage?:    (req: ImageDescriptionRequest)     => Promise<ImageDescriptionResult>;
};
```

各 provider 支持的能力矩阵：

| Provider | 音频 | 图像 | 视频 | 特点 |
|----------|------|------|------|------|
| OpenAI (Whisper) | ✓ | ✓ | — | 最常用语音转写 |
| Google | ✓ | ✓ | ✓ | Gemini 原生多模态，视频直传 |
| Deepgram | ✓ | — | — | 专业音频，低延迟，支持说话人分离 |
| Groq | ✓ | — | — | 极速 Whisper（WhisperLarge-v3-turbo）|
| Moonshot | — | ✓ | ✓ | 月之暗面，视频理解 |
| MiniMax | — | ✓ | — | 国内 provider |
| Anthropic | — | ✓ | — | Claude 原生图像理解（PDF native）|
| Mistral | — | ✓ | — | 欧洲合规 |

### PDF 特殊处理

**文件：** `src/agents/tools/pdf-native-providers.ts`

PDF 有两条路：
- **原生解析**（Anthropic / Google）：直接将 PDF 传给模型，模型原生理解
- **图像路径**：将 PDF 每页截图，逐页走 image description

---

## 8.4 附件缓存

**文件：** `src/media-understanding/attachments.cache.ts`

同一条消息的附件可能被多个 provider 或多次分析请求。`MediaAttachmentCache` 避免重复读取磁盘或重复下载：

```typescript
type MediaAttachmentCacheOptions = {
  maxBytes?: number;     // 单附件最大缓存大小
  timeoutMs?: number;    // 加载超时
};
```

缓存策略：**按 (attachmentIndex + path/url) 哈希作为 key，首次加载后在整个消息处理周期内复用**。同一 session 的多轮对话不会跨轮次共享缓存（避免大内存占用）。

---

## 8.5 多 Provider 决策流

**文件：** `src/media-understanding/runner.ts`, `src/media-understanding/resolve.ts`

对同一个附件，系统不只尝试一个 provider，而是有完整的**决策与 fallback 链**：

```
runCapability(capability, attachments)
  ↓
resolveMediaAttachmentLocalRoots()   — 确定本地文件根目录
normalizeMediaAttachments()          — 规范化附件列表
  ↓
buildProviderRegistry()              — 注册所有可用 provider
  ↓
  for each attachment:
    尝试 provider[0]
      → 成功 → MediaUnderstandingOutput
      → 失败 → 尝试 provider[1] → ... → 全部失败 → skip
```

决策结果会记录在 `MediaUnderstandingDecision` 中，可用于调试：

```typescript
type MediaUnderstandingAttachmentDecision = {
  attachmentIndex: number;
  attempts: MediaUnderstandingModelDecision[]; // 每次尝试的结果
  chosen?: MediaUnderstandingModelDecision;    // 最终用了哪个
};

type MediaUnderstandingModelDecision = {
  provider?: string;
  model?: string;
  type: "provider" | "cli";
  outcome: "success" | "skipped" | "failed";
  reason?: string;
};
```

### 自动图像模型选择

```typescript
resolveAutoImageModel({ cfg, agentDir, activeModel })
  → Promise<{ provider, model? } | null>
```

当没有配置专门的图像理解 provider 时，系统会检查当前 Agent 使用的 LLM 是否支持多模态（Vision），如果支持则直接用主模型处理图像，不额外调用专门的 image provider。

---

## 8.6 音频转写的并发控制

**文件：** `src/media-understanding/concurrency.ts`

音频转写通常是最慢的操作（网络 + 模型推理）。多条消息同时到达时，并发音频请求可能打爆 rate limit：

```
单 session 内：串行（等上一条处理完再处理下一条）
多 session 间：并发上限 N（默认由 config 控制）
```

`concurrency.ts` 实现了基于 semaphore 的并发限制，确保系统整体不超过 API 的并发限制。

---

## 8.7 Scope 控制

**文件：** `src/media-understanding/scope.ts`

不是所有消息都需要做媒体理解——群聊里的语音条要不要转写？陌生人发来的图片要不要理解？

Scope 控制决定"在什么情况下对什么附件进行理解"：

```typescript
// 来自 config
type MediaUnderstandingConfig = {
  audio?: { enabled?: boolean; scope?: MediaScopeConfig };
  image?: { enabled?: boolean; scope?: MediaScopeConfig };
  video?: { enabled?: boolean; scope?: MediaScopeConfig };
};
```

`scope` 可以限定为：仅 DM / 仅已配对用户 / 仅 main session / 全局启用。在群聊中，通常不对陌生人发送的媒体做理解（安全考量 + 成本控制）。

---

## 8.8 与消息流水线的集成

媒体理解在消息流水线（第 6 章）的 **Media Processing** 阶段执行，位于接收消息、权限检查之后，构建 LLM context 之前：

```
消息到达
  → 提取附件（normalizeMediaAttachments）
  → 权限检查（scope 判断）
  → runCapability(audio)  ← 音频转写
  → runCapability(image)  ← 图像理解
  → runCapability(video)  ← 视频理解
  → 将 outputs 注入 MsgContext.mediaUnderstanding
  → 构建 system prompt 时自动附加转写/描述
  → LLM 调用
```

LLM 看到的不是原始音频文件，而是已经转好的文字。从模型的视角，用户"说"了一段话，只是恰好通过语音发来。

---

## 8.9 与 `image` / `pdf` 工具的关系

| | 自动媒体理解 | `image` 工具 | `pdf` 工具 |
|--|--|--|--|
| 触发方式 | 自动（消息处理阶段）| Agent 主动调用 | Agent 主动调用 |
| 时机 | LLM 调用前 | LLM 调用过程中 | LLM 调用过程中 |
| 来源 | 用户发来的附件 | Agent 指定的路径/URL | Agent 指定的路径/URL |
| 适用场景 | 用户上传文件时 | Agent 主动分析外部图像 | Agent 主动分析外部 PDF |

两者互补：自动系统处理用户带来的媒体；工具处理 Agent 在任务中主动需要分析的资源。

---

## 8.10 本章要点

| 场景 | 链路 |
|------|------|
| 用户发语音 | Whisper/Deepgram/Google 转写 → 注入 context |
| 用户发截图 | 多模态模型描述 → 注入 context |
| 用户发视频 | Google/Moonshot 描述 → 注入 context |
| 用户发 PDF | Anthropic/Google native 或图像页路径 |
| provider 失败 | fallback 到下一个 provider |
| 主模型支持视觉 | 自动用主模型处理图像，不额外调用 |

### 推荐阅读的源文件

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `src/media-understanding/types.ts` | ★★★ | 所有核心类型：能力、provider 接口、决策 |
| `src/media-understanding/runner.ts` | ★★★ | runCapability 主逻辑 |
| `src/media-understanding/resolve.ts` | ★★ | provider 解析与 fallback 链 |
| `src/media-understanding/attachments.cache.ts` | ★★ | 附件缓存 |
| `src/media-understanding/providers/` | ★ | 各 provider 实现 |
| `src/media-understanding/scope.ts` | ★ | scope 控制 |
| `src/media-understanding/concurrency.ts` | ★ | 并发控制 |
