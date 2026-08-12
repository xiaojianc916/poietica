import { throughIpc } from './error'
import type {
  PluginFetch,
  SkillCommitRequest,
  SkillPayload,
  SkillStaged,
} from './generated/ipc-bindings'
import { commands } from './generated/ipc-bindings'

export type { SkillCommitRequest, SkillPayload, SkillStaged } from './generated/ipc-bindings'

export function listSkills(): Promise<SkillPayload[]> {
  return throughIpc(() => commands.skillsList())
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
