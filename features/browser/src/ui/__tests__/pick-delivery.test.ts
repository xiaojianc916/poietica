import { describe, expect, test } from 'bun:test'
import type { ComposerDraft } from '@poietica/feature-conversation/ui-api'
import type { NavigationService } from '@poietica/ui-kernel'
import type { PickedElement } from '../../contract'
import { createPickDelivery, reportName, utf8ToBase64 } from '../pick-delivery'

/*
 * 拾取结果 → 输入框（07 页 §12E）。迁移自 legacy `apps/desktop/src/browser/browser-pick.test.ts`
 * 的全部断言意图：
 *
 *   - 交付只落到交付时的那一个目标（legacy：instances deliver only to their own target）→
 *     目标由每次交付前现取 `activeComposer()` 决定；取不到就去入口页再取一次；
 *   - 附件与文字按浏览器那一次的用户意图落进草稿（`submission==='send'` 才提交）；
 *   - 没有目标可去就把结果丢掉并报一次（legacy 的「没有输入框可去，丢弃」）。
 */

const picked = (over: Partial<PickedElement> = {}): PickedElement => ({
  tabId: 1,
  url: 'https://a.example/',
  submission: 'send',
  elementType: 'button',
  comment: 'inspect',
  report: '# 报告',
  ...over,
})

interface DraftLog {
  attachments: { name: string; kind: string }[]
  submits: number
  texts: string[]
}

function fakeDraft(log: DraftLog): ComposerDraft {
  return {
    threadId: null,
    addAttachments(items) {
      log.attachments.push(...items.map((item) => ({ name: item.name, kind: item.kind })))
    },
    insertText(text) {
      log.texts.push(text)
    },
    submit() {
      log.submits += 1
    },
  }
}

interface Harness {
  readonly log: DraftLog
  readonly imports: { name: string; mime: string; base64: string }[]
  readonly messages: string[]
  delivery: ReturnType<typeof createPickDelivery>
  /** 这一格输入框此刻归谁：切页面就是换一个值。 */
  composer: ComposerDraft | null
  /** 回入口页时把输入框装上（真实的 home 页就是这一下挂载）。 */
  onHome?: (() => ComposerDraft) | undefined
  homeVisits: number
}

function harness(): Harness {
  const state: Harness = {
    log: { attachments: [], submits: 0, texts: [] },
    imports: [],
    messages: [],
    homeVisits: 0,
    composer: null,
    onHome: undefined,
    delivery: undefined as never,
  }
  const navigation: NavigationService = {
    current: () => ({ route: { surface: 'conversation.threads', params: {} }, canGoBack: false, canGoForward: false }),
    subscribe: () => () => undefined,
    navigate: (route) => {
      if (route.surface !== 'conversation.home') {
        return
      }

      state.homeVisits += 1
      state.composer = state.onHome?.() ?? state.composer
    },
    back: () => undefined,
    forward: () => undefined,
    home: () => undefined,
    restore: () => undefined,
  }

  state.delivery = createPickDelivery({
    importData: async (name, mime, base64) => {
      state.imports.push({ name, mime, base64 })
      return { id: 'att-1', name, kind: 'file', previewUrl: null }
    },
    activeComposer: () => state.composer,
    navigation,
    report: (message) => {
      state.messages.push(message)
    },
  })

  return state
}

describe('元素报告 → 附件', () => {
  test('reportName 跟着元素类型走，非法字符换成短横', () => {
    expect(reportName('button')).toBe('button.md')
    expect(reportName('a/b')).toBe('a-b.md')
    expect(reportName('  ')).toBe('element.md')
  })

  test('utf8ToBase64 编的还是原来的字节（读回是同一段 Markdown）', () => {
    const text = '# 报告\n中文'

    expect(new TextDecoder().decode(Uint8Array.from(atob(utf8ToBase64(text)), (c) => c.charCodeAt(0)))).toBe(text)
  })
})

describe('交付', () => {
  test('附件按 text/markdown 导入，comment 进正文，intent=send 就提交', async () => {
    const h = harness()
    const draft = fakeDraft(h.log)
    h.composer = draft

    await h.delivery.deliver(picked())

    expect(h.imports).toEqual([{ name: 'button.md', mime: 'text/markdown', base64: utf8ToBase64('# 报告') }])
    expect(h.log.attachments).toEqual([{ name: 'button.md', kind: 'file' }])
    expect(h.log.texts).toEqual(['inspect'])
    expect(h.log.submits).toBe(1)
    expect(h.homeVisits).toBe(0)
  })

  test('intent=attach 不提交，空 comment 不写正文', async () => {
    const h = harness()
    h.composer = fakeDraft(h.log)

    await h.delivery.deliver(picked({ submission: 'attach', comment: '' }))

    expect(h.log.texts).toEqual([])
    expect(h.log.submits).toBe(0)
    expect(h.log.attachments).toHaveLength(1)
  })

  test('交付前没有输入框：先回入口页再取一次，取到才写', async () => {
    const h = harness()
    h.onHome = () => fakeDraft(h.log)

    await h.delivery.deliver(picked())

    expect(h.homeVisits).toBe(1)
    expect(h.log.attachments).toHaveLength(1)
    expect(h.log.texts).toEqual(['inspect'])
  })

  test('回了入口页还是没有输入框：丢弃并报一次，不假装成功', async () => {
    const h = harness()

    await h.delivery.deliver(picked())

    expect(h.homeVisits).toBe(1)
    expect(h.messages).toEqual(['拾取结果没有输入框可去，丢弃'])
    expect(h.log.attachments).toEqual([])
    expect(h.log.submits).toBe(0)
  })
})
