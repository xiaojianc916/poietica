import { createValue, type LayoutService, type Observable } from '@poietica/ui-kernel'
import type { SkillDocument } from '../../ui-api'

/* 右坞面板是**静态贡献**（`panels` 的 title 是常量），所以「看的是哪一份」只能悬在面板外面 —— 就是这一个值。 */
export interface SkillDocumentStore extends Observable<SkillDocument | undefined> {
  open(document: SkillDocument): void
}

/** 技能文档那一格的 panel id。 */
export const SKILL_DOCUMENT_PANEL = 'conversation.skillDocument'

/**
 * 判据取路径：它来自名册那一行，一份技能一个，是这一格的真正身份 —— 面板 id 是常量，坞自己分不出「又点了同一行」与「换了另一行」。
 */
function sameDocument(seen: SkillDocument | undefined, next: SkillDocument): boolean {
  return seen?.path === next.path
}

/**
 * 三条全中才算「再点同一行」：坞在场、正停在技能文档那一格、看的又是同一份 —— 坞停在别的格上时不收起。判断写在这一层而不是组件里：坞给不出「同一行点了第二次」这个事实。
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
