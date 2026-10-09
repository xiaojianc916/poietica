/*
 * T-ISO-6 夹具（04 页 §3.3 第 9 条 / 12 页 §5.2）：外来 provider 必须在**第一次开会话之前**
 * 就已禁用，不能等到某条会话建好才生效。
 *
 * 判据是「假用户目录里放着 ~/.claude/skills/<name>/SKILL.md 与 ~/.agents/skills/<name>/SKILL.md
 * 时，`skills.list()` 报出的集合在开会话前后都一样」——按名字集合断言：
 * `~/.claude` 那份不许出现（仍在禁用表），`~/.agents` 那份必须出现（2026-10-09 已放行）。
 *
 * 为什么必须用子进程：omp 的目录一个进程只解析一次（12 页 §12.4）。
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dataLayout } from '@poietica/runtime-layout'
import { prepareIsolation } from '../../bootstrap/isolation-env'
import { captureLaunchEnv } from '../../bootstrap/launch-env'

const launch = captureLaunchEnv()
const root = process.env.POIETICA_TEST_ROOT!
const layout = dataLayout(root)
prepareIsolation(layout)
await import('@oh-my-pi/pi-utils')
await launch.scrubInjected()

const cwd = await mkdtemp(path.join(tmpdir(), 'poietica-foreign-work-'))
const { createOmpEngineForTest } = await import('../../testing')
const handle = await createOmpEngineForTest({ layout, relayPort: 0 })

/* 报上来的每一台技能的名字与来源：外来 provider 没被挡住时它们会出现在这里 */
const foreign = async (): Promise<string[]> => {
  const all = await handle.engine.skills.list(null)
  return all.map((s) => `${s.id}:${s.source}:${s.path}`)
}

const before = await foreign()
await handle.engine.freezeTools()
const session = await handle.engine.openSession({
  key: 'foreign',
  cwd,
  sessionFile: null,
  posture: 'ask',
  model: null,
  thinking: null,
})
const after = await foreign()
await session.dispose()
await handle.engine.dispose()

process.stdout.write(`${JSON.stringify({ before, after })}\n`)
process.exit(0)
