import { spawnSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export type Manifest = {
  name?: string
  scripts?: Record<string, string>
  exports?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

export type Workspace = {
  readonly name: string
  readonly directory: string
  readonly manifest: Manifest
}

export type Crate = { readonly name: string; readonly dependencies: readonly string[] }

type RootManifest = {
  workspaces?: { packages?: string[] } | string[]
}

function workspacePatterns(manifest: RootManifest): string[] {
  const configured = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : manifest.workspaces?.packages

  if (configured === undefined || configured.length === 0) {
    throw new Error('根 package.json 没有声明 workspaces')
  }

  return configured
}

async function expandWorkspace(root: string, pattern: string): Promise<string[]> {
  const normalized = pattern.replaceAll('\\', '/').replace(/\/$/, '')
  if (!normalized.includes('*')) {
    return [normalized]
  }
  if (!normalized.endsWith('/*') || normalized.slice(0, -2).includes('*')) {
    throw new Error(`不支持的 workspace glob：${pattern}`)
  }

  const parent = normalized.slice(0, -2)
  const entries = await readdir(path.join(root, parent), { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory()).map((entry) => `${parent}/${entry.name}`)
}

export async function readWorkspaces(root: string): Promise<Workspace[]> {
  const rootManifest = JSON.parse(
    await readFile(path.join(root, 'package.json'), 'utf8'),
  ) as RootManifest
  const expanded = await Promise.all(
    workspacePatterns(rootManifest).map((pattern) => expandWorkspace(root, pattern)),
  )
  const directories = [...new Set(expanded.flat())].sort()
  const workspaces: Workspace[] = []

  for (const directory of directories) {
    const manifestPath = path.join(root, directory, 'package.json')
    const text = await readFile(manifestPath, 'utf8').catch(() => null)
    if (text === null) {
      throw new Error(`workspace 没有 package.json：${directory}`)
    }

    const manifest = JSON.parse(text) as Manifest
    if (manifest.name === undefined) {
      throw new Error(`工作区缺少 name：${directory}`)
    }
    workspaces.push({ name: manifest.name, directory, manifest })
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
      .filter((dependency) => dependency.kind !== 'dev')
      .map((dependency) => dependency.name),
  }))
}
