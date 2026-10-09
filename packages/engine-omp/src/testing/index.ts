import type { MockContent, MockResponse } from '@oh-my-pi/pi-ai/providers/mock'
import type { AgentEngine } from '@poietica/engine'
import type { ScenarioStep } from '@poietica/engine-testkit'
import { type Logger, noopLogger } from '@poietica/foundation'
import type { DataLayout } from '@poietica/runtime-layout'
import { createOmpEngineWith } from '../create-engine'

export interface MockEngineHandle {
  readonly engine: AgentEngine
  /** 设定接下来几轮的回复（每次调用覆盖之前的设定） */
  script(turns: readonly (readonly ScenarioStep[])[]): void
}

export interface CreateOmpEngineForTestOptions {
  readonly layout: DataLayout
  readonly logger?: Logger
  /** browser-relay 端口；测试里给 0 即可 */
  readonly relayPort?: number
  readonly engineVersion?: string
}

/** 一个 mock 回复就是 omp 自己的 MockResponse */
type MockReply = MockResponse

/**
 * 测试与探针专用的引擎（12 页 §12.1）：用 omp 自带的 mock provider 替代真实模型，完全离线、免 key，
 * 且不改动产品代码的任何路径。createOmpEngineWith 与测试缝都不从包根导出，只有 ./testing 能拿到。
 *
 * scenario → mock 回复的翻译规则见 12 页 §12.1 的表格。
 */
export async function createOmpEngineForTest(o: CreateOmpEngineForTestOptions): Promise<MockEngineHandle> {
  const logger = o.logger ?? noopLogger
  const { createMockModel, registerMockApi } = await import('@oh-my-pi/pi-ai/providers/mock')
  registerMockApi()
  // 待发回复队列：每次 stream 取一条（用光之后回一句 ok，让用例不会挂死）
  const pending: MockReply[] = []
  const mock = createMockModel({
    provider: 'mock',
    id: 'mock-model',
    handler: () => pending.shift() ?? { content: [{ type: 'text', text: 'ok' }] },
  })
  const engine = await createOmpEngineWith(
    {
      layout: o.layout,
      logger,
      relayPort: o.relayPort ?? 0,
      appVersion: 'test',
      engineVersion: o.engineVersion ?? '18.5.0',
    },
    // omp 的 getApiKey 签名是 (model) => ApiKey；mock provider 不需要真 key，给一个常量串
    { model: mock, getApiKey: () => 'mock' },
  )
  // mock provider 也要一份凭据：omp 的凭据解析在读模型之前跑，缺 key 会直接拒掉这一轮。
  // 走端口自己的写入面（credentials.set），不旁路内部的 authStorage。
  await engine.models.setApiKey('mock', 'mock')
  return {
    engine,
    script(turns) {
      pending.length = 0
      for (const turn of turns) pending.push(...repliesOf(turn))
    },
  }
}

/**
 * 一轮 scenario → 一串 mock 回复。
 * 一条回复里能同时装正文、思维链与用量；工具调用必须**自己占一条回复**
 * （一次只发起一个调用，工具结果由 omp 真正执行工具得到，随后的步骤放进下一条回复）。
 */
function repliesOf(turn: readonly ScenarioStep[]): MockReply[] {
  const replies: MockReply[] = []
  let content: MockContent[] = []
  let usage: Record<string, unknown> | undefined
  const flush = (): void => {
    if (content.length === 0 && usage === undefined) return
    replies.push({
      ...(content.length === 0 ? {} : { content }),
      ...(usage === undefined ? {} : { usage }),
    })
    content = []
    usage = undefined
  }
  for (const [index, step] of turn.entries()) {
    switch (step.kind) {
      case 'text':
        content.push({ type: 'text', text: step.text })
        break
      case 'thinking':
        content.push({ type: 'thinking', thinking: step.text })
        break
      case 'tool':
        // 工具调用自己占一条回复：omp 跑完它才发下一个 stream 请求
        flush()
        replies.push({
          content: [
            {
              type: 'toolCall',
              id: `call-${String(index)}`,
              name: step.name,
              arguments: (step.args ?? {}) as Record<string, unknown>,
            },
          ],
        })
        break
      case 'interaction':
        // 交互由 write_test 触发审批（姿态为 ask 时 omp 会发起）
        flush()
        replies.push({
          content: [
            { type: 'toolCall', id: `call-${String(index)}`, name: 'write_test', arguments: { text: 'interaction' } },
          ],
        })
        break
      case 'usage':
        usage = { ...step.usage }
        break
      case 'fail':
        flush()
        replies.push({ stopReason: 'error', errorMessage: step.message })
        break
    }
  }
  flush()
  if (replies.length === 0) replies.push({ content: [{ type: 'text', text: 'ok' }] })
  return replies
}
