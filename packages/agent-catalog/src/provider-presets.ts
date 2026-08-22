/*
 * 内置厂商清单。
 *
 * 为什么是内置的：agent 的目录命令（kimi provider catalog list/add）每次都要现拉
 * models.dev，拉不到就 exit 1 —— 它没有内置兜底（apps/kimi-code/src/cli/sub/provider.ts
 * 的 loadCatalogOrExit）。在拿不到 models.dev 的网络里，那条路整条不通，不只是某一家。
 *
 * 业界标杆也是内置的：Zed 的 crates/language_models/src/provider/deepseek.rs 在
 * provided_models() 里直接 models.insert("deepseek-v4-flash" / "deepseek-v4-pro")，
 * 再叠加用户在 settings 里追加的 available_models。内置 + 可追加，两层。
 *
 * 代价是会过时，这个代价是真的：DeepSeek 的 deepseek-chat / deepseek-reasoner 两个
 * 别名已于 2026-07-24 停用，Zed 里也已经删掉了。所以每条模型都注明证据来源，改的时候
 * 回去核，而不是照着记忆改。治本的来源是各家的 GET /models 端点，那是下一刀的事。
 *
 * 这里不放密钥，一个字节都不放。密钥经环境变量交给 agent，写入由它自己完成。
 *
 * 这个模块此前叫 builtin-catalog.ts，还兼着两件不属于它的事：某一家 agent 的目录文档
 * 格式（已搬去 kimi/catalog.ts），以及别名与显示名的换算（已搬去
 * model-display.ts）。现在它只剩一张常量表，因此一个 import 都没有 —— 一张表反向依赖
 * 运行时快照类型（AgentModelState），方向本来就是错的。
 */

/** 思考能力。有逐字证据才填；缺席表示不声明，而不是不支持。 */
export interface AgentProviderPresetModelThinking {
  /** 推理档位，原样进 reasoning_options 的 values（对方请求体 reasoning_effort 的取值）。 */
  readonly efforts?: readonly string[]
  /** 思考可以整个关掉（对方的 thinking.type enabled/disabled）。 */
  readonly toggle?: boolean
}

export interface AgentProviderPresetModel {
  /** 原样交给对方 API 的 model id。大小写与连字符都不能改。 */
  readonly id: string
  readonly displayName: string
  /** 上下文窗口，只在有明确出处时才填。取不到就缺席，不估。 */
  readonly maxContextSize?: number
  readonly thinking?: AgentProviderPresetModelThinking
}

export interface AgentProviderPreset {
  /** 写进 agent 配置时用的 provider 标识。 */
  readonly id: string
  readonly displayName: string
  readonly description: string
  /** 协议名。原样交给 agent，取值由它认，所以这里不枚举 —— 上游的
   * ProviderTypeSchema 是 z.string()。 */
  readonly wire: string
  /** 接口地址。内置默认，不给用户手填 —— Zed 的 api_url() 也是这个形状。 */
  readonly baseUrl: string
  /** 去哪里申请密钥。照 Zed 的 ApiKeyConfiguration 第四个参数。 */
  readonly apiKeysUrl: string
  readonly models: readonly AgentProviderPresetModel[]
}

/*
 * DeepSeek
 * 协议：OpenAI Chat Completions。kimi-code 的 providers.md 在 openai 那一行逐字写着
 *   「OpenAI and compatible services, DeepSeek, Qwen, etc.」
 * base URL：官方文档 base_url (OpenAI) = https://api.deepseek.com
 * 模型：Zed 的 provided_models() 逐字两条，与官方变更日志一致。
 * 上下文：Zed 的 crates/deepseek/src/deepseek.rs 逐字 —— V4Flash | V4Pro => 1_000_000。
 * 这一格不能缺席：对方的目录解析器把没有 limit.context 的模型整条丢掉
 * （kosong/src/catalog.ts 的 catalogModelToCapability）。
 * 思考：同一份 Zed 源码逐字 —— Thinking {Enabled|Disabled}（可整个关掉），
 * ReasoningEffort {High, Max} 带 #[serde(rename_all = "lowercase")]（档位 high / max）。
 * 官方 2026-08-13 更新日志把两款的档位扩成 low / high / max，此处以日志为准。
 *
 * deepseek-v4-flash-vision-exp：官方更新日志 2026-08-21 逐字 —— 多模态视觉理解模型，
 *   model='deepseek-v4-flash-vision-exp'，「纯文本能力与 DeepSeek-V4-Flash 相当」。
 *   上下文因此沿用 Flash 那一格的出处（Zed 逐字 1_000_000）；深度思考没有它的
 *   逐字证据，一格都不声明。
 */
const DEEPSEEK: AgentProviderPreset = {
  id: 'deepseek',
  displayName: 'DeepSeek',
  description: '填入 DeepSeek 平台密钥，按用量直接计费到该账号',
  wire: 'openai',
  baseUrl: 'https://api.deepseek.com',
  apiKeysUrl: 'https://platform.deepseek.com/api_keys',
  models: [
    {
      id: 'deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
      maxContextSize: 1000000,
      thinking: { efforts: ['low', 'high', 'max'], toggle: true },
    },
    {
      id: 'deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
      maxContextSize: 1000000,
      thinking: { efforts: ['low', 'high', 'max'], toggle: true },
    },
    {
      id: 'deepseek-v4-flash-vision-exp',
      displayName: 'DeepSeek V4 Flash Vision Exp',
      maxContextSize: 1000000,
    },
  ],
}

/*
 * 智谱 GLM
 * base URL 与模型 id：官方 GLM-5.2 文档页的 cURL 示例逐字 ——
 *   POST https://open.bigmodel.cn/api/paas/v4/chat/completions，"model": "glm-5.2"
 * glm-4.6 取自文档页路径 /cn/guide/models/text/glm-4.6 与多方配置示例。
 *
 * GLM-5.1 / GLM-5 / GLM-4.7 只在「模型概览」里拿到展示名，没有拿到调用示例里的
 * 模型编码，所以不写 —— 少一项好过错一项。
 *
 * 思考：官方「深度思考」文档逐字 —— thinking.type enabled（默认）/ disabled，GLM-5.2
 * 与 GLM-4.6 都支持；reasoning_effort 仅 GLM-5.2 及以上，取值 max（默认且推荐）/
 * xhigh / high / medium / low / minimal / none，none 或 minimal 表示放弃思考。
 * glm-4.6 没有 reasoning_effort 的证据，只声明开关。
 *
 * glm-4-flash：官方 GLM-4 系列文档页逐字 —— 「免费语言模型 GLM-4-Flash」，
 *   上下文窗口 128K；调用编码取官方 SDK 示例逐字 model="glm-4-flash"。
 *   深度思考没有它的证据，一格都不声明。
 *
 * 注：Coding Plan 套餐另有 /api/coding/paas/v4 与 /api/anthropic 两个入口。等确认你
 * 用的是哪种账号再加，现在不猜。
 */
const ZHIPU: AgentProviderPreset = {
  id: 'zhipu',
  displayName: '智谱 GLM',
  description: '填入智谱开放平台密钥，走 OpenAI 兼容接口',
  wire: 'openai',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKeysUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  models: [
    {
      id: 'glm-5.2',
      displayName: 'GLM-5.2',
      maxContextSize: 1000000,
      thinking: {
        efforts: ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'],
        toggle: true,
      },
    },
    {
      id: 'glm-4.6',
      displayName: 'GLM-4.6',
      maxContextSize: 200000,
      thinking: { toggle: true },
    },
    {
      id: 'glm-4-flash',
      displayName: 'GLM-4-Flash',
      maxContextSize: 128000,
    },
  ],
}

/*
 * Kimi（Moonshot 平台密钥 · 国内站）
 *
 * id 与 base URL 不是挑的，是生态里已经存在的真实身份：用户的全局 config.toml
 * 逐字写着 [providers.moonshot-cn]（type = "kimi"、base_url = https://api.moonshot.cn/v1），
 * models.dev 的国内条目是 moonshotai-cn。此前这张卡自起 id moonshot、指向国际站
 * api.moonshot.ai —— 后果有两层：同一家厂商在两个 id 下各存一份（kimi 的去重只在
 * 同 id 上生效），模型列表整套显示两遍；国内平台的密钥打国际站端点直接 401。
 *
 * 密钥申请地址：国内控制台逐字 https://platform.moonshot.cn/console/api-keys。
 *
 * 模型：Kimi 开放平台模型列表页逐字。上下文改官方二进制：用户的 config.toml 逐字
 * max_context_size = 262144（K2.x）/ 1048576（K3）。
 *
 * id 不叫 kimi：agent 自己的配置里 kimi 这个 provider 是它的托管服务（/login 走
 * OAuth）。同名导入会把那一条替换掉 —— catalog add 对已存在的 id 是先删再建。
 *
 * 思考：官方 Model Parameter Reference 逐字 —— K3 永远思考（Preserved Thinking），
 * reasoning_effort 支持 low / high / max（默认 max），没有 off；「从 K2.x 迁移到 K3
 * 时移除 K2.x 的 thinking 配置」一句证明 K2.x 是 thinking 开关。K3 在 kimi 线上不会被
 * 误判成不可关：kosong 对 anthropic / kimi 两种协议剥掉 alwaysThinking。
 */
const MOONSHOT: AgentProviderPreset = {
  id: 'moonshot-cn',
  displayName: 'Kimi（China）',
  description: '填入 Kimi 开放平台密钥，托管账号请用 agent 自己的登录',
  wire: 'kimi',
  baseUrl: 'https://api.moonshot.cn/v1',
  apiKeysUrl: 'https://platform.moonshot.cn/console/api-keys',
  models: [
    {
      id: 'kimi-k3',
      displayName: 'Kimi K3',
      maxContextSize: 1048576,
      thinking: { efforts: ['low', 'high', 'max'] },
    },
    {
      id: 'kimi-k2.7-code',
      displayName: 'Kimi K2.7 Code',
      maxContextSize: 262144,
      thinking: { toggle: true },
    },
    {
      id: 'kimi-k2.7-code-highspeed',
      displayName: 'Kimi K2.7 Code Highspeed',
      maxContextSize: 262144,
      thinking: { toggle: true },
    },
    {
      id: 'kimi-k2.6',
      displayName: 'Kimi K2.6',
      maxContextSize: 262144,
      thinking: { toggle: true },
    },
    {
      id: 'kimi-k2.5',
      displayName: 'Kimi K2.5',
      maxContextSize: 262144,
      thinking: { toggle: true },
    },
  ],
}

/*
 * OpenRouter
 * 协议：openai。官方 Quick Start 逐字 —— 「OpenRouter's API is OpenAI-compatible —
 *   most SDKs work by just swapping the base URL」。
 * base URL：官方文档的统一入口 https://openrouter.ai/api/v1。
 * 密钥：控制台 https://openrouter.ai/settings/keys。
 *
 * stealth/ox-alpha：模型页 openrouter.ai/stealth/ox-alpha 与
 *   GET api/v1/models/stealth/ox-alpha/endpoints（2026-08-22 取）逐字 ——
 *   context_length 1048576、pricing 全 0、supported_parameters 含 reasoning 与
 *   reasoning_effort。档位取值 Low / High / Max 出自该模型设置界面的强度下拉
 *   （用户提供截图，2026-08-22），小写写入；下拉里没有关的一档，「能否整个关掉」
 *   无证据，toggle 不声明。
 *
 * 模型 id 自带一段斜杠（stealth/），别处按 provider/ 剥前缀时只剥第一段
 * （model-display.ts 的 bareModelId），剥完仍是原 id，来回无损；命令行参数白名单
 * （kimi/catalog-add.ts 的 ARG_PATTERN）本来就放行斜杠与冒号。
 *
 * z-ai/glm-5.2:free：GET api/v1/models/z-ai/glm-5.2:free/endpoints（2026-08-22 取）
 *   逐字 —— context_length 256000、pricing 全 0、supported_parameters 含 tools 与
 *   reasoning_effort。OpenRouter 未枚举档位取值，thinking 不声明；要完整档位走上面
 *   智谱直连那张卡。
 */
const OPENROUTER: AgentProviderPreset = {
  id: 'openrouter',
  displayName: 'OpenRouter',
  description: '填入 OpenRouter 密钥，一个账号调用挂在上面的全部模型',
  wire: 'openai',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKeysUrl: 'https://openrouter.ai/settings/keys',
  models: [
    {
      id: 'stealth/ox-alpha',
      displayName: 'Ox Alpha',
      maxContextSize: 1048576,
      thinking: { efforts: ['low', 'high', 'max'] },
    },
    {
      id: 'z-ai/glm-5.2:free',
      displayName: 'GLM 5.2 (free)',
      maxContextSize: 256000,
    },
  ],
}

const PRESETS: readonly AgentProviderPreset[] = [DEEPSEEK, ZHIPU, MOONSHOT, OPENROUTER]

/** 设置界面要显示的厂商，顺序即显示顺序。 */
export function builtinAgentProviders(): readonly AgentProviderPreset[] {
  return PRESETS
}

/** 按 id 取一家。取不到返回 undefined，不兜底成第一家。 */
export function builtinAgentProviderById(id: string): AgentProviderPreset | undefined {
  return PRESETS.find((preset) => preset.id === id)
}

/*
 * agentProviderModelOptions 曾在这里：一张厂商卡一个「默认模型」下拉。
 *
 * 删掉不是因为它有 bug，是那个形状本身错了。配置里的 default_model 是顶层唯一的一个
 * 键，界面却给每家画一格；catalog add 又是最后写的那家赢，于是三张卡各显示各的内置表
 * 首条，没有一张说的是真话 —— 「图标还是 DeepSeek、模型却成了 Kimi」就是这里来的。
 *
 * Zed 的形状是单数：crates/agent_settings/src/agent_settings.rs 上
 * pub default_model: Option<LanguageModelSelection>，而 LanguageModelSelection
 * （crates/settings_content/src/agent.rs）里同时装着 provider 与 model —— 全局一份，
 * 跨厂商单选。现在那一格在 ModelsSettings 里，候选是所有已配置的模型。
 */
