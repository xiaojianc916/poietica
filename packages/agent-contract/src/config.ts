import type { ThreadId } from './address'

/*
 * What the running session lets us change.
 *
 * The agent reports these when a session is created and reports them again
 * whenever one is changed, because changing one may add or remove another.
 * Nothing in this file names a model, a reasoning level or a mode: every
 * value on screen exists because the agent offered it.
 */

/** Where a selector belongs on screen. Mirrors the categories the protocol defines. */
export type SessionConfigPurpose = 'model' | 'thought' | 'permission' | 'mode' | 'other'

/** One value a selector will accept. */
export interface SessionConfigChoice {
  readonly value: string
  readonly label: string
  /** The explanation the agent gave, where it gave one. */
  readonly detail?: string | undefined
}

/** One selector the running session offers. */
export interface SessionConfigControl {
  readonly id: string
  readonly label: string
  readonly detail?: string | undefined
  readonly purpose: SessionConfigPurpose
  /** Present only when enabling this control belongs to the next prompt transaction. */
  readonly appliesOnSubmit?: true
  /** The value in force right now. */
  readonly current: string
  readonly choices: readonly SessionConfigChoice[]
}

/*
 * Where the selectors come from, as far as this feature is concerned.
 *
 * A selector belongs to a session, a session is held by a conversation,
 * and so every call names the conversation it is for. This is not part of
 * the model port and not part of the session port either: it is neither a
 * turn nor a configuration file. Selecting answers with the whole
 * list because the agent decides what the list looks like afterwards, and it
 * may refuse, rename, or withdraw a selector in the same breath.
 *
 * 这里没有"读"。选择器随会话一起交回来：打开一条对话（ThreadPort.open）时
 * agent 在 session/new 的答复里报了整张表，改一项时它又把改完的整张表报回来。
 * 曾经有过一个 list：它按对话去问原生侧，而原生侧只有在"本进程恰好握着这条
 * 对话的会话"时才答得出来，于是同一个选择器时而是空表（整块消失）、时而抛错
 * （那句「会话设置读取失败」）。把读这条路删掉，到达口就只剩下会话本身。
 */

/**
 * 一条会话自己报来的整张表。
 *
 * 它带的地址是 sessionId 而不是 threadId：帧从来只认会话，对话是这一侧的命名。
 * 反查放在保管着「哪条对话握着哪个会话」的那一层，而不是让平台去猜。
 */
export interface SessionConfigReport {
  readonly sessionId: string
  readonly controls: readonly SessionConfigControl[]
}

export interface SessionConfigPort {
  readonly select: (
    threadId: ThreadId,
    configId: string,
    value: string,
    input?: string,
  ) => Promise<readonly SessionConfigControl[]>
  /**
   * agent 自己改了设置时报过来的那一路。
   *
   * 上面那句「这里没有读」仍然成立：这不是一次取数，是 agent 主动说话。到达口
   * 与 open / select 是同一个，所以它不是第三条路径，只是第三个说话的人。
   *
   * 必填。换模型那一次，agent 先答复一张还没收敛的表、再补推一张收敛过的：听不见
   * 后者，屏幕上的档位就停在上一个模型的候选集上。一个「缺了就画错」的能力不该长成
   * 可选的 —— 可选加上调用点的 ?. ，等于让漏实现在编译期合法、在运行期沉默。
   */
  readonly subscribe: (handler: (report: SessionConfigReport) => void) => () => void
}
