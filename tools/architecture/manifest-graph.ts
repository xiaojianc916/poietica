import { ringOf, TYPESCRIPT_RINGS, UNLAYERED_DIRECTORIES } from './layering.ts'
import type { Violation } from './policies.ts'
import type { Manifest, Workspace } from './workspace.ts'

const SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const

function dependenciesOf(manifest: Manifest): Set<string> {
  return new Set(SECTIONS.flatMap((section) => Object.keys(manifest[section] ?? {})))
}

interface Graph {
  readonly byName: Map<string, Workspace>
  readonly edges: Map<string, Set<string>>
}

/** 逐条依赖校验：目标存在、不是自依赖、环方向正确。边只在这里落账。 */
function boundaryViolations(
  workspace: Workspace,
  dependencies: readonly string[],
  graph: Graph,
): Violation[] {
  const violations: Violation[] = []

  for (const target of dependencies) {
    if (!target.startsWith('@poietica/')) {
      continue
    }
    if (graph.byName.get(target) === undefined) {
      violations.push({
        policy: 'manifest-boundaries',
        where: `${workspace.directory}/package.json`,
        detail: `声明了不存在的工作区 ${target}`,
      })
      continue
    }
    if (target === workspace.name) {
      violations.push({
        policy: 'manifest-boundaries',
        where: `${workspace.directory}/package.json`,
        detail: `${workspace.name} 声明了自身依赖`,
      })
      continue
    }
    graph.edges.get(workspace.name)?.add(target)

    if (UNLAYERED_DIRECTORIES.includes(workspace.directory)) {
      continue
    }
    const from = ringOf(TYPESCRIPT_RINGS, workspace.name)
    const to = ringOf(TYPESCRIPT_RINGS, target)
    if (from < 0 || to < 0) {
      continue
    }
    if (to === from || to > from) {
      violations.push({
        policy: 'manifest-boundaries',
        where: `${workspace.directory}/package.json`,
        detail:
          to === from
            ? `${workspace.name} 与 ${target} 同环，同环之间不许有边`
            : `${workspace.name} 指向了更高的环 ${target}`,
      })
    }
  }
  return violations
}

/** package.json is the module graph; source imports must remain a subset of it. */
export function manifestBoundaries(workspaces: readonly Workspace[]): Violation[] {
  const graph: Graph = {
    byName: new Map(workspaces.map((workspace) => [workspace.name, workspace])),
    edges: new Map(workspaces.map((workspace) => [workspace.name, new Set<string>()])),
  }
  const violations = workspaces.flatMap((workspace) =>
    boundaryViolations(workspace, [...dependenciesOf(workspace.manifest)], graph),
  )

  const edges = graph.edges
  const state = new Map<string, 'open' | 'closed'>()
  const trail: string[] = []
  const reported = new Set<string>()
  const visit = (node: string): void => {
    const seen = state.get(node)
    if (seen === 'closed') {
      return
    }
    if (seen === 'open') {
      const cycle = [...trail.slice(trail.indexOf(node)), node].join(' -> ')
      if (!reported.has(cycle)) {
        reported.add(cycle)
        violations.push({
          policy: 'manifest-no-cycles',
          where: 'workspace manifest graph',
          detail: cycle,
        })
      }
      return
    }
    state.set(node, 'open')
    trail.push(node)
    for (const next of edges.get(node) ?? []) {
      visit(next)
    }
    trail.pop()
    state.set(node, 'closed')
  }

  for (const workspace of workspaces) {
    visit(workspace.name)
  }
  return violations
}
