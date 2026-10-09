import { describe, expect, it } from 'bun:test'
import type { RpcMessage, WindowBridge } from '@poietica/rpc'
import { createUiKernel, type LayoutService } from '@poietica/ui-kernel'
import type { SkillDocument } from '../../ui-api'
import { createSkillDocumentStore, SKILL_DOCUMENT_PANEL, toggleSkillDocument } from '../components/skill-document-store'

/*
 * 技能文档那一格的开关语义。
 *
 * 面板是**静态贡献**（id 与 title 都是常量），坞按 id 判「停的是不是这一格」，所以它分不出
 * 「又点了同一行」与「换了另一行」—— 那两件事必须由这里裁决。用例走的是产品代码自己的
 * toggleSkillDocument（不复刻判据），坞由真的内核给（createUiKernel 的 kernelServices.layout）。
 */

const OWNER = 'settings'

/** 只回核心状态的最小 bridge：这份用例不碰 RPC 的那几条口。 */
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

/** 现场把坞立起来并认一个前台（技能设置页那一刻）。 */
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
 * 点一行技能。ensurePanel 由「功能的组态」提供（真身是 ctx.contribute），这里记下它被
 * 调用了几次：贡献必须发生在 openPanel 之前，而收起那一趟不该再贡献一次。
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
    /*
     * 判据里「正停在技能文档那一格」这一条。少了它，从辅助对话切回技能文档这一下会被读成
     * 「又点了同一行」而把坞收起 —— 用户看到的是点了没反应。
     */
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
    /*
     * 贡献是幂等的（??= 只建一次），但收起那一趟本就不该走到那里 —— 走到了说明判据被绕过。
     */
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
    /*
     * 每次点行都重新 skills.read 一遍并重建对象，所以判等不能靠引用；name 取自 frontmatter，
     * 可能与名册那一行不同 —— 判据只认路径这一格。
     */
    const layout = await settingsDock()
    const store = createSkillDocumentStore()

    click(layout, store, documentOf('a/SKILL.md', 'name-from-roster'))

    expect(click(layout, store, documentOf('a/SKILL.md', 'name-from-frontmatter')).closed).toBe(true)
    expect(layout.current().right.open).toBe(false)
  })
})
