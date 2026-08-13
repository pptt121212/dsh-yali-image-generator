import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-yali-image-generator'
export const inject = ['tools', 'credentials']

const DEFAULT_UPSCALE_PROMPT = '现在对这张图进行全景像素超分（Panorama Super-Resolution）与重绘。请将图像精细度和文字边缘细节提升至 {image_size} 电影级分辨率。场景清晰不允许存在锯齿和噪点，颜色纯净。请在画面中原地追加细节。保持图像 {aspect_ratio} 比例，不要因为限制图像比例而使用变形的素材和文字。图像比例不对将判定为任务失败！'

const MODELS = [
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
  'gpt-image-2',
  'grok-imagine-image-quality',
  'agnes-image-2.1-flash',
]

const GEMINI_MODELS = new Set(['gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview'])
const GPT_IMAGE_MODELS = new Set(['gpt-image-2'])
const GROK_IMAGE_MODELS = new Set(['grok-imagine-image-quality'])
const AGNES_IMAGE_MODELS = new Set(['agnes-image-2.1-flash'])

const QUALITY_VALUES = ['low', 'medium', 'high']
const IMAGE_SIZES = ['1K', '2K', '3K', '4K']
const GENERATION_MODES = ['default', 'upscale']
const OUTPUT_FORMATS = ['jpeg', 'png', 'webp']
const ASPECT_RATIOS = [
  'auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3',
  '5:4', '4:5', '21:9', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20',
]
const GROK_ASPECT_RATIOS = new Set([
  'auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3',
  '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20',
])
const AGNES_ASPECT_RATIOS = new Set(['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'])

const GPT_IMAGE_SIZE_MAP = {
  '1K': {
    '1:1': '1024x1024',
    '2:3': '688x1024',
    '3:2': '1024x688',
    '3:4': '768x1024',
    '4:3': '1024x768',
    '9:16': '608x1088',
    '16:9': '1088x608',
    '21:9': '1248x528',
  },
  '2K': {
    '1:1': '2048x2048',
    '2:3': '1360x2048',
    '3:2': '2048x1360',
    '3:4': '1536x2048',
    '4:3': '2048x1536',
    '9:16': '1152x2048',
    '16:9': '2048x1152',
    '21:9': '2048x880',
  },
  '4K': {
    '1:1': '2880x2880',
    '2:3': '2336x3520',
    '3:2': '3520x2336',
    '3:4': '2480x3312',
    '4:3': '3312x2480',
    '9:16': '2160x3840',
    '16:9': '3840x2160',
    '21:9': '3840x1648',
  },
}

export const Config = Schema.object({
  endpoint: Schema.string().default('https://api.yaliai.com'),
  gptApiKeyEnv: Schema.string().role('credential-ref').default('YALI_GPT_API_KEY'),
  geminiApiKeyEnv: Schema.string().role('credential-ref').default('YALI_GEMINI_API_KEY'),
  grokApiKeyEnv: Schema.string().role('credential-ref').default('YALI_GROK_API_KEY'),
  agnesApiKeyEnv: Schema.string().role('credential-ref').default('YALI_AGNES_API_KEY'),
  defaultModel: Schema.union(MODELS).default('gemini-3.1-flash-image-preview'),
  defaultAspectRatio: Schema.union(ASPECT_RATIOS).default('16:9'),
  defaultImageSize: Schema.union(IMAGE_SIZES).default('4K'),
  defaultQuality: Schema.union(QUALITY_VALUES).default('medium'),
  defaultGenerationMode: Schema.union(GENERATION_MODES).default('default'),
  defaultUpscaleModel: Schema.union(MODELS).default('gemini-3-pro-image-preview'),
  defaultUpscaleImageSize: Schema.union(IMAGE_SIZES).default('4K'),
  defaultUpscalePrompt: Schema.string().default(DEFAULT_UPSCALE_PROMPT),
  outputDir: Schema.string().default('./generated/yali-images'),
  outputFormat: Schema.union(OUTPUT_FORMATS).default('jpeg'),
  httpTimeoutMs: Schema.number().step(1).min(1).default(300000),
  downloadTimeoutMs: Schema.number().step(1).min(1).default(300000),
  asyncInitialDelayMs: Schema.number().step(1).min(1).default(20000),
  asyncPollIntervalMs: Schema.number().step(1).min(1).default(2000),
  asyncMaxWaitMs: Schema.number().step(1).min(60000).default(1800000),
  maxReferenceBytes: Schema.number().step(1).min(1).default(12 * 1024 * 1024),
})

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
    prompt: { type: 'string', required: true },
    model: { type: 'string', required: true },
    protocol: { type: 'string', required: true, enum: ['gemini', 'openai_image', 'grok_image', 'agnes_image'] },
    generationMode: { type: 'string', required: true, enum: GENERATION_MODES },
    aspectRatio: { type: 'string', required: true },
    imageSize: { type: 'string', required: true },
    quality: { type: 'string', required: true, enum: QUALITY_VALUES },
    requestPath: { type: 'string', required: true },
    requestSize: { type: 'string' },
    requestResolution: { type: 'string' },
    taskIds: { type: 'array', required: true, items: { type: 'string' } },
    sourceTaskId: { type: 'string' },
  },
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const resolveApiKey = createApiKeyResolver(ctx, resolved)

  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: '通过已配置的 Yali AI 异步图像网关生成图像。支持 gpt-image-2、Gemini 图像预览模型、Grok Imagine、Agnes、参考图和可选的两阶段超分。',
    parameters: {
      prompt: { type: 'string', required: true, description: '图像生成提示词。' },
      model: { type: 'string', enum: MODELS, description: `使用的模型，默认值：${resolved.defaultModel}。` },
      aspect_ratio: { type: 'string', enum: ASPECT_RATIOS, description: `图像宽高比，默认值：${resolved.defaultAspectRatio}。` },
      image_size: { type: 'string', enum: IMAGE_SIZES, description: `图像规格档位，默认值：${resolved.defaultImageSize}。` },
      quality: { type: 'string', enum: QUALITY_VALUES, description: `gpt-image-2 的质量档位，默认值：${resolved.defaultQuality}。Grok 与 Agnes 不会发送该字段。` },
      generation_mode: { type: 'string', enum: GENERATION_MODES, description: 'default 为单模型生成；upscale 会先生成基础图像，再交给第二阶段模型超分。' },
      upscale_model: { type: 'string', enum: MODELS, description: `generation_mode=upscale 时使用的第二阶段模型，默认值：${resolved.defaultUpscaleModel}。` },
      upscale_image_size: { type: 'string', enum: IMAGE_SIZES, description: `第二阶段图像规格档位，默认值：${resolved.defaultUpscaleImageSize}。` },
      upscale_prompt: { type: 'string', description: '第二阶段提示词。支持 {image_size}、{{image_size}}、{aspect_ratio} 和 {{aspect_ratio}}。' },
      output_name: { type: 'string', description: '可选的输出文件名。目录部分会被忽略，文件始终写入已配置的 outputDir。' },
      reference_image_paths: { type: 'array', items: { type: 'string' }, description: '可选的本地图像路径，按输入顺序处理。' },
      reference_image_urls: { type: 'array', items: { type: 'string' }, description: '可选的图像 URL，会追加在本地参考图之后。' },
    },
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderToolOutput(value) }],
      presentationMeta: (_args, value) => ({
        path: value.path,
        mediaType: value.mediaType,
        model: value.model,
        generationMode: value.generationMode,
        taskIds: value.taskIds,
      }),
    },
    timeoutMs: Math.max(
      2 * (resolved.httpTimeoutMs + resolved.downloadTimeoutMs + resolved.asyncInitialDelayMs + resolved.asyncMaxWaitMs),
      resolved.asyncMaxWaitMs,
    ),
    async execute(args, exec) {
      return generateImage(args, exec, resolved, resolveApiKey)
    },
    presentCall(args) {
      const generationMode = args.generation_mode ?? resolved.defaultGenerationMode
      return {
        card: 'generic',
        title: generationMode === 'upscale' ? '生成并超分图像' : '生成图像',
        kind: 'edit',
        rawInput: args.prompt,
      }
    },
    presentResult(_args, result) {
      if (result.isError) return undefined
      const meta = result.meta
      return {
        card: 'generic',
        title: '已生成图像',
        content: typeof meta?.path === 'string' ? [{ type: 'text', text: meta.path }] : undefined,
      }
    },
  }))
}

function resolveConfig(config) {
  const endpoint = normalizeEndpoint(config.endpoint)
  const outputDir = normalizeOutputDir(config.outputDir)
  return { ...config, endpoint, outputDir }
}

async function generateImage(args, exec, config, resolveApiKey) {
  const prompt = normalizeNonEmpty(args.prompt, 'prompt')
  const model = args.model ?? config.defaultModel
  const aspectRatio = args.aspect_ratio ?? config.defaultAspectRatio
  const imageSize = args.image_size ?? config.defaultImageSize
  const quality = args.quality ?? config.defaultQuality
  const generationMode = args.generation_mode ?? config.defaultGenerationMode
  const references = normalizeReferenceInputs(args.reference_image_paths, args.reference_image_urls)
  validateGenerationParameters({ model, aspectRatio, imageSize, quality, generationMode })

  await mkdir(config.outputDir, { recursive: true })
  if (generationMode === 'upscale') {
    const upscaleModel = args.upscale_model ?? config.defaultUpscaleModel
    const upscaleImageSize = args.upscale_image_size ?? config.defaultUpscaleImageSize
    validateNativeImageParameters(upscaleModel, upscaleImageSize, aspectRatio)
    await resolveApiKey(upscaleModel, '超分模型')

    const stagingDir = await mkdtemp(join(tmpdir(), 'dsh-yali-upscale-'))
    try {
      const source = await requestStage({
        config,
        exec,
        prompt,
        model,
        aspectRatio,
        imageSize,
        quality,
        references,
        requestId: newRequestId('source'),
        resolveApiKey,
      })
      const sourcePath = await saveOutput(source.output, stagingDir, sourceFileName(prompt), config, exec.signal)
      const upscalePrompt = renderUpscalePrompt(args.upscale_prompt ?? config.defaultUpscalePrompt, upscaleImageSize, aspectRatio)
      const final = await requestStage({
        config,
        exec,
        prompt: upscalePrompt,
        model: upscaleModel,
        aspectRatio,
        imageSize: upscaleImageSize,
        quality,
        references: [{ kind: 'path', value: sourcePath }],
        requestId: newRequestId('upscale'),
        resolveApiKey,
      })
      const finalPath = await saveOutput(final.output, config.outputDir, args.output_name, config, exec.signal)
      return {
        path: finalPath.path,
        mediaType: finalPath.mediaType,
        prompt,
        model: upscaleModel,
        protocol: modelProtocol(upscaleModel),
        generationMode,
        aspectRatio,
        imageSize: upscaleImageSize,
        quality,
        requestPath: final.requestPath,
        ...final.requestSize === undefined ? {} : { requestSize: final.requestSize },
        ...final.requestResolution === undefined ? {} : { requestResolution: final.requestResolution },
        taskIds: [source.taskId, final.taskId],
        sourceTaskId: source.taskId,
      }
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  }

  const stage = await requestStage({
    config,
    exec,
    prompt,
    model,
    aspectRatio,
    imageSize,
    quality,
    references,
    requestId: newRequestId('single'),
    resolveApiKey,
  })
  const saved = await saveOutput(stage.output, config.outputDir, args.output_name, config, exec.signal)
  return {
    path: saved.path,
    mediaType: saved.mediaType,
    prompt,
    model,
    protocol: modelProtocol(model),
    generationMode,
    aspectRatio,
    imageSize,
    quality,
    requestPath: stage.requestPath,
    ...stage.requestSize === undefined ? {} : { requestSize: stage.requestSize },
    ...stage.requestResolution === undefined ? {} : { requestResolution: stage.requestResolution },
    taskIds: [stage.taskId],
  }
}

async function requestStage({ config, exec, prompt, model, aspectRatio, imageSize, quality, references, requestId, resolveApiKey }) {
  const apiKey = await resolveApiKey(model, '模型')
  const request = await buildStageRequest(config, { model, prompt, references, aspectRatio, imageSize, quality }, exec.signal)
  const accepted = await submitAsyncRequest(config, request.url, apiKey, requestId, request.body, request.formData, exec.signal)
  const output = await pollAsyncTask(config, apiKey, accepted, exec.signal)
  return {
    output,
    taskId: accepted.taskId,
    requestPath: new URL(request.url).pathname,
    ...request.requestSize === undefined ? {} : { requestSize: request.requestSize },
    ...request.requestResolution === undefined ? {} : { requestResolution: request.requestResolution },
  }
}

async function buildStageRequest(config, request, signal) {
  const protocol = modelProtocol(request.model)
  if (protocol === 'gemini') return buildGeminiRequest(config, request, signal)
  if (protocol === 'openai_image') return buildOpenAIImageRequest(config, request, signal)
  if (protocol === 'grok_image') return buildGrokRequest(config, request, signal)
  return buildAgnesRequest(config, request, signal)
}

async function buildGeminiRequest(config, { model, prompt, references, aspectRatio, imageSize }, signal) {
  const generationConfig = { responseModalities: ['IMAGE'] }
  const imageConfig = {}
  if (aspectRatio !== 'auto') imageConfig.aspectRatio = aspectRatio
  if (imageSize) imageConfig.imageSize = imageSize
  if (Object.keys(imageConfig).length > 0) generationConfig.imageConfig = imageConfig
  return {
    url: `${config.endpoint}/v1beta/models/${model}:generateContent`,
    body: {
      async: true,
      contents: [{
        role: 'user',
        parts: await geminiParts(prompt, references, config, signal),
      }],
      generationConfig,
    },
  }
}

async function buildOpenAIImageRequest(config, { model, prompt, references, aspectRatio, imageSize, quality }, signal) {
  const size = buildGptImageSize(aspectRatio, imageSize)
  const common = {
    model,
    prompt,
    size,
    quality,
    n: 1,
    response_format: 'url',
    output_format: config.outputFormat,
    async: true,
  }
  const localReferences = references.filter(reference => reference.kind === 'path')
  const remoteReferences = references.filter(reference => reference.kind === 'url')
  if (localReferences.length > 0) {
    const formData = new FormData()
    for (const [key, value] of Object.entries(common)) formData.append(key, String(value))
    for (const reference of localReferences) {
      const bytes = await readBoundedFile(reference.value, config.maxReferenceBytes, signal)
      formData.append('image', new Blob([bytes], { type: mediaTypeFromPath(reference.value) }), basename(reference.value))
    }
    return { url: `${config.endpoint}/v1/images/edits`, formData, requestSize: size }
  }
  if (remoteReferences.length > 0) {
    return {
      url: `${config.endpoint}/v1/images/edits`,
      body: { ...common, image: remoteReferences.length === 1 ? remoteReferences[0].value : remoteReferences.map(reference => reference.value) },
      requestSize: size,
    }
  }
  return { url: `${config.endpoint}/v1/images/generations`, body: common, requestSize: size }
}

async function buildGrokRequest(config, { model, prompt, references, aspectRatio, imageSize }, signal) {
  const native = nativeImageParameters(model, imageSize, aspectRatio)
  const common = {
    model,
    prompt,
    resolution: native.resolution,
    aspect_ratio: native.aspect_ratio,
    response_format: 'url',
    async: true,
  }
  return buildOpenAICompatibleJsonRequest(config, model, references, common, native.resolution, signal)
}

async function buildAgnesRequest(config, { model, prompt, references, aspectRatio, imageSize }, signal) {
  const native = nativeImageParameters(model, imageSize, aspectRatio)
  const common = {
    model,
    prompt,
    size: native.size,
    ratio: native.ratio,
    response_format: 'url',
    async: true,
  }
  const imageValues = await referenceValues(references, config, signal)
  if (imageValues.length > 0) common.extra_body = { image: imageValues }
  return { url: `${config.endpoint}/v1/images/generations`, body: common, requestSize: native.size }
}

async function buildOpenAICompatibleJsonRequest(config, model, references, common, requestResolution, signal) {
  const imageValues = await referenceValues(references, config, signal)
  if (imageValues.length > 0) {
    return {
      url: `${config.endpoint}/v1/images/edits`,
      body: { ...common, image: imageValues.length === 1 ? imageValues[0] : imageValues },
      requestResolution,
    }
  }
  return { url: `${config.endpoint}/v1/images/generations`, body: common, requestResolution }
}

async function submitAsyncRequest(config, url, apiKey, requestId, body, formData, signal) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'X-Request-ID': requestId,
    'Idempotency-Key': requestId,
  }
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: formData === undefined ? { ...headers, 'Content-Type': 'application/json' } : headers,
    body: formData === undefined ? JSON.stringify(body) : formData,
    signal,
  }, config.httpTimeoutMs)
  const payload = await parseJsonResponse(response, 'Yali AI 异步任务提交')
  if (response.status !== 202) {
    throw new Error(`Yali AI 异步任务提交失败，HTTP ${response.status}: ${payload.message ?? JSON.stringify(payload).slice(0, 1000)}`)
  }
  const taskId = String(payload.task_id ?? '').trim()
  if (taskId.length === 0) throw new Error('Yali AI 异步任务提交响应缺少 task_id')
  return {
    taskId,
    queryPath: String(payload.query_path ?? `/v1/image/tasks/${taskId}`),
  }
}

async function pollAsyncTask(config, apiKey, accepted, signal) {
  await sleep(config.asyncInitialDelayMs, signal)
  const deadline = Date.now() + config.asyncMaxWaitMs
  const queryUrl = absoluteGatewayUrl(config.endpoint, accepted.queryPath)
  while (Date.now() < deadline) {
    const response = await fetchWithTimeout(queryUrl, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal,
    }, config.httpTimeoutMs)
    const payload = await parseJsonResponse(response, 'Yali AI 任务轮询')
    if (response.status !== 200) {
      throw new Error(`Yali AI 任务轮询失败，HTTP ${response.status}: ${payload.message ?? JSON.stringify(payload).slice(0, 1000)}`)
    }
    const status = String(payload.status ?? '').toLowerCase()
    if (status === 'completed') {
      const outputs = extractAsyncOutputs(payload)
      if (outputs.length === 0) throw new Error('Yali AI 任务已完成，但响应中没有图像 URL 或 Base64 数据')
      return outputs[0]
    }
    if (['failed', 'cancelled', 'canceled', 'expired'].includes(status)) {
      const message = payload.error?.message ?? payload.error?.code ?? payload.message ?? status
      throw new Error(`Yali AI 任务状态为 ${status}: ${message}`)
    }
    await sleep(config.asyncPollIntervalMs, signal)
  }
  throw new Error(`Yali AI 任务轮询超时，task_id=${accepted.taskId}`)
}

async function parseJsonResponse(response, label) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${label} 返回了非 JSON 响应，HTTP ${response.status}: ${text.slice(0, 1000)}`, { cause: error })
  }
}

function extractAsyncOutputs(payload) {
  const result = typeof payload.result === 'object' && payload.result !== null ? payload.result : payload
  const data = Array.isArray(result.data) ? result.data : []
  const outputs = []
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue
    if (typeof item.url === 'string' && item.url.length > 0) outputs.push({ type: 'url', value: item.url })
    if (typeof item.b64_json === 'string' && item.b64_json.length > 0) outputs.push({ type: 'b64', value: item.b64_json })
  }
  if (outputs.length > 0) return outputs

  const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
    for (const part of parts) {
      const inline = part.inlineData ?? part.inline_data
      if (typeof inline?.data === 'string') outputs.push({ type: 'b64', value: inline.data })
      const fileData = part.fileData ?? part.file_data
      if (typeof fileData?.fileUri === 'string') outputs.push({ type: 'url', value: fileData.fileUri })
    }
  }
  return outputs
}

async function saveOutput(output, outputDir, rawName, config, signal) {
  if (output.type === 'url') {
    const url = absoluteGatewayUrl(config.endpoint, output.value)
    const response = await fetchWithTimeout(url, { signal }, config.downloadTimeoutMs)
    if (!response.ok) throw new Error(`生成图像下载失败，HTTP ${response.status}`)
    const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim() || mediaTypeFromUrl(url)
    const bytes = Buffer.from(await response.arrayBuffer())
    const path = join(outputDir, normalizeOutputName(rawName, mediaType))
    await writeFile(path, bytes)
    return { path, mediaType }
  }
  const bytes = Buffer.from(stripDataUrl(output.value), 'base64')
  const mediaType = mediaTypeFromDataUrl(output.value) ?? 'image/png'
  const path = join(outputDir, normalizeOutputName(rawName, mediaType))
  await writeFile(path, bytes)
  return { path, mediaType }
}

async function geminiParts(prompt, references, config, signal) {
  const parts = [{ text: prompt }]
  for (const reference of references) {
    if (reference.kind === 'url') {
      parts.push({ fileData: { mimeType: mediaTypeFromUrl(reference.value), fileUri: reference.value } })
      continue
    }
    const bytes = await readBoundedFile(reference.value, config.maxReferenceBytes, signal)
    parts.push({
      inlineData: {
        mimeType: mediaTypeFromPath(reference.value),
        data: Buffer.from(bytes).toString('base64'),
      },
    })
  }
  return parts
}

async function referenceValues(references, config, signal) {
  const values = []
  for (const reference of references) {
    if (reference.kind === 'url') {
      values.push(reference.value)
      continue
    }
    const bytes = await readBoundedFile(reference.value, config.maxReferenceBytes, signal)
    values.push(`data:${mediaTypeFromPath(reference.value)};base64,${Buffer.from(bytes).toString('base64')}`)
  }
  return values
}

async function readBoundedFile(path, maxBytes, signal) {
  const data = await readFile(path, { signal })
  if (data.byteLength > maxBytes) {
    throw new Error(`参考图超过 maxReferenceBytes 限制（${maxBytes} 字节）：${path}`)
  }
  return data
}

function normalizeReferenceInputs(paths, urls) {
  const references = []
  for (const value of Array.isArray(paths) ? paths : []) {
    const trimmed = String(value).trim()
    if (trimmed.length > 0) references.push({ kind: 'path', value: trimmed })
  }
  for (const value of Array.isArray(urls) ? urls : []) {
    const trimmed = String(value).trim()
    if (trimmed.length === 0) continue
    const parsed = new URL(trimmed)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`参考图 URL 必须使用 http 或 https：${trimmed}`)
    references.push({ kind: 'url', value: trimmed })
  }
  return references
}

function validateGenerationParameters({ model, aspectRatio, imageSize, quality, generationMode }) {
  if (!MODELS.includes(model)) throw new Error(`不支持的模型：${model}`)
  if (!ASPECT_RATIOS.includes(aspectRatio)) throw new Error(`不支持的 aspect_ratio：${aspectRatio}`)
  if (!IMAGE_SIZES.includes(imageSize)) throw new Error(`不支持的 image_size：${imageSize}`)
  if (!QUALITY_VALUES.includes(quality)) throw new Error(`quality 必须为以下值之一：${QUALITY_VALUES.join(', ')}`)
  if (!GENERATION_MODES.includes(generationMode)) throw new Error('generation_mode 必须为 default 或 upscale')
  validateNativeImageParameters(model, imageSize, aspectRatio)
}

function validateNativeImageParameters(model, imageSize, aspectRatio) {
  nativeImageParameters(model, imageSize, aspectRatio)
}

function nativeImageParameters(model, imageSize, aspectRatio) {
  const protocol = modelProtocol(model)
  if (protocol === 'grok_image') {
    if (!['1K', '2K'].includes(imageSize)) throw new Error('grok-imagine-image-quality 仅支持 1K 或 2K')
    if (!GROK_ASPECT_RATIOS.has(aspectRatio)) throw new Error(`grok-imagine-image-quality 不支持 aspect_ratio ${aspectRatio}`)
    return { resolution: imageSize === '1K' ? '1k' : '2k', aspect_ratio: aspectRatio }
  }
  if (protocol === 'agnes_image') {
    if (!AGNES_ASPECT_RATIOS.has(aspectRatio)) throw new Error(`agnes-image-2.1-flash 不支持 aspect_ratio ${aspectRatio}`)
    return { size: imageSize, ratio: aspectRatio }
  }
  if (imageSize === '3K') {
    const label = protocol === 'openai_image' ? 'gpt-image-2' : 'Gemini'
    throw new Error(`${label} 不支持 3K，请使用 1K、2K 或 4K`)
  }
  if (protocol === 'openai_image') buildGptImageSize(aspectRatio, imageSize)
  return { size: imageSize, ratio: aspectRatio }
}

function buildGptImageSize(aspectRatio, imageSize) {
  const ratio = aspectRatio === 'auto' ? '1:1' : aspectRatio
  const sizeMap = GPT_IMAGE_SIZE_MAP[imageSize]
  if (sizeMap === undefined) throw new Error(`gpt-image-2 不支持 image_size ${imageSize}`)
  const size = sizeMap[ratio]
  if (size === undefined) {
    throw new Error(`gpt-image-2 在 image_size ${imageSize} 下不支持 aspect_ratio ${aspectRatio}；支持的比例为：${Object.keys(sizeMap).join(', ')}`)
  }
  return size
}

function modelProtocol(model) {
  if (GPT_IMAGE_MODELS.has(model)) return 'openai_image'
  if (GROK_IMAGE_MODELS.has(model)) return 'grok_image'
  if (AGNES_IMAGE_MODELS.has(model)) return 'agnes_image'
  if (GEMINI_MODELS.has(model)) return 'gemini'
  return 'gemini'
}

function apiKeyEnvForModel(config, model) {
  const envName = {
    openai_image: config.gptApiKeyEnv,
    gemini: config.geminiApiKeyEnv,
    grok_image: config.grokApiKeyEnv,
    agnes_image: config.agnesApiKeyEnv,
  }[modelProtocol(model)]
  return envName
}

function createApiKeyResolver(ctx, config) {
  return async (model, label) => {
    const envName = apiKeyEnvForModel(config, model)
    const credential = await ctx.credentials.resolve(envName)
    const value = credential?.value.trim() ?? ''
    if (value.length > 0) return value
    throw new Error(`缺少 ${label} API 密钥，请在凭据设置中保存 ${envName}，或在启动环境中设置该变量`)
  }
}

function normalizeEndpoint(endpoint) {
  const value = String(endpoint ?? '').trim() || 'https://api.yaliai.com'
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('endpoint 必须是 http 或 https URL')
  if (parsed.search || parsed.hash) throw new Error('endpoint 不能包含查询参数或片段')
  return value.replace(/\/+$/, '')
}

function normalizeOutputDir(outputDir) {
  const value = String(outputDir ?? '').trim()
  if (value.length === 0) throw new Error('outputDir 必须是非空字符串')
  return isAbsolute(value) ? value : resolve(process.cwd(), value)
}

function normalizeNonEmpty(value, name) {
  const text = String(value ?? '').trim()
  if (text.length === 0) throw new Error(`${name} 必须是非空字符串`)
  return text
}

function renderUpscalePrompt(template, imageSize, aspectRatio) {
  const text = normalizeNonEmpty(template, 'upscale_prompt')
  return text
    .replaceAll('{{image_size}}', imageSize)
    .replaceAll('{image_size}', imageSize)
    .replaceAll('{{aspect_ratio}}', aspectRatio)
    .replaceAll('{aspect_ratio}', aspectRatio)
}

function newRequestId(stage) {
  return `dsh_yali_image_${stage}_${Date.now()}_${randomUUID()}`
}

function sourceFileName(prompt) {
  return `source-${createHash('sha256').update(prompt).digest('hex').slice(0, 12)}.png`
}

function normalizeOutputName(rawName, mediaType) {
  const fallback = `image-${Date.now()}-${randomUUID().slice(0, 8)}`
  const name = String(rawName ?? '').trim() || fallback
  const leaf = name.replace(/[\\/:*?"<>|]+/g, '-').replace(/^-|-$/g, '')
  const safeLeaf = leaf.length > 0 ? leaf : fallback
  return extname(safeLeaf).length > 0 ? safeLeaf : `${safeLeaf}${extensionForMediaType(mediaType)}`
}

function renderToolOutput(value) {
  const taskLine = value.taskIds.length > 0 ? `\n<task_ids>${value.taskIds.join(',')}</task_ids>` : ''
  const sourceLine = value.sourceTaskId === undefined ? '' : `\n<source_task_id>${value.sourceTaskId}</source_task_id>`
  return `<path>${value.path}</path>
<type>image</type>
<content>
已使用 ${value.model}（${value.protocol}）以 ${value.generationMode} 模式生成 ${value.mediaType} 图像。
宽高比：${value.aspectRatio}；图像规格：${value.imageSize}；质量：${value.quality}。${taskLine}${sourceLine}
</content>`
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs)
  const callerSignal = init.signal
  const abort = () => timeoutController.abort()
  callerSignal?.addEventListener('abort', abort, { once: true })
  try {
    return await fetch(url, { ...init, signal: timeoutController.signal })
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', abort)
  }
}

function sleep(ms, signal) {
  return new Promise((resolveSleep, rejectSleep) => {
    if (signal.aborted) {
      rejectSleep(signal.reason instanceof Error ? signal.reason : new Error('operation aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolveSleep()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      rejectSleep(signal.reason instanceof Error ? signal.reason : new Error('operation aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function absoluteGatewayUrl(endpoint, value) {
  const text = String(value ?? '').trim()
  if (text.startsWith('http://') || text.startsWith('https://')) return text
  return new URL(text.replace(/^\/+/, ''), `${endpoint}/`).toString()
}

function mediaTypeFromPath(path) {
  const extension = extname(path).toLowerCase()
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.gif') return 'image/gif'
  return 'image/png'
}

function mediaTypeFromUrl(url) {
  return mediaTypeFromPath(new URL(url).pathname)
}

function mediaTypeFromDataUrl(value) {
  return parseDataUrl(value)?.mediaType
}

function stripDataUrl(value) {
  const text = String(value)
  return text.startsWith('data:') && text.includes(',') ? text.split(',', 2)[1] : text
}

function parseDataUrl(value) {
  const text = String(value)
  if (!text.startsWith('data:') || !text.includes(',')) return { mediaType: 'image/png', base64: text }
  const [header, base64] = text.split(',', 2)
  const mediaType = header.slice('data:'.length).split(';')[0] || 'image/png'
  return { mediaType, base64 }
}

function extensionForMediaType(mediaType) {
  if (mediaType === 'image/jpeg') return '.jpg'
  if (mediaType === 'image/webp') return '.webp'
  if (mediaType === 'image/gif') return '.gif'
  return '.png'
}
