/*
 * 「往 agent 的 provider 目录里加一家」这次请求说什么。
 *
 * 它是领域词汇而不是某一家 CLI 的参数表：怎么把它变成命令行，归 kimi/catalog-add.ts。
 */
export interface AgentCatalogAddRequest {
  readonly providerId: string
  readonly defaultModelId?: string
  readonly baseUrl?: string
}
