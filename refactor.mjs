#!/usr/bin/env node
import { migrateCommandSurface } from './scripts/refactor/command-surface.mjs'
import { migrateComposerSurface } from './scripts/refactor/composer-surface.mjs'
import { migrateEntrySkills } from './scripts/refactor/entry-skills.mjs'
import { Migration } from './scripts/refactor/lib.mjs'
import { migrateSessionCreation } from './scripts/refactor/session-creation.mjs'
import { migrateSessionProfile } from './scripts/refactor/session-profile.mjs'
import { migrateSessionProjection } from './scripts/refactor/session-projection.mjs'
import { migrateSkills } from './scripts/refactor/skill.mjs'
import { migrateTypedSubmission } from './scripts/refactor/typed-submission.mjs'

const migration = new Migration()

function targetReady() {
  const required = [
    ['crates/agent-runtime/src/config.rs', 'ConfigPurpose::Permission'],
    ['crates/agent-runtime/src/commands.rs', 'PreparePrompt { session_id: String'],
    ['crates/agent-runtime/src/driver.rs', 'async fn session_profile'],
    ['packages/agent-contract/src/session.ts', "AgentPromptIntent = 'normal' | 'goal' | 'swarm'"],
    ['packages/agent-contract/src/skill.ts', 'disableModelInvocation'],
    ['packages/agent/src/session/agent-capability-store.ts', 'skillsFailure'],
    ['packages/agent/src/timeline/timeline-contract.ts', 'export interface GoalProjection'],
    ['packages/agent-ui/src/composer/composer-actions.tsx', 'const PRODUCT_COMMANDS = ['],
    ['packages/agent/src/session/prompt-intent.test.ts', "describe('parsePromptIntent'"],
    ['packages/agent/src/timeline/session-projection.test.ts', "describe('official session projections'"],
  ]
  return required.every(([path, marker]) => migration.exists(path) && migration.read(path).includes(marker))
    && !migration.exists('packages/agent-contract/src/commands.ts')
    && !migration.exists('packages/agent-ui/src/composer/posture-memory.ts')
    && !migration.read('packages/agent/src/session/session-controls-store.ts').includes('SessionCommandsPort')
}

try {
  const manifest = migration.read('package.json')
  if (!manifest.includes('"name": "poietica"')) migration.fail('run this script from the poietica repository root')
  if (targetReady()) {
    console.log('[refactor] target architecture already present')
  } else {
    migrateSessionProfile(migration)
    migrateSessionCreation(migration)
    migrateCommandSurface(migration)
    migrateSkills(migration)
    migrateComposerSurface(migration)
    migrateEntrySkills(migration)
    migrateTypedSubmission(migration)
    migrateSessionProjection(migration)
    migration.assertAbsent('SessionCommandsPort', ['packages/agent-contract/src/index.ts', 'packages/ipc/src/agent.ts', 'apps/desktop/src/assistant/agent-runtime.ts', 'packages/agent/src/session/session-controls-store.ts'])
    migration.assertAbsent("name: 'write-goal'", ['packages/agent-ui/src/composer/composer-actions.tsx'])
    migration.assertAbsent("name: 'tasks'", ['packages/agent-ui/src/composer/composer-actions.tsx'])
    migration.commit()
  }
  migration.run('pnpm', ['ipc:generate'])
  migration.run('pnpm', ['kap:spec:check'])
  migration.run('pnpm', ['check'])
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
