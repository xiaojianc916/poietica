import './omp-home'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import '@oh-my-pi/pi-coding-agent/config/all-settings'
import { runEngineConformance } from '@poietica/engine-testkit'
import { noopLogger } from '@poietica/foundation'
import type { DataLayout } from '@poietica/runtime-layout'
import { testLayout } from './omp-home'

/**
 * P2.11：一致性套件跑在真实 OmpEngine 上（12 页 §12.2）。
 *
 * 模型用 omp 自带的 mock provider：完全离线、免 key，不改产品代码的任何路径。
 * 这 13 个用例同时也是端口语义与 FakeEngine 的对照 —— 两边都过才说明替身可信。
 */
runEngineConformance('OmpEngine', async () => {
  const { createOmpEngineForTest } = await import('../testing')
  const cwd = await mkdtemp(path.join(tmpdir(), 'poietica-omp-conformance-'))
  const handle = await createOmpEngineForTest({ layout: testLayout as DataLayout, logger: noopLogger, relayPort: 0 })
  return {
    engine: handle.engine,
    cwd,
    script: (turns) => handle.script(turns),
    dispose: async () => {
      await handle.engine.dispose()
    },
  }
})
