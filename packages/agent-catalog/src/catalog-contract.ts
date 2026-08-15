import type { AgentProviderPreset } from './provider-presets'
import type { AgentProviderState } from './provider-state'

/*
 * 「怎么把 provider 目录交给这一家 agent」的契约。
 *
 * 每一家 agent 的目录命令都是它自己的约定：子命令怎么念、文档什么形状、默认模型的
 * 校验名单怎么算，没有一条是 ACP 协议规定的。所以这些事按 agentId 定址，通用层只认
 * 这个接口，不认任何一家的函数名与文档格式。
 *
 * 契约与名单分开两个文件，与同包里同一件事的分法一致
 * （agent-descriptor.ts 放形状，agents.ts 放名单）：接第 N 家时要动的是名单，
 * 契约不该跟着谁的实现走。
 *
 * 缺席是有意义的答案：表示我们说不出该怎么给这一家写目录，界面于是不画那个入口，
 * 而不是画一个点了会失败的按钮 —— 与 descriptor 里 install / providerListArgs
 * 缺席的处置完全一致。
 */

/*
 * 我们想让 agent 做的那件事：把这一家 provider 加进它的目录。
 *
 * 这是请求，不是命令行。它是通用的（三格都是我们自己的概念），翻成谁的 argv 才是
 * 那一家的事 —— 见 <id>/catalog-add.ts。
 */
export interface AgentCatalogAddRequest {
  readonly providerId: string
  readonly defaultModelId?: string | undefined
  /** 在场时覆盖目录自带的接口地址（对方的 resolveCatalogImport：用户给的赢）。 */
  readonly baseUrl?: string | undefined
}

export interface AgentCatalogCodec {
  /** 把内置预设序列化成这一家目录命令认的文档。 */
  readonly catalogDocument: (presets: readonly AgentProviderPreset[]) => string
  /** 把一家已配置的 provider 序列化成同一种文档（一次性导入用）。 */
  readonly importDocument: (provider: AgentProviderState) => string
  /** 这一家该拿哪个模型当 default_model；一条都不合格时缺席。 */
  readonly defaultModelId: (provider: AgentProviderState) => string | undefined
  /** 同一个问题的另一半：手上只有内置预设时。 */
  readonly presetDefaultModelId: (preset: AgentProviderPreset) => string | undefined
  /** 把上面那个请求翻成这一家 CLI 的参数。密钥不在其中，也不可能被加进来。 */
  readonly catalogAddArgs: (request: AgentCatalogAddRequest) => readonly string[]
}
