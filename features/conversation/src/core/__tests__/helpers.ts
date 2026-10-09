import { type CoreHarness, createCoreHarness } from '@poietica/core-kernel/testing'
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

export { conversationContract }
