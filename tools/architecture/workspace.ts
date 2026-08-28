import { spawnSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export type Manifest = {
  name?: string
  scripts?: Record<string, string>
  exports?: Record<string, string>
}

export type Workspace = {
  readonly name: string
  readonly directory: string
  readonly manifest: Manifest
}

export type Crate = { readonly name: string; readonly dependencies: readonly string[] }

const PARENTS = ['apps', 'packages']
const SINGLES = ['tests', 'tools']

export async function readWorkspaces(root: string): Promise<Workspace[]> {
  const directories = [...SINGLES]

  for (const parent of PARENTS) {
    const entries = await readdir(path.join(root, parent), { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isDirectory()) {
        directories.push(`${parent}/${entry.name}`)
      }
    }
  }

  const workspaces: Workspace[] = []

  for (const directory of directories.sort()) {
    const text = await readFile(path.join(root, directory, 'package.json'), 'utf8').catch(
      () => null,
    )

    if (text === null) {
      continue
    }

    const manifest = JSON.parse(text) as Manifest
    const name = manifest.name

    if (name === undefined) {
      throw new Error(`工作区缺少 name：${directory}`)
    }

    workspaces.push({ name, directory, manifest })
  }

  return workspaces
}

/** crate 图由 cargo 自己给：不解析 Cargo.toml，也不猜路径依赖。 */
export function readCrates(root: string): Crate[] {
  const result = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

  if (result.status !== 0) {
    throw new Error(`cargo metadata 失败：${String(result.stderr ?? '').trim()}`)
  }

  const parsed = JSON.parse(result.stdout) as {
    packages: Array<{
      name: string
      dependencies: Array<{ name: string; kind?: string | null }>
    }>
  }

  return parsed.packages.map((entry) => ({
    name: entry.name,
    dependencies: entry.dependencies
      .filter((dependency) => dependency.kind === null || dependency.kind === undefined)
      .map((dependency) => dependency.name),
  }))
}
