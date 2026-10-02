/*
 * 内置 Python 内核的端口：三条命令，一个快照形状。
 *
 * 与 readTokenDays / dataDirectory 同一条理由：真身在原生侧（装了没有、装到哪、路径写没
 * 写成），设置包不认识桌面传输层，只画它报回来的那一份。
 *
 * 住在 ui 域：它不是偏好，是这一页要读的一份外部事实，而 ui 是唯一允许认识各域的组。
 */

export type PythonKernelState = 'notInstalled' | 'installing' | 'ready' | 'broken' | 'unsupported'

/** 装机进度。percent 恒为 null：上游不吐字节进度，界面据此画不确定进度条。 */
export interface PythonKernelInstall {
  readonly running: boolean
  readonly step: string | null
  readonly percent: number | null
  readonly error: string | null
}

export interface PythonKernelStatus {
  readonly state: PythonKernelState
  /** 只有就绪才报版本：一棵坏树上挂个版本号是假消息。 */
  readonly version: string | null
  readonly path: string | null
  readonly interpreter: string | null
  readonly install: PythonKernelInstall
}

export interface PythonKernelGateway {
  readonly status: () => Promise<PythonKernelStatus>
  /** 起后台装机。运行中再调是幂等的：交回当前状态，不重入。 */
  readonly install: () => Promise<PythonKernelStatus>
  /** 删受管目录并清空 agent 那格设置。 */
  readonly remove: () => Promise<PythonKernelStatus>
}
