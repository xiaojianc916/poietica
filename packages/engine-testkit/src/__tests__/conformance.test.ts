import { runEngineConformance } from '../conformance'
import { createFakeEngine } from '../fake-engine'
import { tempDirWithCleanup } from './helpers'

runEngineConformance('FakeEngine', async () => {
  const dir = await tempDirWithCleanup()
  // script(...) 设定“接下来几轮”；按提交顺序消费，跨会话共享同一条队列
  let pending: import('../scenario').ScenarioStep[][] = []
  let last: readonly import('../scenario').ScenarioStep[] = [{ kind: 'text', text: 'ok' }]
  const engine = createFakeEngine({
    script: () => {
      last = pending.shift() ?? last
      return last
    },
  })
  return {
    engine,
    cwd: dir,
    script(next) {
      pending = next.map((turn) => [...turn])
    },
    dispose: () => engine.dispose(),
  }
})
