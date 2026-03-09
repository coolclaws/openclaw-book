# 附录 B：关键类型与接口速查

本附录列出阅读源码时最常遇到的类型和接口，以及它们的定义位置。

## 配置类型

| 类型 | 定义位置 | 说明 |
|------|---------|------|
| `OpenClawConfig` | `src/config/types.ts` | 主配置类型 |
| `AgentConfig` | `src/config/types.agents.ts` | Agent 配置 |
| `ChannelConfig` | `src/config/types.channels.ts` | 渠道配置 |
| `GatewayConfig` | `src/config/types.gateway.ts` (推测) | Gateway 配置 |
| `BrowserConfig` | `src/config/types.browser.ts` | 浏览器配置 |
| `SessionEntry` | `src/config/sessions/types.ts` | Session 条目 |

## Agent 类型

| 类型 | 定义位置 | 说明 |
|------|---------|------|
| `PromptMode` | `src/agents/system-prompt.ts` | Prompt 模式（full/minimal/none）|
| `ThinkLevel` | `src/auto-reply/thinking.ts` | 思考级别 |
| `ToolDefinition` | `src/agents/pi-tools.schema.ts` | 工具定义 |
| `EmbeddedContextFile` | `src/agents/pi-embedded-helpers.ts` | 上下文文件 |
| `EmbeddedSandboxInfo` | `src/agents/pi-embedded-runner/types.ts` | 沙箱信息 |

## Plugin SDK 类型

| 类型 | 定义位置 | 说明 |
|------|---------|------|
| `ChannelMeta` | `src/plugin-sdk/core.ts` | 渠道元数据 |
| `ChannelCapabilities` | `src/plugin-sdk/core.ts` | 渠道能力 |
| `ChannelSetupAdapter` | `src/plugin-sdk/core.ts` | 初始化适配器 |
| `ChannelMessagingAdapter` | `src/plugin-sdk/core.ts` | 消息适配器 |
| `ChannelGroupAdapter` | `src/plugin-sdk/core.ts` | 群组适配器 |
| `ChannelPairingAdapter` | `src/plugin-sdk/core.ts` | 配对适配器 |
| `ChannelOutboundContext` | `src/plugin-sdk/core.ts` | 出站上下文 |
| `ChannelSendResult` | `src/plugin-sdk/channel-send-result.ts` | 发送结果 |
| `InboundEnvelope` | `src/plugin-sdk/inbound-envelope.ts` | 入站消息 |

## 消息处理类型

| 类型 | 定义位置 | 说明 |
|------|---------|------|
| `InboundEnvelope` | `src/auto-reply/envelope.ts` | 入站消息封装 |
| `ReplyPayload` | `src/plugin-sdk/reply-payload.ts` | 回复负载 |
| `MediaAttachment` | `src/media/` | 媒体附件 |

## 基础设施类型

| 类型 | 定义位置 | 说明 |
|------|---------|------|
| `CliDeps` | `src/cli/deps.ts` | CLI 依赖注入 |
| `RuntimeEnv` | `src/runtime.ts` | 运行时环境 |
| `PortInUseError` | `src/infra/ports.ts` | 端口占用错误 |

## 常见模式

### 依赖注入

```typescript
// OpenClaw 的 DI 模式：通过 deps 参数传递依赖
function someCommand(deps: CliDeps) {
  const config = deps.loadConfig();
  // ...
}
```

### TypeBox Schema

```typescript
// 配置校验使用 TypeBox
import { Type } from '@sinclair/typebox';

const ChannelSchema = Type.Object({
  botToken: Type.String(),
  allowFrom: Type.Optional(Type.Array(Type.String())),
});
```

### 异步工具调用

```typescript
// 工具实现的标准签名
async function execute(
  params: ToolParams,
  context: ToolContext
): Promise<ToolResult> {
  // ...
  return { content: "result" };
}
```

## 缩略语表

| 缩写 | 全称 | 说明 |
|------|------|------|
| Pi | - | Agent 运行时的内部代号 |
| A2UI | Agent to UI | Canvas 协议 |
| DM | Direct Message | 私聊消息 |
| WS | WebSocket | 通信协议 |
| CDP | Chrome DevTools Protocol | 浏览器控制协议 |
| TTS | Text to Speech | 文本转语音 |
| TCC | Transparency Consent and Control | macOS 权限系统 |
| PTT | Push to Talk | 按住说话 |
