/*
 * 技能这一路。
 *
 * 目录问 kap，激活也问 kap：内置、插件、用户与项目四层的合并与覆盖规则归上游，
 * 在这一侧复算就是造第二份事实。
 */

/** kap 报的一条技能（protocol/skill.ts 的 skillDescriptorSchema）。 */
export interface AgentSkill {
  readonly name: string
  /** agent 给的那句说明。没给就是空串。 */
  readonly description: string
  /** project / user / extra / builtin，由 kap 判定。 */
  readonly source: string
}

/** 读目录，或激活一条。可否激活由 kap 拒绝，这一侧不预判。 */
export interface AgentSkillPort {
  readonly list: () => Promise<readonly AgentSkill[]>
  readonly activate: (name: string, args: string) => Promise<void>
}
