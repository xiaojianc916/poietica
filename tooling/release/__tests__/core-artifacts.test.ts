import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 与 apps/core/scripts/artifacts.ts 的必需清单保持一致：上游 18.12.6 只发布 baseline。
const REQUIRED = ['poietica-core.exe', 'pi_natives.win32-x64-baseline.node']
const scripts = path.resolve(import.meta.dir, '../../../apps/core/scripts')

async function verify(
  files: readonly string[],
  unhashed: readonly string[] = [],
): Promise<{ code: number; output: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'poietica-dist-contract-'))
  try {
    const fixtureScripts = path.join(root, 'apps/core/scripts')
    const dist = path.join(root, 'apps/core/dist')
    await mkdir(fixtureScripts, { recursive: true })
    await mkdir(dist, { recursive: true })
    for (const name of ['verify-dist.ts', 'artifacts.ts']) {
      const source = path.join(scripts, name)
      if (existsSync(source)) await copyFile(source, path.join(fixtureScripts, name))
    }
    const sha256: Record<string, string> = {}
    for (const name of files) {
      await writeFile(path.join(dist, name), name)
      if (!unhashed.includes(name)) sha256[name] = Bun.SHA256.hash(name, 'hex')
    }
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ workspaces: { catalog: { '@oh-my-pi/pi-coding-agent': 'test' } } }),
    )
    await writeFile(
      path.join(dist, 'core-manifest.json'),
      JSON.stringify({
        coreVersion: 'test',
        protocolVersion: 1,
        ompVersion: 'test',
        probe: false,
        sha256,
      }),
    )
    const child = Bun.spawn([process.execPath, path.join(fixtureScripts, 'verify-dist.ts')], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, output: output + errors }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('Core 发布产物的完整性契约', () => {
  test('只有 exe、自洽的 manifest：仍必须拒绝缺少 natives 的产物', async () => {
    const result = await verify(['poietica-core.exe'])
    expect(result.code).toBe(1)
    expect(result.output).toContain('pi_natives.win32-x64-baseline.node')
  })

  test('全部必需文件在场且哈希一致：通过完整性校验（不等于运行冒烟）', async () => {
    expect((await verify(REQUIRED)).code).toBe(0)
  })

  test('上游带 modern 时一并纳入哈希校验', async () => {
    expect((await verify([...REQUIRED, 'pi_natives.win32-x64-modern.node'])).code).toBe(0)
  })

  test('盘上有 modern 但 manifest 漏记哈希：必须拒绝', async () => {
    const result = await verify([...REQUIRED, 'pi_natives.win32-x64-modern.node'], ['pi_natives.win32-x64-modern.node'])
    expect(result.code).toBe(1)
    expect(result.output).toContain('pi_natives.win32-x64-modern.node')
  })
})
