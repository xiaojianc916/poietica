/*
 * 思考档位：候选是**这条模型自己的梯子**，不是一张四档的通用表。
 *
 * 梯子正本是模型元数据，两层产地都是数据：随包烘好的 pi-catalog models.json（构建期
 * gen:models 生成）与用户自己的 models.yml（优先）。实测 5510 行里有 18 种不同的梯子，
 * 谁在代码里写死一张档位表，谁就在报这条模型没有的档（ADR 0017）。产品不出上游的
 * 两个额外档：`off`（用户要的就是深度思考，关掉没意义）、`auto`（隐形成本：
 * agent-session.ts 的 applyAutoThinkingLevel 走 judge 角色链，我们不配便宜角色，落到
 * modelRoles.default 即用户当前这条模型、这个密钥 —— 每轮一次没点过的调用）。
 * 盘上读回的会话可能是任何旧值，收敛判据只有一条：**报出去的值必须是自己提供的那一档**。
 */

/** 读得动的会话：收敛只要这四格，收窄在这里是为了能对着规则自检。 */
export interface ThinkingSession {
  readonly agent: {
    getAvailableThinkingLevels: () => readonly string[]
    configuredThinkingLevel: () => string | undefined
    model:
      | { readonly thinking?: { readonly defaultLevel?: string | undefined } | undefined }
      | undefined
    setThinkingLevel: (level: never) => void
  }
}

/**
 * 该把会话收敛到哪一档；`undefined` = 不动。
 *
 * 已在梯子上就不动。落点全是上游默认：模型声明的 `defaultLevel` 优先 → 全局
 * `defaultThinkingLevel` → 最深一档；夹取归 setThinkingLevel，不写第二份梯子。
 */
export function thinkingToSettle(
  current: string | undefined,
  levels: readonly string[],
  modelDefault: string | undefined,
  globalDefault: string | undefined,
): string | undefined {
  if (levels.length === 0) {
    return undefined
  }

  if (current !== undefined && levels.includes(current)) {
    return undefined
  }

  const declared = modelDefault ?? globalDefault

  return declared !== undefined && levels.includes(declared) ? declared : levels[levels.length - 1]
}

/** 把上面那条判据落到一条会话上：该动才动，动就动一次。 */
export function settleThinking(session: ThinkingSession, globalDefault: string | undefined): void {
  const levels = session.agent.getAvailableThinkingLevels()
  const next = thinkingToSettle(
    session.agent.configuredThinkingLevel(),
    levels,
    session.agent.model?.thinking?.defaultLevel,
    globalDefault,
  )

  if (next !== undefined) {
    session.agent.setThinkingLevel(next as never)
  }
}
