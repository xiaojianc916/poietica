import type { OmpModelLike } from './ports/model-helpers'

/*
 * 会话初始化时的模型解析（12 页 §6.3 第 3 步）。
 *
 * **回传的是注册表里那一条模型对象本身，不是 `{provider,id}` 精简对**。
 * `createAgentSession` 的 `model` 参数要的是完整 Model 实例：SDK 会读它的 `api`、
 * `baseUrl`、`identity.class`、`compat`……（sdk.ts 的 `resolveDelegationBias`、
 * `streamDispatch`、`edit-mode` 都直接取字段）。此前这里回传精简对，SDK 走到
 * `model.identity.class` 当场抛 `undefined is not an object` —— 真机上表现为
 * 「新建对话发送后立刻报 AppError，会话起不来」（2026-10-08 用户截图）。
 *
 * 判据收在这里：纯函数、无副作用、可单测。
 */

/** 选择器是**整串** `provider/id`；id 自己可能带斜杠，所以只切第一个分隔符。 */
export function splitModelSelector(selector: string): { provider: string; id: string } | null {
  const slash = selector.indexOf('/')
  if (slash <= 0 || slash === selector.length - 1) {
    return null
  }
  return { provider: selector.slice(0, slash), id: selector.slice(slash + 1) }
}

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
  const parsed = splitModelSelector(selector)
  if (parsed === null) {
    return null
  }
  const found = registry.find(parsed.provider, parsed.id)
  if (found === undefined) {
    return null
  }
  if (!registry.hasConfiguredAuth(found)) {
    return null
  }
  return found
}
