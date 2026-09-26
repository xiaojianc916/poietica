import path from 'node:path'
import type { Violation } from './policies.ts'

/*
 * 每个目录声明自己是什么（AGENTS.md §4「目录名声明能力」）：没有声明就不许被依赖，
 * 那样「新加一个目录」必须在这里想清楚它归谁管，而不是悄悄接上去。
 *
 * `entry` 是包的公开边，`ui` 是界面；两者都要能读到各域，方向是单向的。
 */
const groups: Readonly<Record<string, readonly string[]>> = {
  entry: [
    'preferences',
    'agent-runtime',
    'model-catalog',
    'custom-agents',
    'keymap',
    'agent-settings',
  ],
  preferences: ['preferences'],
  'agent-runtime': ['agent-runtime'],
  'model-catalog': ['model-catalog'],
  'custom-agents': ['custom-agents'],
  keymap: ['keymap'],
  /* agent 自己那份设置：读它的 schema，改它自己的持久层（ADR 0054 决定四）。只依赖本域。 */
  'agent-settings': ['agent-settings'],
  ui: [
    'ui',
    'entry',
    'preferences',
    'agent-runtime',
    'model-catalog',
    'custom-agents',
    'keymap',
    'agent-settings',
  ],
}
const ranks: Readonly<Record<string, number>> = {
  'preferences/store.ts': 0,
  'preferences/session.ts': 1,
  'agent-runtime/model.ts': 0,
  'agent-runtime/repository.ts': 1,
  'agent-runtime/settings.ts': 2,
  'model-catalog/model.ts': 0,
  'model-catalog/store.ts': 1,
}
function local(root: string, file: string): string | undefined {
  const relative = path.relative(root, file).split(path.sep).join('/')
  const prefix = 'packages/settings/src/'
  return relative.startsWith(prefix) ? relative.slice(prefix.length) : undefined
}
function group(file: string): string {
  return file === 'index.ts' ? 'entry' : (file.split('/')[0] ?? '')
}
export function settingsCore(root: string, file: string): boolean {
  const relative = local(root, file)
  return relative !== undefined && !relative.startsWith('ui/')
}
export function settingsBoundaries(root: string, file: string, target: string): Violation[] {
  const from = local(root, file)
  if (from === undefined) {
    return []
  }
  const to = local(root, target)
  const owner = group(from)
  const allowed = groups[owner]
  const reject = (detail: string): Violation[] => {
    return [
      { policy: 'settings-responsibility-direction', where: path.relative(root, file), detail },
    ]
  }
  if (allowed === undefined) {
    return reject(`Settings source has no declared responsibility: ${from}`)
  }
  if (owner !== 'ui' && from.endsWith('.tsx')) {
    return reject('Settings core cannot contain JSX.')
  }
  if (to === undefined || from === to) {
    return []
  }
  const destination = group(to)
  if (!allowed.includes(destination)) {
    return reject(`${from} must not depend on ${to}`)
  }
  const sourceRank = ranks[from]
  const targetRank = ranks[to]
  if (
    owner === destination &&
    sourceRank !== undefined &&
    targetRank !== undefined &&
    sourceRank < targetRank
  ) {
    return reject(`${from} must not know the higher-level ${to}`)
  }
  return []
}
