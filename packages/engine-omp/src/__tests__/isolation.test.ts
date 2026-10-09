import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dataLayout } from '@poietica/runtime-layout'

const fixtures = path.join(import.meta.dir, 'fixtures')
const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function runFixture(
  name: string,
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn([process.execPath, path.join(fixtures, name)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  return { stdout, stderr, code }
}

describe('P2.3 引导与隔离', () => {
  test('T-ISO-1 stdout 只有帧，杂散输出进 stderr', async () => {
    const result = await runFixture('stdout-guard.ts')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('\x1e{"ok":true}\n')
    expect(result.stderr).toContain('from-console-log')
    expect(result.stderr).toContain('from-stdout-write')
  })

  test('T-ISO-2 prepareIsolation 改正 PI_CODING_AGENT_DIR、删除 OMP_PROFILE、切换 cwd', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'poietica-iso-'))
    made.push(root)
    const result = await runFixture('isolation.ts', { POIETICA_TEST_ROOT: root })
    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout) as { corrected: string[]; removed: string[]; cwd: string }
    expect(report.corrected).toContain('PI_CODING_AGENT_DIR')
    expect(report.removed).toContain('OMP_PROFILE')
    expect(report.cwd).toBe(dataLayout(root).coreCwd)
  })

  test('T-ISO-3 目录越界时自检报 ok:false', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'poietica-iso3-'))
    made.push(root)
    const outside = mkdtempSync(path.join(tmpdir(), 'poietica-outside-'))
    made.push(outside)
    const result = await runFixture('self-check.ts', {
      POIETICA_TEST_ROOT: root,
      POIETICA_OUTSIDE: outside,
      PI_CODING_AGENT_DIR: outside,
      PI_CONFIG_DIR: outside,
      XDG_DATA_HOME: outside,
    })
    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout) as { ok: boolean; violations: string[] }
    expect(report.ok).toBe(false)
    expect(report.violations.some((v) => v.startsWith('agent='))).toBe(true)
  })

  test('T-ISO-4 .env 注入的键被清掉', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'poietica-env-'))
    made.push(dir)
    writeFileSync(path.join(dir, '.env'), 'FOO_INJECTED=1\n')
    const result = await runFixture('launch-env.ts', { POIETICA_TEST_ROOT: dir, POIETICA_ENV_DIR: dir })
    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout) as { removed: string[]; stillThere: boolean }
    expect(report.removed).toContain('FOO_INJECTED')
    expect(report.stillThere).toBe(false)
  })

  /*
   * T-ISO-6（04 页 §3.3 第 9 条 / 12 页 §5.2）：外来 provider 的禁用必须在**第一次开会话之前**
   * 就已生效，不能等某条会话建好才落到 omp 的 capability 注册表上。
   *
   * 根因形状：`disableProvider` 写的是「当前绑定的那个 Settings」，没有先
   * `initializeWithSettings` 时它只进一个未绑定的进程级集合，配置一刷就没了 ——
   * 于是 `~/.claude` / `~/.agents` 的配置会在第一条会话开始之前被读进来。
   *
   * `agents` 已按产品负责人 2026-10-09 的裁决放行（refactor-log Q32）：`~/.agents` 是跨工具共享的
   * 用户级目录，legacy 照读；这一条因此改成「`.claude` 仍被挡、`.agents` 已放行」。
   */
  test('T-ISO-6 外来 provider 在第一次开会话之前就已生效（~/.claude 被挡，~/.agents 已放行）', async () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), 'poietica-foreign-home-'))
    made.push(fakeHome)
    const dataRoot = path.join(fakeHome, 'AppData', 'Roaming', 'Poietica')
    /*
     * 两个跨工具的用户目录各放一份技能，名字必须不同：同名会走去重/冲突那条线，
     * 分不清「谁被挡了」。
     */
    const skills: readonly (readonly [string, string])[] = [
      [path.join(fakeHome, '.claude', 'skills', 'claude-only'), 'claude-only'],
      [path.join(fakeHome, '.agents', 'skills', 'agents-only'), 'agents-only'],
    ]
    for (const [dir, name] of skills) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\nbody\n`)
    }
    const result = await runFixture('foreign-providers-run.ts', {
      USERPROFILE: fakeHome,
      HOME: fakeHome,
      POIETICA_TEST_ROOT: dataRoot,
    })
    expect({ code: result.code, stderr: result.stderr.slice(-400) }).toMatchObject({ code: 0 })
    const report = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as {
      before: string[]
      after: string[]
    }
    const joined = report.before.join('\n')
    /* `~/.claude` 仍在禁用表里：它的技能一台都不该被发现 —— 开会话之前与之后都一样。 */
    expect(joined).not.toContain('claude-only')
    expect(report.after.join('\n')).not.toContain('claude-only')
    /* `~/.agents` 已放行：那份技能两遍都在（放行不是「开着会话才生效」）。 */
    expect(joined).toContain('agents-only')
    expect(report.after.join('\n')).toContain('agents-only')
  }, 60_000)
})
