import { createValue, type LayoutService, type Observable } from '@poietica/ui-kernel'
import type { SkillDocument } from '../../ui-api'

/*
 * 右栏「技能文档」这一刻在看哪一份。
 *
 * legacy 把这件事挂在 auxiliary-panel-store 的 `file:` pane 上（一个 pane 一格资源），
 * 新架构的右坞面板是**静态贡献**（`panels` 的 title 是常量），所以「看的是哪一份」只能
 * 悬在面板外面 —— 就是这一个值。见 docs/refactor-log.md 偏差 23。
 */
export interface SkillDocumentStore extends Observable<SkillDocument | undefined> {
  open(document: SkillDocument): void
}

/** 技能文档那一格的 panel id。坞按它判「现在停的是不是这一格」。 */
export const SKILL_DOCUMENT_PANEL = 'conversation.skillDocument'

/**
 * 是不是同一份文档。判据取路径：它来自名册那一行，一份技能一个，是这一格的真正身份。
 *
 * 「再点同一份 = 收起」全靠它 —— 面板 id 是常量（看的是哪一份悬在服务上），所以坞自己
 * 分不出「又点了同一行」与「换了另一行」，只有比内容才知道。
 */
function sameDocument(seen: SkillDocument | undefined, next: SkillDocument): boolean {
  return seen?.path === next.path
}

/**
 * 点一行技能该干什么：**再点同一行收起，其余打开 / 换过去**。
 *
 * 判据三条全中才算「再点同一行」：坞在场、正停在技能文档那一格、看的又是同一份。
 * 坞停在别的格上（辅助对话 / 审查……）时不收起 —— 那时用户是在把技能文档调回前台，
 * 收起会让这一下点了没反应。判断写在这里而不是组件里：面板的贡献与开关都发生在这一层，
 * 坞给不出「同一行点了第二次」这个事实。
 *
 * 打开那一趟要先确保面板已经贡献出来（坞按贡献项找 pane），而贡献项只能由功能的组态建，
 * 所以经 `ensurePanel` 交进来 —— 这样「再点收起 / 否则打开」整条顺序都在一处，不受调用方
 * 写错次序的影响。
 *
 * 返回 true 表示这一下是**收起**。
 */
export function toggleSkillDocument(
  layout: LayoutService,
  store: SkillDocumentStore,
  document: SkillDocument,
  ensurePanel: () => void,
): boolean {
  const state = layout.current()

  if (state.right.open && state.right.activeId === SKILL_DOCUMENT_PANEL && sameDocument(store.current(), document)) {
    layout.closePanel('right')
    return true
  }

  store.open(document)
  ensurePanel()
  layout.openPanel('right', SKILL_DOCUMENT_PANEL)

  return false
}

export function createSkillDocumentStore(): SkillDocumentStore {
  const value = createValue<SkillDocument | undefined>(undefined)

  return {
    current: value.current,
    subscribe: value.subscribe,
    open: (document) => {
      value.set(document)
    },
  }
}
