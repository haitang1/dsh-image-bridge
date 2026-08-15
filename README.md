# dsh-image-bridge

让**文本模型**（如 DeepSeek，`inputModalities` 只有 `text`）在 DeepSeek Harness 里也能正常**粘贴并发送图片**。

- 图片落盘到会话工作区的 `.attachments/` 目录；
- 对话区照常显示图片缩略图（可点击放大），**不再显示路径文字**；
- 模型侧拿到 `[图片1]:"<路径>"` 的文本，并据此调用已有的视觉/MCP 工具识别图片（例如
  `vision_glance`、`mcp__mcp-vision__analyze_image`、`mcp__mcp-vision__ocr_extract`）；
- 支持图片的模型不做任何处理，走原生路径。

## 原理

DeepSeek 等文本模型不支持图片输入，DSH 的 api-proxy 会在发送阶段直接拒绝含图消息
（「当前模型不支持图片」）。本插件做了三件事：

1. **放行预检**：包装 `llm.resolveModelInfo`，对文本模型补上 `image` 模态，让含图消息进入 agent 流程；
2. **落盘**：在 `agent/pre-step` 里用 `attachments.readImage` 读出图片字节，写到工作区 `.attachments/<sha256>.<ext>`；
3. **解耦显示与模型输入**：利用 DSH 的 surface replace 机制，在 `agent/request-error`
   里追加一条「仅模型可见」的替换事件，把图片块在模型可见面换成 `[图片N]:"<路径>"`，
   而人类 transcript 仍渲染原图。首次调用会因适配器拒绝图片在本地失败（无 API 开销），随后自动重试。

## 安装

本包是 **profile bundle**（`package.json` 声明了 `dsh.bundle.patch`）。

在 DSH 源码 checkout 根目录执行。

GitHub：

```sh
pnpm dsh plugin --profile web add 'github:haitang1/dsh-image-bridge#b5c64ea'
```

Gitee：

```sh
pnpm dsh plugin --profile web add 'https://gitee.com/llhhtt/dsh-image-bridge.git#b5c64ea'
```

`<profile>` 通常是 `web`（Web 界面）；`#b5c64ea` 是当前建议锁定的提交，可换成仓库最新 commit。

安装成功后，插件会自动加入该 profile 的 `dsh.profile.bundles`，下次启动（或长驻 surface
热载后）生效。

### 手工等价操作

如果 CLI 不可用：

1. 编辑 `$DSH_HOME/profiles/<profile>/package.json`：
   - 在 `dependencies` 加（GitHub / Gitee 二选一）：
     - `"dsh-image-bridge": "github:haitang1/dsh-image-bridge#b5c64ea"`
     - `"dsh-image-bridge": "https://gitee.com/llhhtt/dsh-image-bridge.git#b5c64ea"`
   - 在 `dsh.profile.bundles` 数组末尾加 `"dsh-image-bridge"`。
2. 在该 profile 目录执行 `pnpm install`。

### 本地开发

```sh
cd <dsh-source>
pnpm dsh plugin --profile web add 'link:<本仓库绝对路径>'
```

## 依赖

- 运行环境：DeepSeek Harness（宿主组合需提供 `attachments`、`llm`、`subprocess`、`sandboxPolicy`，标准 profile 均具备）。
- peer 依赖：`@deepseek-ai/cordis`（由 DSH 提供）。

## 许可

MIT
