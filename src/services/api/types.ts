/**
 * Messages API（Anthropic 兼容格式）协议类型，只取本应用用到的部分。
 * 文档：https://api-docs.deepseek.com/zh-cn/api/create-message
 * 声明 deepseek_web_search / deepseek_read_url 或设置 safety_check.level 为 high 时进入扩展模式。
 */

export type ChatModel = 'deepseek-flash' | 'deepseek-v4-pro'

// ---------- 响应：内容块 ----------

/** 正文引用：服务端把模型的引用标记还原为来源，挂在对应文本块上 */
export type TextCitation = {
  type: 'web_search_result_location'
  url: string
  /** 查不到标题时为 null */
  title: string | null
  /** 当前文本块截至该引用处的全部正文（去除首尾空白） */
  cited_text: string
  /** 恒为空串 */
  encrypted_index: string
}

/** 文本块：挂过引用的块之后，后续正文另起新块；同一块内引用按 url 去重 */
export type TextBlock = { type: 'text'; text: string; citations?: TextCitation[] }

/** 思考块：签名在块结束前经 signature_delta 下发，值为本次响应的消息 id；OpenAI 格式端点不下发签名 */
export type ThinkingBlock = { type: 'thinking'; thinking: string; signature?: string }

/** 服务端识别调用所属联网能力用的 kind，区分文字搜索、图搜及边想边搜。 */
export type ServerToolKind =
  | 'search'
  | 'deep_search'
  | 'read_link'
  | 'image_search'
  | 'deep_image_search'

/** server_tool_use 的四种动作，input 结构由 action 决定 */
export type ServerToolInput =
  | { action: 'search'; query?: string; queries: string[] }
  | { action: 'open_page'; url: string }
  /** 找不到关联页面时 url 为空串 */
  | { action: 'find_in_page'; url: string; pattern: string }
  | { action: 'read_link'; url: string }

/** 服务端工具调用块：原子下发，content_block_start 即携带完整 input */
export type ServerToolUseBlock = {
  type: 'server_tool_use'
  /** srvtoolu_{s|ds|rl|is|dis}_{序号}_{32 位 hex} */
  id: string
  /** 文字搜索与图搜均为 deepseek_web_search；read_link 为 deepseek_read_url */
  name: 'deepseek_web_search' | 'deepseek_read_url'
  input: ServerToolInput
  caller: { type: 'direct' }
  kind: ServerToolKind
}

export type WebSearchResult = {
  type: 'web_search_result'
  title: string
  url: string
  /** 图搜召回的原站图片地址，可能缺省；仅保存，当前不展示图片。 */
  image_url?: string
  /** 可直接展示的网页摘要 */
  snippet: string
  /** 站点图标 URL；无法取得注册域名时为 null */
  site_icon: string | null
  /** 无站点名称时为 null */
  site_name: string | null
  /** 搜索摘要经 AES-256-GCM 加密后的 Base64，客户端无法解密展示 */
  encrypted_content: string
  /** RFC 3339 UTC 时间，没有发布时间时为 null */
  page_age: string | null
}

export type WebSearchToolResultError = {
  type: 'web_search_tool_result_error'
  error_code: 'unavailable'
}

export type WebSearchToolResultBlock = {
  type: 'web_search_tool_result'
  tool_use_id: string
  /** 成功且无可见结果时为 []；失败时为只含一个错误项的数组 */
  content: (WebSearchResult | WebSearchToolResultError)[]
  kind: 'search' | 'deep_search' | 'image_search' | 'deep_image_search'
}

export type WebFetchResult = {
  type: 'web_fetch_result'
  url: string
  content: {
    type: 'document'
    /** read_link / deep_search 均为空串；阅读链接的页面加密在结果块的 signature 中 */
    source: { type: 'text'; media_type: 'text/plain'; data: string }
    title: string | null
  }
  /** read_link 为网页解析出的原始日期字符串；deep_search 为 RFC 3339 */
  published_at: string | null
}

export type WebFetchToolResultError = {
  type: 'web_fetch_tool_result_error'
  /** url_not_accessible 抓取失败；url_not_allowed 被拦截；unavailable 服务异常或未完成就结束 */
  error_code: 'url_not_accessible' | 'url_not_allowed' | 'unavailable'
}

export type WebFetchToolResultBlock = {
  type: 'web_fetch_tool_result'
  tool_use_id: string
  content: WebFetchResult | WebFetchToolResultError
  kind: 'read_link' | 'deep_search'
  /** 仅 read_link 成功时返回的加密页面，多轮请求原样回传；失败及 deep_search 不返回 */
  signature?: string
}

export type ServerToolBlock =
  | ServerToolUseBlock
  | WebSearchToolResultBlock
  | WebFetchToolResultBlock

/** 用于识别客户端工具调用的内容块类型 */
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }

// ---------- 请求 ----------

export type TextBlockParam = { type: 'text'; text: string }

/**
 * 文件块：引用经 Files API 上传的文件，图片用 image、其余用 document；
 * 图片请求需带 anthropic-beta: files-api-2025-04-14；扩展模式不支持 document，返回 400。
 */
export type FileBlockParam = {
  type: 'image' | 'document'
  source: { type: 'file'; file_id: string }
}

/** 末尾 assistant 自动触发继续生成，无需 prefix 字段 */
export type MessageParam =
  /** Chat Engine 扩展角色，位于对应 user 前；需服务端支持 latest_reminder。 */
  | { role: 'latest_reminder'; content: string }
  | { role: 'user'; content: string | (FileBlockParam | TextBlockParam)[] }
  | { role: 'assistant'; content: string; server_tool_calls?: ServerToolCallStep[]; prefix?: true }

/** 开启联网搜索与边想边搜 */
export type DeepseekWebSearchTool = {
  type: 'deepseek_web_search'
  name: 'deepseek_web_search'
}

/** 阅读本轮用户消息中的链接，与搜索工具独立声明 */
export type DeepseekReadUrlTool = {
  type: 'deepseek_read_url'
  name: 'deepseek_read_url'
}

export type CreateMessageRequest = {
  model: ChatModel
  /** 稳定段（人设与长期记忆），历史之前的第一条 system */
  system: string
  /** 动态段（本轮检索命中的旧事），历史之后的最后一条 system；被子模式每轮按提问现算 */
  systemSuffix?: string
  messages: MessageParam[]
  thinking: { type: 'enabled' | 'disabled' }
  /** 思考力度（thinking enabled 时才传）；官方取值 low/high/max，默认 high */
  reasoning_effort?: 'low' | 'high' | 'max'
  tools: (DeepseekWebSearchTool | DeepseekReadUrlTool)[]
  safety_check: { level: 'high' }
  title?: { enabled: boolean }
}

// ---------- OpenAI 兼容端点（POST /chat/completions）线格式 ----------
// 文档：https://api-docs.deepseek.com/zh-cn/api/create-chat-completion
// 内部模型（上面的 MessageParam / MessageStreamEvent / 内容块）保持不变；
// chatCompletions.ts 负责内部模型 ↔ 线格式的双向翻译。

/** 线格式下工具调用的动作（与内部 ServerToolInput 的 action 字段口径互转） */
export type ServerToolCallAction =
  | { type: 'search'; queries: string[]; query?: string }
  | { type: 'open_page'; url: string }
  | { type: 'find_in_page'; url: string; pattern: string }
  | { type: 'read_link'; url: string }

/** 联网工具的单次调用（线格式 server_tool_calls[].calls[] 的元素），多轮请求原样回传 */
export type ServerToolCall = {
  index: number
  id: string
  type: 'deepseek_web_search' | 'deepseek_read_url'
  kind: ServerToolKind
  action: ServerToolCallAction
  /** 响应结束时未完成的调用为 failed */
  status: 'completed' | 'failed'
  /** read_link 成功时的网页展示信息；网页正文加密在 signature 中，不直接下发 */
  page?: { url: string; title: string | null; published_at: string | null }
  /** 成功阅读的链接才有；多轮请求原样回传后服务端把网页正文拼回上下文 */
  signature?: string
  /** 搜索结果；展示字段与内部 WebSearchResult 一致，无加密摘要 */
  sources?: {
    type: 'url'
    url: string
    title: string
    snippet: string
    site_name: string | null
    site_icon: string | null
    published_at: string | null
    image_url?: string
  }[]
  error?: { code: string }
}

/** 联网工具的一步：这一步的思考 + 这一步发起的调用 */
export type ServerToolCallStep = {
  index: number
  reasoning_content: string
  calls: ServerToolCall[]
}

/** OpenAI 格式请求消息；assistant 的 server_tool_calls 原样回传，prefix 用于续写 */
export type OpenAiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ({ type: 'text'; text: string } | { type: 'file'; file_id: string })[] }
  | { role: 'latest_reminder'; content: string }
  | {
      role: 'assistant'
      content: string
      server_tool_calls?: ServerToolCallStep[]
      /** 续写：加在最后一条 assistant 消息上（beta 接口能力，真机验证项） */
      prefix?: true
    }

/** OpenAI 格式 usage。缓存字段两种口径并存（真机实测 prompt_tokens_details.cached_tokens，
 * 文档另载 prompt_cache_hit/miss_tokens），读取时用 readCacheHitTokens 取有值的那个 */
export type OpenAiUsage = {
  prompt_tokens: number
  completion_tokens: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  total_tokens: number
  completion_tokens_details?: { reasoning_tokens?: number; safety_tokens?: number }
  server_tool_use?: { tool_search?: number; tool_fetch?: number; tool_image_search?: number }
}

/** 缓存命中数：优先 prompt_cache_hit_tokens，退回 prompt_tokens_details.cached_tokens */
export const readCacheHitTokens = (usage: OpenAiUsage): number =>
  usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0

/** 流式过程中 choice 上的扩展字段，一个 chunk 最多一个事件 */
export type OpenAiServerToolEvent =
  | { type: 'step_reasoning_done'; step: number }
  | { type: 'call_started'; step: number; call: ServerToolCall }
  | { type: 'call_completed'; step: number; call: ServerToolCall }

/** 引用：位置按 content 的 Unicode 码点计数 */
export type OpenAiAnnotation = {
  type: 'url_citation'
  url_citation: { url: string; title: string | null; start_index: number; end_index: number }
}

export type OpenAiDelta = {
  content?: string | null
  reasoning_content?: string | null
  title?: string
  annotations?: OpenAiAnnotation[]
  server_tool_calls?: ServerToolCallStep[]
  refusal?: string
  /** 部分实现把过程事件放在 delta 里，与 choice 上的字段等价 */
  server_tool_event?: OpenAiChunk['choices'][number]['server_tool_event']
}

export type OpenAiFinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'insufficient_system_resource'
  | 'aborted'
  | null

export type OpenAiChunk = {
  choices: {
    index: number
    delta: OpenAiDelta
    finish_reason: OpenAiFinishReason
    server_tool_event?: OpenAiServerToolEvent
  }[]
  usage?: OpenAiUsage | null
}

// ---------- 内部流式事件（两种端点翻译后的统一形态） ----------

/** 仅内部使用：本轮请求完整的服务端工具调用（含流式事件不带走的 signature），由 applyEvent 存进回复 */
export type RawServerToolCallsEvent = { type: 'raw_server_tool_calls'; calls: ServerToolCallStep[] }

// ---------- 响应：流式事件 ----------

export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal'

export type StopDetails = { type: 'refusal'; category: null; explanation: null }

export type MessageUsage = {
  /** 未命中缓存的输入 Token */
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  /** message_start 中为 0，message_delta 中为全轮累计值 */
  output_tokens: number
  /** 仅当 message_delta 中有对外输出的搜索结果块时出现 */
  server_tool_use?: { web_search_requests: number; tool_search: number }
}

/** content_block_start 携带的初始内容块；工具块已是完整内容 */
export type OutputBlockStart = TextBlock | ThinkingBlock | ServerToolBlock | ToolUseBlock

export type ContentBlockDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string }
  | { type: 'citations_delta'; citation: TextCitation }
  | { type: 'input_json_delta'; partial_json: string }

/** 流式事件：SSE 的 event 名与 JSON 的 type 相同，以 message_stop 结束，不发送 [DONE] */
export type MessageStreamEvent =
  | {
      type: 'message_start'
      /** id 为不带 msg_ 前缀的 UUID，等于响应头 x-ds-request-id */
      message: { id: string; model: string; usage?: MessageUsage }
    }
  | { type: 'content_block_start'; index: number; content_block: OutputBlockStart }
  | { type: 'content_block_delta'; index: number; delta: ContentBlockDelta }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta'
      /** title 仅在开启标题且生成成功时出现；stop_details 仅在 refusal 时出现 */
      delta: {
        stop_reason: StopReason
        stop_sequence: null
        stop_details?: StopDetails
        title?: string
      }
      usage?: MessageUsage
    }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | RawServerToolCallsEvent

/**
 * POST /anthropic/v1/files 的 purpose：PDF 与 Word、PPT 需要服务端做版面解析；
 * 纯文本、代码、表格与电子书不需要解析，用 user_data。
 */
export type FilePurpose = 'rich_layout_recognition' | 'user_data'

/** POST /anthropic/v1/files 的响应 */
export type FileObject = {
  id: string
  type: 'file'
  size_bytes: number
  created_at: string
  filename: string
  mime_type: string
}

/** 非 2xx 响应体；流中出现只含 error 的无名 data 帧时同样按此解析 */
export type ApiErrorBody = {
  error: {
    message: string
    type?: string
    param?: string | null
    code?: string | null
  }
}
