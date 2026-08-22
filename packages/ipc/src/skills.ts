import { throughIpc } from './error'
import type { PluginFetch, SkillCommitRequest, SkillStaged } from './generated/ipc-bindings'
import { commands } from './generated/ipc-bindings'

export type { SkillCommitRequest, SkillStaged } from './generated/ipc-bindings'

/** 本机 skills/ 里装着哪些：目录名列表。名册那另一半在 agent_toolkit。 */
export function listSkills(): Promise<string[]> {
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
