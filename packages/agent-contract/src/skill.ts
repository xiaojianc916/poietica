/** Kimi 当前会话公布的一条 Skill。 */
export interface AgentSkill {
  readonly name: string
  readonly description: string
  readonly source: string
}

/** Skill 目录按会话寻址；执行随同一次 prompt 的 skills 字段提交。 */
export interface AgentSkillPort {
  readonly list: (sessionId: string) => Promise<readonly AgentSkill[]>
}
