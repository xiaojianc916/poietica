/*
 * 一条会话报来的斜杠命令表。整表替换：kap 的 commands 事件恒带整表。
 *
 * 技能不在这张表里 —— 它有自己的目录与激活动作（AgentSkillPort）。
 */

/** 表里的一条。 */
export interface SessionCommand {
  /** agent 认的那个名字，也就是斜杠后面敲的东西。 */
  readonly name: string
  /** 屏幕上显示的调用式。 */
  readonly label: string
  /** agent 给的那句说明。没给就是空串。 */
  readonly description: string
}

/** 一次上报：哪条会话，整张表。 */
export interface SessionCommandReport {
  readonly sessionId: string
  readonly commands: readonly SessionCommand[]
}

/** 命令表这一路：只有听。命令不是可调项，敲它才是使用它。 */
export interface SessionCommandsPort {
  readonly subscribe: (handler: (report: SessionCommandReport) => void) => () => void
}
