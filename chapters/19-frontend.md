# 第 19 章 前端与伴侣应用

## 14.1 前端架构概览

OpenClaw 的前端由三部分组成：

1. **Control UI + WebChat**（`ui/`）— Web 管理界面，内嵌在 Gateway 中
2. **macOS 应用**（`apps/macos/`）— 菜单栏控制平面
3. **iOS/Android 节点**（`apps/ios/`, `apps/android/`）— 移动端配套

## 14.2 Control UI：`ui/`

```
ui/
├── src/
│   ├── main.ts          # 应用入口
│   ├── ui/              # UI 组件
│   ├── styles/          # 样式
│   ├── styles.css       # 主样式文件
│   └── i18n/            # 国际化
├── public/              # 静态资源
├── index.html           # SPA 入口
├── vite.config.ts       # Vite 构建配置
└── package.json         # 独立的前端依赖
```

Control UI 构建后产出静态文件到 `ui/dist/`，由 Gateway 的 HTTP 服务直接提供。访问地址是 `http://127.0.0.1:18789/`。

功能包括：
- 渠道连接状态监控
- Session 管理
- 配置编辑
- WebChat（在浏览器中直接与 Agent 对话）
- 日志查看

## 14.3 macOS 应用

```
apps/macos/
├── Sources/
│   └── OpenClaw/
│       ├── App.swift            # 应用入口
│       ├── MenuBar/             # 菜单栏 UI
│       ├── Gateway/             # Gateway 控制
│       ├── VoiceWake/           # 语音唤醒
│       ├── Talk/                # 对话模式
│       ├── Canvas/              # Canvas 显示
│       ├── WebChat/             # 内嵌 WebChat
│       └── Resources/           # 资源文件
├── OpenClawMac.xcodeproj       # Xcode 项目
└── ...
```

macOS 应用是一个菜单栏应用，提供：
- Gateway 启动/停止控制
- Voice Wake（语音唤醒）
- Push-to-Talk 覆盖层
- WebChat 窗口
- Debug 工具
- Remote Gateway 连接

使用 SwiftUI + Observation 框架（非 ObservableObject）。

## 14.4 iOS 节点

```
apps/ios/
├── Sources/
│   ├── Canvas/       # Canvas 显示
│   ├── VoiceWake/    # 语音唤醒
│   ├── Talk/         # 对话模式
│   ├── Camera/       # 摄像头
│   └── Screen/       # 屏幕录制
└── ...
```

iOS 节点通过 Bonjour 与 Gateway 配对，提供设备本地能力（摄像头、屏幕录制、Canvas）。

## 14.5 Android 节点

```
apps/android/
├── app/
│   ├── src/main/
│   │   ├── java/      # Kotlin 代码
│   │   └── res/       # 资源
│   └── build.gradle.kts
└── ...
```

Android 节点提供与 iOS 类似的能力：Canvas、Camera、Screen capture，以及可选的 SMS 支持。

## 14.6 Canvas 与 A2UI

Canvas 是 Agent 可以驱动的可视化工作区。A2UI（Agent-to-UI）是 Canvas 的核心协议：

```
vendor/a2ui/          # A2UI 运行时（vendored）
src/canvas-host/      # Canvas 宿主逻辑
```

Agent 通过 `canvas` 工具推送 HTML/JS 到 Canvas，用户在 macOS/iOS/Android 上看到渲染结果。

## 14.7 本章要点

- Control UI 是内嵌在 Gateway 中的 Web 管理界面
- macOS 菜单栏应用是最完整的伴侣应用
- iOS/Android 作为节点提供设备本地能力
- Canvas + A2UI 实现 Agent 驱动的可视化工作区

### 推荐阅读的源文件

| 文件 | 说明 |
|------|------|
| `ui/src/main.ts` | 前端入口 |
| `src/gateway/control-ui.ts` | Control UI 路由 |
| `apps/macos/Sources/OpenClaw/App.swift` | macOS 应用入口 |
| `src/canvas-host/` | Canvas 宿主 |
