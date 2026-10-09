import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

const fixtures = path.join(import.meta.dir, 'fixtures')
const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 假用户目录里出现过的**全部路径**（相对 fakeHome） */
function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name)
    const rel = path.relative(base, abs).split(path.sep).join('/')
    out.push(rel)
    if (statSync(abs).isDirectory()) walk(abs, base, out)
  }
  return out
}

describe('T-ISO-5：假用户目录', () => {
  test('完整走一遍引导与一轮对话之后，用户目录里除数据根外零写入', async () => {
    // 假用户目录必须在真实用户目录之下（isolatedConfigDir 的要求），所以建在 %TEMP% 里
    const fakeHome = mkdtempSync(path.join(tmpdir(), 'poietica-fake-home-'))
    made.push(fakeHome)
    const dataRoot = path.join(fakeHome, 'AppData', 'Roaming', 'Poietica')
    const proc = Bun.spawn([process.execPath, path.join(fixtures, 'iso-run.ts')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        USERPROFILE: fakeHome,
        HOME: fakeHome,
        POIETICA_TEST_ROOT: dataRoot,
      },
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited
    // 自检失败时夹具以退出码 3 退出并往 stderr 写一行；这里只断言那条失败标记不出现
    expect(stderr).not.toContain('隔离自检失败')
    expect({ code, stderr: stderr.slice(-400) }).toMatchObject({ code: 0 })
    // 夹具自己那一行 JSON 是 stdout 的最后一行（omp 的库会往 stdout 打别的行）
    expect(stdout).toContain('"ok":true')

    /*
     * 断言：除了数据根这一条路径链之外，假用户目录里没有任何文件或目录。
     * 特别是不能出现 .omp、.agents、.config（12 页 §12.4）。
     */
    const realHome = homedir()
    if (path.resolve(fakeHome).startsWith(path.resolve(realHome))) {
      // 注意：假目录在真用户目录之下，隔离变量把 omp 的数据全指到 dataRoot，所以真目录不受影响
    }
    const entries = walk(fakeHome)
    /*
     * 断言：数据根之外不许有**任何 agent 相关**的写入。
     * 排除项两类，都有明确出处，不是放宽：
     * - `.bun`：Bun 自己按 USERPROFILE 放的安装缓存，与 omp 无关（换假 home 跑任何脚本都会出现）；
     * - `AppData/Roaming/Poietica/**`：数据根本身。
     */
    const allowedTop = new Set(['AppData', 'AppData/Roaming', 'AppData/Roaming/Poietica', '.bun'])
    for (const rel of entries) {
      if (allowedTop.has(rel)) continue
      if (rel.startsWith('AppData/Roaming/Poietica/')) continue
      if (rel.startsWith('.bun/')) continue
      throw new Error(`假用户目录里出现了数据根之外的路径：${rel}`)
    }
    // 12 页 §12.4 点名的三处：全局 omp、跨工具用户目录、XDG 配置
    expect(entries.some((rel) => rel === '.omp' || rel.startsWith('.omp/'))).toBe(false)
    expect(entries.some((rel) => rel === '.agents' || rel.startsWith('.agents/'))).toBe(false)
    expect(entries.some((rel) => rel === '.config' || rel.startsWith('.config/'))).toBe(false)
    // 数据根里确实建好了 omp 的目录 —— 证明这一轮是真的跑起来了，不是「什么都没发生」
    expect(entries.some((rel) => rel.startsWith('AppData/Roaming/Poietica/omp/agent'))).toBe(true)
  }, 60_000)
})
