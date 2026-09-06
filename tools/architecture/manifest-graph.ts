import { typeScriptDependencyAllowed, UNLAYERED_DIRECTORIES } from './layering.ts'
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
    const where = `${workspace.directory}/package.json`
    if (!graph.byName.has(target)) {
      violations.push({
        policy: 'manifest-boundaries',
        where,
        detail: `Unknown workspace: ${target}`,
      })
      continue
    }
    if (target === workspace.name) {
      violations.push({
        policy: 'manifest-boundaries',
        where,
        detail: `Self dependency: ${target}`,
      })
      continue
    }
    graph.edges.get(workspace.name)?.add(target)
    if (
      !UNLAYERED_DIRECTORIES.includes(workspace.directory) &&
      !typeScriptDependencyAllowed(workspace.name, target)
    ) {
      violations.push({
        policy: 'manifest-boundaries',
        where,
        detail: `${workspace.name} cannot depend on ${target}`,
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
