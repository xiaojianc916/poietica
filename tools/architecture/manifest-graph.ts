import { cyclesIn } from './imports.ts'
import { typeScriptDependencyAllowed, UNLAYERED_DIRECTORIES } from './layering.ts'
import type { Violation } from './policies.ts'
import type { Manifest, Workspace } from './workspace.ts'

const SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const

/** 一份 manifest 声明了哪些包：四个 section 的键。单一产地，别处只许读这一份。 */
export function dependenciesOf(manifest: Manifest): Set<string> {
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

  for (const cycle of cyclesIn(graph.edges)) {
    violations.push({
      policy: 'manifest-no-cycles',
      where: 'workspace manifest graph',
      detail: cycle.join(' -> '),
    })
  }

  return violations
}
