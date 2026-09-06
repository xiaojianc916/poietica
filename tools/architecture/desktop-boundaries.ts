import path from 'node:path'
import type { Violation } from './policies.ts'

const PREFIX = 'apps/desktop/src/'
const EDGES: Readonly<Record<string, readonly string[]>> = {
  entry: [
    'workbench',
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
  workbench: ['shell', 'assistant', 'browser', 'window', 'workspace', 'notice', 'update'],
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
const WORKBENCH_EDGES: Readonly<Record<string, readonly string[]>> = {
  'runtime-contract.ts': [],
  'connections.ts': [],
  'app-shell.tsx': ['runtime-contract.ts', 'workspace.tsx'],
  'workspace.tsx': ['runtime-contract.ts', 'surfaces.tsx', 'auxiliary-dock.tsx'],
  'auxiliary-dock.tsx': ['runtime-contract.ts', 'review-pane.tsx', 'terminal-pane.tsx'],
  'review-pane.tsx': [],
  'terminal-pane.tsx': [],
  'surfaces.tsx': ['runtime-contract.ts'],
}
export const DESKTOP_HEADLESS = [
  'shell/layout/layout-store.ts',
  'assistant/conversation-entry.ts',
  'assistant/agent-runtime.ts',
  'browser/browser-pick.ts',
  'window/maximized-state.ts',
  'workbench/connections.ts',
].map((file) => PREFIX.concat(file))

export function desktopBoundaries(
  root: string,
  file: string,
  target: string,
  typeOnly = false,
): Violation[] {
  const source = path.relative(root, file).split(path.sep).join('/')
  const destination = path.relative(root, target).split(path.sep).join('/')
  const injected = workbenchHostInjection(source, destination, typeOnly)
  if (injected !== undefined) {
    return injected
  }
  return desktopDomainDirection(source, destination, target)
}

type DesktopViolation = (detail: string) => Violation[]

function workbenchHostInjection(
  source: string,
  destination: string,
  typeOnly: boolean,
): Violation[] | undefined {
  if (typeOnly || !source.startsWith(`${PREFIX}workbench/`)) {
    return undefined
  }
  if (!source.endsWith('.tsx') || !destination.startsWith('packages/native-bridge/')) {
    return undefined
  }
  return [
    {
      policy: 'workbench-host-injection',
      where: source,
      detail: 'Workbench views receive host operations through injected ports.',
    },
  ]
}

function desktopDomainDirection(source: string, destination: string, target: string): Violation[] {
  if (!inDesktopScope(source, destination, target)) {
    return []
  }
  const from = source.slice(PREFIX.length).split('/')
  const to = destination.slice(PREFIX.length).split('/')
  const violation: DesktopViolation = (detail) => [
    { policy: 'desktop-domain-direction', where: source, detail },
  ]
  const workbench = workbenchFileDirection(source, destination, from, to, violation)
  if (workbench !== undefined) {
    return workbench
  }
  const domain = domainEdgeDirection(from, to, destination, violation)
  if (domain !== undefined) {
    return domain
  }
  return shellFileDirection(target, from, to, violation)
}

function inDesktopScope(source: string, destination: string, target: string): boolean {
  return (
    source.startsWith(PREFIX) && destination.startsWith(PREFIX) && /\.[cm]?[jt]sx?$/.test(target)
  )
}

function workbenchFileDirection(
  source: string,
  destination: string,
  from: string[],
  to: string[],
  violation: DesktopViolation,
): Violation[] | undefined {
  if (from[0] !== 'workbench') {
    return undefined
  }
  const member = from.slice(1).join('/')
  if (!Object.hasOwn(WORKBENCH_EDGES, member)) {
    return violation('Assign each workbench file a responsibility and dependency direction.')
  }
  if (to[0] !== 'workbench') {
    return undefined
  }
  const dependency = to.slice(1).join('/')
  if (source === destination || WORKBENCH_EDGES[member]?.includes(dependency)) {
    return []
  }
  return violation([member, 'must not depend on workbench capability', dependency].join(' '))
}

function domainEdgeDirection(
  from: string[],
  to: string[],
  destination: string,
  violation: DesktopViolation,
): Violation[] | undefined {
  const origin = from[0] ?? ''
  const owner = to[0] ?? ''
  if (origin === owner) {
    return undefined
  }
  if (EDGES[origin]?.includes(owner)) {
    return []
  }
  return violation([origin, 'must not depend on', owner, 'through', destination].join(' '))
}

function shellFileDirection(
  target: string,
  from: string[],
  to: string[],
  violation: DesktopViolation,
): Violation[] {
  if (from[0] !== 'shell' || from[1] === 'index.ts') {
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
