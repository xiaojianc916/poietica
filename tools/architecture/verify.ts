#!/usr/bin/env bun
/** 架构闸门：图与元数据说话。 */

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import * as charter from './charters.ts'
import { readImports } from './imports.ts'
import type { Violation } from './policies.ts'
import * as policy from './policies.ts'
import { readCrates, readWorkspaces } from './workspace.ts'

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const SKIP = new Set(['.turbo', 'coverage', 'dist', 'gen', 'node_modules', 'target'])

async function directories(root: string, from: readonly string[]): Promise<string[]> {
  const found: string[] = []
  const pending = [...from]

  while (pending.length > 0) {
    const current = pending.pop()

    if (current === undefined) {
      break
    }

    const entries = await readdir(path.join(root, current), { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP.has(entry.name)) {
        continue
      }

      const child = `${current}/${entry.name}`
      found.push(child)
      pending.push(child)
    }
  }

  return found.sort()
}

const workspaces = await readWorkspaces(ROOT)
const crates = readCrates(ROOT)
const imports = await readImports(ROOT, ['apps', 'packages'])
const everyImport = await readImports(ROOT, ['apps', 'packages', 'tests', 'tools'])
const tree = await directories(ROOT, ['apps', 'packages'])
const rootManifest = await readFile(path.join(ROOT, 'package.json'), 'utf8')
const exportBindings = await readFile(
  path.join(ROOT, 'apps/desktop/src-tauri/src/ipc/export_bindings.rs'),
  'utf8',
)
const codeSource = await readFile(path.join(ROOT, 'crates/problem/src/code.rs'), 'utf8')

const scripted = [
  {
    where: 'package.json',
    scripts: (JSON.parse(rootManifest) as { scripts?: Record<string, string> }).scripts ?? {},
  },
  ...workspaces.map((workspace) => ({
    where: `${workspace.directory}/package.json`,
    scripts: workspace.manifest.scripts ?? {},
  })),
]

const violations: Violation[] = [
  ...policy.everythingIsRegistered(workspaces, crates),
  ...policy.layerDirection(imports, workspaces),
  ...(await policy.declaredDependenciesOnly(ROOT, everyImport, workspaces)),
  ...policy.noCycles(imports, workspaces),
  ...policy.publicEntryOnly(imports, workspaces),
  ...policy.relativeImportsStayHome(imports, workspaces),
  ...policy.nativeAccessIsDeclared(imports, workspaces),
  ...policy.frameworkFreeVocabulary(imports, workspaces),
  ...policy.crateDependencyDirection(crates),
  ...policy.cratesStayHostAgnostic(crates),
  ...policy.capabilityScopedDirectories(tree),
  ...(await policy.singleGeneratedContract(
    ROOT,
    exportBindings,
    tree.filter((directory) => directory.endsWith('/src/generated')),
  )),
  ...(await policy.manifestScriptsResolve(ROOT, scripted)),
  ...(await policy.invokedScriptsResolve(ROOT)),
  ...(await policy.problemCopyIsComplete(ROOT, codeSource)),
  ...(await charter.preferencesHaveOneOwner(ROOT)),
  ...(await charter.agentEventsAreDeclaredOnce(ROOT)),
  ...(await charter.capabilitiesAreWiredAtTheRoot(ROOT)),
  ...(await charter.designSystemOwnsItsTokens(ROOT)),
  ...(await charter.windowSurfaceIsNamedOnce(ROOT)),
  ...(await charter.noWildcardReExports(ROOT)),
  ...(await charter.documentedScriptsExist(ROOT)),
  ...(await charter.documentedPackagesExist(ROOT, workspaces)),
  ...charter.workspaceNamesFollowTheirDirectory(workspaces),
  ...(await charter.noTaskScopedGuards(ROOT)),
  ...charter.domainCratesAreReachable(crates),
]

if (violations.length === 0) {
  console.log(
    `架构闸门通过：${String(workspaces.length)} 个工作区、${String(crates.length)} 个 crate。`,
  )
  process.exit(0)
}

for (const violation of violations) {
  console.error(`[${violation.policy}] ${violation.where} — ${violation.detail}`)
}

console.error(`架构闸门未通过：${String(violations.length)} 条。`)
process.exit(1)
