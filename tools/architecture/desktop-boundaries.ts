import path from 'node:path'
import type { Violation } from './policies.ts'

const PREFIX = 'apps/desktop/src/'
const EDGES: Readonly<Record<string, readonly string[]>> = {
  entry: [
    'shell',
    'assistant',
    'automation',
    'browser',
    'window',
    'workspace',
    'notice',
    'update',
    'styles',
  ],
  shell: ['window'],
  assistant: ['browser', 'workspace', 'notice'],
  automation: ['notice'],
  browser: ['notice'],
  window: ['notice'],
  workspace: [],
  notice: [],
  update: ['notice'],
  styles: [],
}
const SHELL_EDGES: Readonly<Record<string, readonly string[]>> = {
  chrome: ['layout'],
  layout: [],
  tabs: ['surfaces'],
  sidebar: ['surfaces'],
  surfaces: [],
  commands: [],
}
export const DESKTOP_HEADLESS = [
  'shell/layout/layout-store.ts',
  'assistant/conversation-entry.ts',
  'browser/browser-pick.ts',
  'window/maximized-state.ts',
  'entry/workbench-connections.ts',
].map((file) => PREFIX.concat(file))

export function desktopBoundaries(root: string, file: string, target: string): Violation[] {
  const source = path.relative(root, file).split(path.sep).join('/')
  const destination = path.relative(root, target).split(path.sep).join('/')
  if (
    !source.startsWith(PREFIX) ||
    !destination.startsWith(PREFIX) ||
    !/\.[cm]?[jt]sx?$/.test(target)
  ) {
    return []
  }
  const from = source.slice(PREFIX.length).split('/')
  const to = destination.slice(PREFIX.length).split('/')
  const origin = from[0] ?? ''
  const owner = to[0] ?? ''
  const violation = (detail: string): Violation[] => [
    {
      policy: 'desktop-domain-direction',
      where: source,
      detail,
    },
  ]
  if (origin !== owner) {
    if (EDGES[origin]?.includes(owner)) {
      return []
    }
    return violation([origin, 'must not depend on', owner, 'through', destination].join(' '))
  }
  if (origin !== 'shell' || from[1] === 'index.ts') {
    return []
  }
  if (to[1] === 'index.ts') {
    return violation('Shell internals must not import their own public facade.')
  }
  const family = from[1] ?? ''
  const dependency = to[1] ?? ''
  if (family === dependency || SHELL_EDGES[family]?.includes(dependency)) {
    return []
  }
  if (target.endsWith('.css') && to.length === 2) {
    return []
  }
  return violation([family, 'must not depend on shell capability', dependency].join(' '))
}
