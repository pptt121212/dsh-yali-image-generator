# DeepSeek-Harness 图像生成插件

`deepseek-harness-yali-image-generator` 是一个可独立安装的 DeepSeek Harness Bundle，为 Agent 提供 `generate_image` 图像生成工具，并通过 Yali AI 异步图像网关调用模型。

包名和 Harness 模块名使用小写技术标识 `deepseek-harness-yali-image-generator`，以符合 npm 与 Cordis 的解析规则；面向用户的插件名称和工具说明统一为“DeepSeek-Harness 图像生成插件”。

## 官方规范符合性

本插件遵循 DeepSeek Harness 的 `docs/user/develop/basic` 与 `docs/cookbook/adding-a-tool.md`：

- 这是 Bundle，不是 Profile；`package.json` 通过 `dsh.bundle.patch` 声明安装补丁。
- 插件导出 `name`、`inject = ['tools']`、Schemastery `Config` 和 `apply(ctx, config)`。
- 工具通过 `ctx.tools.register(defineTool(...))` 注册；执行结果是由 `output.schema` 定义的规范 JSON，模型可见文本由 `output.render` 单独渲染。
- 接口地址、密钥环境变量、模型默认值、输出位置、超时和轮询参数均为可配置项；配置或凭据错误会明确失败。

完整逐条审计见 [COMPLIANCE.md](./COMPLIANCE.md)。

## 支持的模型与接口

| 模型 | 接口 | 规格 | 说明 |
| --- | --- | --- | --- |
| `gemini-3.1-flash-image-preview` | `POST /v1beta/models/{model}:generateContent` | `1K`、`2K`、`4K` | 支持完整 Gemini 宽高比；使用 `contents`、`responseModalities: ["IMAGE"]` 与 `imageConfig`。 |
| `gemini-3-pro-image-preview` | 同 Gemini 原生接口 | `1K`、`2K`、`4K` | 默认的第二阶段超分模型。 |
| `gpt-image-2` | `POST /v1/images/generations` 或 `/v1/images/edits` | `1K`、`2K`、`4K` | 根据宽高比映射为像素 `size`，发送 `quality`、`n: 1`、`output_format` 和 `async: true`。 |
| `grok-imagine-image-quality` | OpenAI 兼容 generations/edits 接口 | `1K`、`2K` | 使用 `resolution` 与 `aspect_ratio`，不会发送 `quality` 或 `size`。 |
| `agnes-image-2.1-flash` | `POST /v1/images/generations` | `1K`、`2K`、`3K`、`4K` | 使用 `size`、`ratio`；参考图写入 `extra_body.image`，不会发送 `quality`。 |

Gemini 的本地参考图使用 `inlineData`，URL 参考图使用 `fileData`。GPT 的本地参考图采用 multipart `image`，URL 参考图采用 JSON `image`。所有模型均使用异步任务：提交请求、校验 `202` 和 `task_id`、轮询 `query_path`，再下载或解码首个图像结果。

## 安装

### npm 安装

发布到 npm 后，用户可直接安装：

```powershell
dsh plugin --profile web add deepseek-harness-yali-image-generator
dsh web --dump-config
dsh web
```

### GitHub 安装

公开 GitHub 仓库发布后，也可以直接从 Git 安装：

```powershell
dsh plugin --profile web add github:pptt121212/DeepSeek-Harness-yali-image-generator
dsh web
```

GitHub 仓库名保留用户友好的大小写 `DeepSeek-Harness-yali-image-generator`；npm 包名使用规范化的小写 `deepseek-harness-yali-image-generator`。

自定义或无界面 Profile 使用相同方式：

```powershell
dsh plugin --profile my-profile add deepseek-harness-yali-image-generator
dsh --profile my-profile --dump-config
dsh --profile my-profile
```

本包直接发布 ESM 运行时文件，不需要构建步骤或 `prepare` 脚本。

## 配置密钥

仅设置所选模型系列对应的环境变量：

```powershell
$env:YALI_GEMINI_API_KEY = "..."
$env:YALI_GPT_API_KEY = "..."
$env:YALI_GROK_API_KEY = "..."
$env:YALI_AGNES_API_KEY = "..."
```

默认接口地址为 `https://api.yaliai.com`。密钥环境变量名、接口地址、默认模型、规格、质量、超分参数、输出目录和异步超时均可通过安装后的 Profile 配置修改。

## 使用方式

在 DeepSeek Harness 中直接让 Agent 调用 `generate_image`，例如：

```text
请使用 generate_image 生成一张 16:9、4K 的电影感夜间图书馆，暖色台灯照亮书桌。
```

常用参数：`prompt`（必填）、`model`、`aspect_ratio`、`image_size`、`quality`、`reference_image_paths`、`reference_image_urls`、`output_name`。`generation_mode: "upscale"` 会先生成基础图像，再由 `upscale_model` 完成第二阶段超分。默认输出目录为 `./generated/yali-images`。
