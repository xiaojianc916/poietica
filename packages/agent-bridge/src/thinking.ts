/*
 * 思考档位：候选是**这条模型自己的梯子**，不是一张四档的通用表。
 *
 * 梯子的正本是模型元数据，两层产地都是**数据**：
 *
 * - 随包烘好的目录（pi-catalog 的 `models.json`，由构建期 `gen:models` 从
 *   `compat/rules/*.kdl` 那些评审过的规则与各家目录生成，运行时由 `compat/resolve.ts`
 *   物化）。实测 5510 行里有 **18 种不同的梯子**：`["high"]`、`["low","high","max"]`、
 *   `["minimal","low","medium","high","xhigh"]` 都真实存在。
 * - 用户自己的 `models.yml`（`providers.<id>.models[].thinking.efforts`），实测它赢过
 *   内置那一行。
 *
 * 所以谁在代码里写死一张档位表，谁就在报这条模型没有的档位 —— 人选中了它，请求发出去
 * 被厂商拒、或被上游悄悄夹回另一档，而屏幕上写着人刚选的那个（ADR 0017）。
 *
 * 产品**不出**上游那两个额外档位，各有各的理由：
 *
 * - `off`（不思考）：这个产品的用户要的就是深度思考，关掉它没有意义。
 * - `auto`（由 agent 每轮自己判）：它是**隐形成本**。选中它之后每一条用户消息都会先多
 *   花一次模型调用去分类难度（agent-session.ts 的 `applyAutoThinkingLevel`，走 judge
 *   角色链；我们不配便宜角色，它落到 `modelRoles.default`，也就是用户当前这条模型、
 *   这个密钥）。一次不多，但它是每轮都有的、用户没点的那一次。
 *
 * 于是候选只有梯子，而盘上读回来的会话可能是任何旧值（旧版本留下的 off/auto，或换过
 * 模型之后停在另一条模型的档位上）。收敛的判据只有一条：**报出去的值必须是自己提供的
 * 那一档**，否则胶囊与轨道说的不是一件事。
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
 * 已经落在梯子上就不动（不重发、不覆盖用户的选择）。要动的时候落点全是上游自己的
 * 默认：模型声明的 `defaultLevel` 优先，其次全局的 `defaultThinkingLevel`（这条也是
 * 上游 schema 的默认，不是我们编的）；两者都不是这条模型认的档位时取它能给的最深
 * 一档 —— 「深度思考默认开启」的最小兑现。夹取归 setThinkingLevel 自己，这里不写
 * 第二份梯子。
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
