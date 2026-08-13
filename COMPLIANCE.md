# DeepSeek-Harness 图像生成插件合规审计

本清单逐项核对 `docs/user/develop/basic` 下的插件开发文档，以及 `docs/cookbook/adding-a-tool.md` 的模型工具规范。

## 基础插件要求

| 官方要求 | 状态 | 实现依据 |
| --- | --- | --- |
| 插件具备稳定的 `name`。 | 通过 | `index.js` 导出 `name = "deepseek-harness-yali-image-generator"`。 |
| 声明所需服务。 | 通过 | 导出 `inject = ['tools']`。 |
| 提供可验证的配置。 | 通过 | 导出 Schemastery `Config`，覆盖接口地址、密钥引用、默认值、目录、超时和限制。 |
| 以 `apply(ctx, config)` 安装行为。 | 通过 | `apply` 在配置解析后注册工具。 |
| 使用扩展点而非修改核心循环。 | 通过 | 仅使用官方 `tools` 服务和 `defineTool`。 |
| 部署可变项可配置。 | 通过 | 端点、密钥变量、默认模型、输出目录、轮询和超时均为 `Config` 字段。 |
| 错配应尽早明确失败。 | 通过 | 无效端点与输出目录在加载时失败；缺失模型密钥在请求前失败。 |
| 本地 `--patch` 模块路径为绝对路径。 | 通过 | `local.patch.yml` 使用 Windows ESM 绝对 `file:///` URL。 |

## Bundle 打包与安装要求

| 官方要求 | 状态 | 实现依据 |
| --- | --- | --- |
| 可分发插件是 Bundle，而不是 Profile。 | 通过 | `package.json` 仅声明 `dsh.bundle`。 |
| Bundle 清单声明补丁文件。 | 通过 | `dsh.bundle.patch = "./cordis.patch.yml"`。 |
| 补丁按包名插入插件行。 | 通过 | `cordis.patch.yml` 使用 `name: deepseek-harness-yali-image-generator`。 |
| 用户可向指定 Profile 安装。 | 通过 | README 记录 `dsh plugin --profile <名称> add ...` 的 tarball、npm、Web 与自定义 Profile 命令。 |
| Profile 管理 Bundle 顺序。 | 通过 | README 以 `--dump-config` 验证已安装配置，不要求用户手改清单。 |
| git/源码安装可获得可执行文件。 | 通过 | 包含无需构建的 ESM `index.js`。 |

## 模型工具要求

| 官方要求 | 状态 | 实现依据 |
| --- | --- | --- |
| 使用 `ctx.tools.register(defineTool(...))` 注册。 | 通过 | `apply` 按官方工具扩展点注册 `generate_image`。 |
| 参数使用模型可见 schema。 | 通过 | `parameters` 声明提示词、模型、规格、参考图、输出和超分参数。 |
| `execute` 返回单一规范 JSON。 | 通过 | 返回 `TOOL_OUTPUT_SCHEMA` 定义的对象，不直接返回展示内容块。 |
| 模型可见内容单独渲染。 | 通过 | `output.render` 将规范结果转换为文本。 |
| 基础设施故障抛出错误。 | 通过 | HTTP、异步任务、超时、下载、响应格式与凭据错误均明确抛出。 |
| 尊重 `exec.signal`。 | 通过 | 请求、轮询等待、下载和本地文件读取均使用取消信号。 |
| `presentationMeta` 可重放且为纯 JSON。 | 通过 | 仅从规范结果投影路径、媒体类型、模型、模式和任务 ID。 |
| 展示函数为纯函数。 | 通过 | `presentCall` 和 `presentResult` 只读取参数、注册时配置和结果元数据。 |

## Yali 接口对照

| 项目 | 状态 | 实现依据 |
| --- | --- | --- |
| 五个支持模型。 | 通过 | Gemini Preview、`gpt-image-2`、Grok Imagine 与 Agnes 均已实现。 |
| GPT 图像规格映射。 | 通过 | 1K、2K、4K 的像素映射与参考项目一致。 |
| Gemini 原生请求。 | 通过 | 使用 `generateContent`、`responseModalities`、`imageConfig`、`inlineData`、`fileData`。 |
| GPT/OpenAI Images 请求。 | 通过 | 使用 generations/edits、`size`、`quality`、`n`、`output_format` 与本地 multipart 编辑。 |
| Grok 请求。 | 通过 | 使用 OpenAI 兼容路径、`resolution`、`aspect_ratio`，不发送 `quality` 和 `size`。 |
| Agnes 请求。 | 通过 | 使用原生 generations、`size`、`ratio`、`extra_body.image`，不发送 `quality`。 |
| 异步任务生命周期。 | 通过 | 请求含 `async: true`，校验 `202`，轮询 `query_path`，处理终态并保存首个结果。 |
| 两阶段超分。 | 通过 | 生成源图，作为第二阶段唯一参考图；结束后清理临时目录。 |
| 桌面端 UI 功能。 | 不适用 | 弹窗、故事板、缩略图、批量超分与任务日志不属于 Harness 模型工具职责。 |
| 超大参考图压缩。 | 有意差异 | Bundle 用 `maxReferenceBytes` 明确限制并报错，不引入 Pillow 或原生处理依赖。 |
