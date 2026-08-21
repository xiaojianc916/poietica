#!/usr/bin/env node
import { migrateCommandSurface } from './scripts/refactor/command-surface.mjs'
import { migrateComposerSurface } from './scripts/refactor/composer-surface.mjs'
import { Migration } from './scripts/refactor/lib.mjs'
import { migrateSessionCreation } from './scripts/refactor/session-creation.mjs'
import { migrateSessionProfile } from './scripts/refactor/session-profile.mjs'
import { migrateSkills } from './scripts/refactor/skill.mjs'
import { migrateTypedSubmission } from './scripts/refactor/typed-submission.mjs'

const migration = new Migration()
try {
  const manifest = migration.read('package.json')
  if (!manifest.includes('"name": "poietica"')) migration.fail('run this script from the poietica repository root')
  migrateSessionProfile(migration)
  migrateSessionCreation(migration)
  migrateComposerSurface(migration)
  migrateCommandSurface(migration)
  migrateSkills(migration)
  migrateTypedSubmission(migration)
  migration.assertAbsent('SessionCommandsPort', ['packages/agent-contract/src/index.ts', 'packages/ipc/src/agent.ts', 'apps/desktop/src/assistant/agent-runtime.ts', 'packages/agent/src/session/session-controls-store.ts'])
  migration.assertAbsent("name: 'write-goal'", ['packages/agent-ui/src/composer/composer-actions.tsx'])
  migration.assertAbsent("name: 'tasks'", ['packages/agent-ui/src/composer/composer-actions.tsx'])
  if (migration.staged.size === 0 && migration.removals.size === 0) console.log('[refactor] target architecture already present')
  else migration.commit()
  migration.run('pnpm', ['ipc:generate'])
  migration.run('pnpm', ['kap:spec:check'])
  migration.run('pnpm', ['check'])
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
