#!/usr/bin/env bun
/** 架构闸门：图与元数据说话。 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import * as charter from './charters.ts'
import { fileGraph } from './file-graph.ts'
import { readImports, walkDirectories } from './imports.ts'
import { manifestBoundaries } from './manifest-graph.ts'
import type { Violation } from './policies.ts'
import * as policy from './policies.ts'
import { readCrates, readWorkspaces } from './workspace.ts'

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))

const workspaces = await readWorkspaces(ROOT)
const crates = readCrates(ROOT)
const imports = await readImports(ROOT, ['apps', 'packages'])
/* 后两组是前一组之外的部分：再整读一遍就是把 432 个生产文件重解析一次。 */
const everyImport = [...imports, ...(await readImports(ROOT, ['tests', 'tools']))]
const tree = await walkDirectories(ROOT, ['apps', 'packages'])
const rootManifest = await readFile(path.join(ROOT, 'package.json'), 'utf8')
const exportBindings = await readFile(
  path.join(ROOT, 'apps/desktop/src-tauri/src/ipc/export_bindings.rs'),
  'utf8',
)
const codeSource = await readFile(path.join(ROOT, 'crates/problem/src/code.rs'), 'utf8')
const categorySource = await readFile(path.join(ROOT, 'crates/problem/src/category.rs'), 'utf8')
const retrySource = await readFile(path.join(ROOT, 'crates/problem/src/retry.rs'), 'utf8')

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
  ...manifestBoundaries(workspaces),
  ...policy.layerDirection(imports, workspaces),
  ...policy.declaredDependenciesOnly(everyImport, workspaces),
  ...policy.noCycles(imports, workspaces),
  ...(await fileGraph(ROOT, workspaces)),
  ...policy.publicEntryOnly(imports, workspaces),
  ...policy.relativeImportsStayHome(imports, workspaces),
  ...policy.nativeAccessIsDeclared(imports, workspaces),
  ...policy.transportContractIsAdapterPrivate(imports, workspaces),
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
  ...(await policy.problemVocabularyMirrorsSource(ROOT, codeSource, categorySource, retrySource)),
  ...(await charter.preferencesHaveOneOwner(ROOT)),
  ...(await charter.nativeEventsUseGeneratedSurface(ROOT)),
  ...(await charter.capabilitiesAreWiredAtTheRoot(ROOT)),
  ...(await charter.designSystemOwnsItsTokens(ROOT)),
  ...(await charter.windowSurfaceIsNamedOnce(ROOT)),
  ...(await charter.noWildcardReExports(ROOT)),
  ...(await charter.contractShimsStayGenerated(ROOT)),
  ...(await charter.documentedScriptsExist(ROOT)),
  ...(await charter.documentedPackagesExist(ROOT, workspaces)),
  ...charter.workspaceNamesFollowTheirDirectory(workspaces),
  ...(await charter.noTaskScopedGuards(ROOT)),
  ...(await charter.processStateIsComposedAtRoot(ROOT)),
  ...(await charter.runFrameWireStaysTyped(ROOT)),
  ...(await charter.reviewWatcherHasLease(ROOT)),
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
