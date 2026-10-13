import { describe, expect, it } from 'bun:test'
import type { RpcMessage, WindowBridge } from '@poietica/rpc'
import { createUiKernel, type LayoutService } from '@poietica/ui-kernel'
import type { SkillDocument } from '../../ui-api'
import { createSkillDocumentStore, SKILL_DOCUMENT_PANEL, toggleSkillDocument } from '../components/skill-document-store'

/*
 * 面板是静态贡献，坞按 id 判「停的是不是这一格」，分不出「又点同一行」与「换了另一行」。
 * 那两件事由这里裁决；用例走真身：toggleSkillDocument 加内核给的 layout，不复刻判据。
 */

const OWNER = 'settings'

/** 只回核心状态的最小 bridge。 */
function testBridge(): WindowBridge {
  const listeners = new Set<(message: RpcMessage) => void>()
  return {
    send(message) {
      if ('id' in message && typeof message.id === 'number' && 'method' in message) {
        const id = message.id
        queueMicrotask(() => {
          for (const listener of [...listeners]) {
            listener({ jsonrpc: '2.0', id, result: { state: 'starting', reason: null, attempt: 0 } })
          }
        })
      }
    },
    onMessage(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    pathForFile: () => 'C:/tmp/x',
  }
}

/** 现场把坞立起来并认一个前台。 */
async function settingsDock(): Promise<LayoutService> {
  const kernel = createUiKernel({
    features: [],
    errorMessages: {},
    validateResults: false,
    defaultRoute: { surface: 'home', params: {} },
    bridge: testBridge(),
  })
  await kernel.start()
  const layout = kernel.kernelServices.layout
  layout.setActiveOwner(OWNER)
  return layout
}

function documentOf(path: string, name: string): SkillDocument {
  return {
    markdown: `# ${name}`,
    name,
    path,
    facts: {
      name,
      description: undefined,
      body: '',
      type: undefined,
      whenToUse: undefined,
      disableModelInvocation: false,
      issues: [],
    },
  }
}

type Store = ReturnType<typeof createSkillDocumentStore>

/*
 * ensurePanel 真身是 ctx.contribute，这里数它被调了几次：贡献必须在 openPanel 之前，
 * 收起那一趟不该再贡献。
 */
function click(layout: LayoutService, store: Store, document: SkillDocument) {
  let contributions = 0

  const closed = toggleSkillDocument(layout, store, document, () => {
    contributions += 1
  })

  return { closed, contributions }
}

describe('技能文档那一格的开关', () => {
  it('第一次点一行:打开右坞并停在技能文档那一格', async () => {
    const layout = await settingsDock()
    const store = createSkillDocumentStore()

    expect(click(layout, store, documentOf('a/SKILL.md', 'a')).closed).toBe(false)
    expect(layout.current().right.open).toBe(true)
    expect(layout.current().right.activeId).toBe(SKILL_DOCUMENT_PANEL)
  })

  it('再点同一行:收起', async () => {
    const layout = await settingsDock()
    const store = createSkillDocumentStore()

    click(layout, store, documentOf('a/SKILL.md', 'a'))

    expect(click(layout, store, documentOf('a/SKILL.md', 'a')).closed).toBe(true)
    expect(layout.current().right.open).toBe(false)
  })

  it('点另一行:换过去,不收起', async () => {
    const layout = await settingsDock()
    const store = createSkillDocumentStore()

    click(layout, store, documentOf('a/SKILL.md', 'a'))

    expect(click(layout, store, documentOf('b/SKILL.md', 'b')).closed).toBe(false)
    expect(layout.current().right.open).toBe(true)
    expect(store.current()?.name).toBe('b')
  })

  it('收起之后还能再打开:收起不是「把这一格关掉」', async () => {
    const layout = await settingsDock()
    const store = createSkillDocumentStore()

    click(layout, store, documentOf('a/SKILL.md', 'a'))
    click(layout, store, documentOf('a/SKILL.md', 'a'))

    expect(click(layout, store, documentOf('a/SKILL.md', 'a')).closed).toBe(false)
    expect(layout.current().right.open).toBe(true)
  })

  it('坞停在别的格上时点同一行:打开,不是收起', async () => {
    /* 少了「正停在技能文档那一格」这一条，从辅助对话切回会被读成「又点了同一行」而收起，用户看到的是点了没反应。 */
    const layout = await settingsDock()
    const store = createSkillDocumentStore()

    click(layout, store, documentOf('a/SKILL.md', 'a'))
    layout.openPanel('right', 'conversation.auxiliary')

    expect(click(layout, store, documentOf('a/SKILL.md', 'a')).closed).toBe(false)
    expect(layout.current().right.activeId).toBe(SKILL_DOCUMENT_PANEL)
  })

  it('坞被关掉（标签条上的叉）之后再点同一行:打开', async () => {
    const layout = await settingsDock()
    const store = createSkillDocumentStore()

    click(layout, store, documentOf('a/SKILL.md', 'a'))
    layout.closePanel('right')

    expect(click(layout, store, documentOf('a/SKILL.md', 'a')).closed).toBe(false)
    expect(layout.current().right.open).toBe(true)
  })

  it('收起那一趟不再贡献面板:贡献只该发生一次', async () => {
    /* 贡献本身是幂等的，但收起那一趟本就不该走到那里，走到了说明判据被绕过。 */
    const layout = await settingsDock()
    const store = createSkillDocumentStore()

    expect(click(layout, store, documentOf('a/SKILL.md', 'a')).contributions).toBe(1)
    expect(click(layout, store, documentOf('a/SKILL.md', 'a')).contributions).toBe(0)
  })

  it('换另一行时也走一次贡献（贡献是幂等的，调用方不必自己判）', async () => {
    const layout = await settingsDock()
    const store = createSkillDocumentStore()

    click(layout, store, documentOf('a/SKILL.md', 'a'))

    expect(click(layout, store, documentOf('b/SKILL.md', 'b')).contributions).toBe(1)
  })

  it('判据是路径:同一份文档重新读一遍（对象换新、名字也可能换）仍算同一行', async () => {
    /* 每次点行都重新读一遍并重建对象，判等不能靠引用；name 取自 frontmatter，判据只认路径这一格。 */
    const layout = await settingsDock()
    const store = createSkillDocumentStore()

    click(layout, store, documentOf('a/SKILL.md', 'name-from-roster'))

    expect(click(layout, store, documentOf('a/SKILL.md', 'name-from-frontmatter')).closed).toBe(true)
    expect(layout.current().right.open).toBe(false)
  })
})
