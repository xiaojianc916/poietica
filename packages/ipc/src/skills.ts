import type { PluginFetch, SkillCommitRequest, SkillRecord, SkillStaged } from '@poietica/contract'
import { commands } from '@poietica/contract'
import { throughIpc } from './error'

export type { SkillCommitRequest, SkillRecord, SkillStaged } from '@poietica/contract'

/** 本机 skills/ 里装着哪些：一行一个目录，带启用状态与 SKILL.md 原文。 */
export function listSkills(): Promise<SkillRecord[]> {
  return throughIpc(async () => commands.skillsList())
}

export function stageSkill(fetch: PluginFetch): Promise<SkillStaged> {
  return throughIpc(() => commands.skillsStage(fetch))
}

export function commitSkill(request: SkillCommitRequest): Promise<void> {
  return throughIpc(async () => {
    await commands.skillsCommit(request)
  })
}

export function discardStagedSkill(stagingId: string): Promise<void> {
  return throughIpc(async () => {
    await commands.skillsDiscard(stagingId)
  })
}

export function removeSkill(name: string): Promise<void> {
  return throughIpc(async () => {
    await commands.skillsRemove(name)
  })
}

/** 停用与启用：原生侧在 SKILL.md 与 SKILL.md.disabled 之间改名。 */
export function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  return throughIpc(async () => {
    await commands.skillsSetEnabled(name, enabled)
  })
}
