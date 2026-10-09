// T-ISO-5 夹具（12 页 §12.4）：按 serve.ts 的顺序引导，用 mock 模型跑一轮对话，
// 再调一次 models.providers() 与 skills.list(null)，然后正常退出。
// 宿主断言：子进程退出码为 0，且假用户目录里除了数据根那条链之外什么都没有。

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dataLayout } from '@poietica/runtime-layout'
import { prepareIsolation } from '../../bootstrap/isolation-env'
import { captureLaunchEnv } from '../../bootstrap/launch-env'
import { runIsolationSelfCheck } from '../../bootstrap/self-check'

// 第一步：快照环境（必须在 import 任何 omp 模块之前）
const launch = captureLaunchEnv()
const root = process.env.POIETICA_TEST_ROOT!
const layout = dataLayout(root)
prepareIsolation(layout)
// pi-utils 在求值时注入 .env：清掉那些键
await import('@oh-my-pi/pi-utils')
const scrubbed = await launch.scrubInjected()
const check = await runIsolationSelfCheck(layout)
if (!check.ok) {
  process.stderr.write(`隔离自检失败：${check.violations.join('; ')}\n`)
  process.exit(3)
}
const cwd = await mkdtemp(path.join(tmpdir(), 'poietica-iso5-work-'))
const { createOmpEngineForTest } = await import('../../testing')
const handle = await createOmpEngineForTest({ layout, relayPort: 0 })
handle.engine.freezeTools()
handle.script([[{ kind: 'text', text: '你好' }]])
const session = await handle.engine.openSession({
  key: 'iso5',
  cwd,
  sessionFile: null,
  posture: 'ask',
  model: null,
  thinking: null,
})
await session.submit({ text: '在吗', images: [], files: [], skills: [], deliverAs: 'turn' })
// 等这一轮真的结束（订阅状态）
await new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, 8000)
  session.subscribe((event) => {
    if (event.type === 'state' && event.state === 'idle') {
      clearTimeout(timer)
      resolve()
    }
  })
})
await handle.engine.models.providers()
await handle.engine.skills.list(null)
await handle.engine.dispose()
process.stdout.write(`${JSON.stringify({ ok: true, scrubbed: scrubbed.length })}\n`)
process.exit(0)
