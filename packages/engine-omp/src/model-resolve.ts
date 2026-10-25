import { resolveSessionModelSelector } from '@oh-my-pi/pi-coding-agent/config/model-resolver'
import type { OmpModelLike } from './ports/model-helpers'

/*
 * 会话初始化时的模型解析。**回传的是注册表里那一条模型对象本身，不是 `{provider,id}` 精简对**：
 * createAgentSession 的 model 参数要完整 Model 实例（SDK 会读 api、baseUrl、identity.class、compat…），
 * 回传精简对时 SDK 走到 model.identity.class 当场抛错，会话起不来（真实故障）。
 * 解析用 omp 官方的 resolveSessionModelSelector（启动恢复与切模型走的就是它，还多认 `:thinkingLevel`
 * 与 `:max` 后缀）—— 不自己再写一份解析器，上游改语法这里跟着走，不会分叉。
 */

/**
 * 解析一条模型：从注册表里找出**那一条实例**，并要求 provider 真的配过凭据。
 *
 * 解析不出（选择器坏、目录里没有、没配凭据）如实交回 null，由调用方决定
 * 「不传 model，交给 SDK 自己的兜底」——不在这里替用户换一条。
 */
export function resolveSessionModel<TModel extends OmpModelLike>(
  registry: { find(provider: string, modelId: string): TModel | undefined; hasConfiguredAuth(model: TModel): boolean },
  selector: string | null,
): TModel | null {
  if (selector === null) {
    return null
  }
  return (resolveSessionModelSelector(registry as never, selector)?.model as TModel | undefined) ?? null
}
