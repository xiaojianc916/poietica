import { type CoreHarness, createCoreHarness } from '@poietica/core-kernel/testing'
import type { EngineSession, OpenSessionSpec } from '@poietica/engine'
import { createFakeEngine, type FakeEngine, type ScenarioScript } from '@poietica/engine-testkit'
import attachments from '@poietica/feature-attachments/core'
import workspaces from '@poietica/feature-workspaces/core'
import { fakeClock } from '@poietica/test-kit'
import { conversationContract } from '../../contract'
import conversation from '../index'

/**
 * 只装被测模块及其依赖的真实内核（14 页 §0.4）：conversation 的 Core 依赖 workspaces 与
 * attachments，所以三个模块一起启动，engine 用 FakeEngine。
 */
export async function harness(
  opts: { readonly script?: ScenarioScript } = {},
): Promise<{ h: CoreHarness; engine: FakeEngine }> {
  // 同一个 fakeClock 交给双方（见 CoreHarnessOptions.clock 的注释）
  const clock = fakeClock()
  const engine = createFakeEngine({ clock, ...(opts.script === undefined ? {} : { script: opts.script }) })
  const h = await createCoreHarness({ modules: [attachments, workspaces, conversation], engine, clock })
  return { h, engine }
}

/**
 * 让会话稳定停在「忙」的那一档：一个 confirm 交互。FakeEngine 执行到 interaction 会发
 * interactionRequested → state awaiting 并**暂停**，直到 respond（12 页 §1.2）。
 */
export const BUSY_SCRIPT: ScenarioScript = () => [
  { kind: 'interaction', interaction: { kind: 'confirm', title: '继续吗', message: '等一句回答' } },
]

export interface DeferredOpenEngine {
  readonly engine: FakeEngine
  /** 每次 openSession 收到的 spec（还没落地的按顺序停在这里） */
  readonly pending: readonly OpenSessionSpec[]
  /** 已经被 dispose 的会话（按顺序） */
  readonly disposed: readonly EngineSession[]
  /** 让第 `at` 个停住的打开落地；给这条会话装上 dispose 记数后交回它 */
  resolveOpen(at: number): Promise<EngineSession>
}

/**
 * 可控的打开（R-03 §4.1 的引擎包装）：`openSession` 不立刻交回会话，而是停在一个由测试
 * 手动 resolve 的 deferred 上 —— 打开中的窗口（冷启动几秒）才测得到。
 */
export function deferredOpenEngine(base: FakeEngine = createFakeEngine()): DeferredOpenEngine {
  base.freezeTools()
  const realOpen = base.openSession.bind(base)
  const pending: { readonly spec: OpenSessionSpec; resolve(session: EngineSession): void }[] = []
  const disposed: EngineSession[] = []
  const engine: FakeEngine = {
    ...base,
    openSession: (spec) =>
      new Promise<EngineSession>((resolve) => {
        pending.push({ spec, resolve })
      }),
  }
  return {
    engine,
    get pending() {
      return pending.map((entry) => entry.spec)
    },
    disposed,
    async resolveOpen(at) {
      const entry = pending[at]
      if (entry === undefined) throw new Error(`没有第 ${at} 个待打开的会话`)
      const session = await realOpen(entry.spec)
      const original = session.dispose.bind(session)
      session.dispose = async () => {
        disposed.push(session)
        await original()
      }
      entry.resolve(session)
      return session
    },
  }
}

export { conversationContract }
