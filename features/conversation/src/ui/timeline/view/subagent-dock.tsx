import type { LayoutService, PanelItem } from '@poietica/ui-kernel'
import { useLayout } from '@poietica/ui-kernel'
import { useCallback, useSyncExternalStore } from 'react'
import type { SubagentTabsStore } from '../subagent-tabs'
import { DelegateChannelIcon, DelegateChannelPane } from './delegate-channel-view'

/** 右坞里「子代理」那一组的面板 id（只能由代码打开：offer false，不进启动器）。 */
export const SUBAGENT_PANEL_ID = 'conversation.subagents'

type DockTabs = NonNullable<PanelItem['dockTabs']>

/**
 * 把一个子代理开进右坞：标签记在它所属对话的账上，坞的归属认领给这条对话，再把坞的选中格指到子代理组。
 * 归属与前台不一致（不在这条对话的表面上）时坞不在场，标签照样记着，回到这条对话就看得见。
 */
export function openSubagentTab(
  layout: LayoutService,
  store: SubagentTabsStore,
  threadId: string,
  agentId: string,
  title?: string,
): void {
  store.open(threadId, agentId, title)
  if (layout.current().auxiliary.owner !== threadId) {
    layout.setAuxiliaryOwner(threadId)
  }
  layout.focusPane(threadId, SUBAGENT_PANEL_ID)
}

/**
 * 交给右坞的页签面。标签只报**当前坞归属**那条对话的：坞的标签条按归属画，别的对话的子代理不该挤进来。
 * 订阅里只在归属换人时通知（布局每次拖宽都会变，那些变化与标签无关）。
 */
export function createSubagentDockTabs({
  layout,
  resolveTitle,
  store,
}: {
  readonly layout: LayoutService
  /** 打开时没给名字的子代理（工具卡上的通道）在这里回查：子代理表的描述 → 派发调用上的通道名 → agentId。 */
  readonly resolveTitle: (threadId: string, agentId: string) => string
  readonly store: SubagentTabsStore
}): DockTabs {
  const owner = (): string | null => layout.current().auxiliary.owner

  return {
    subscribe: (listener) => {
      let held = owner()
      const offStore = store.subscribe(listener)
      const offLayout = layout.subscribe(() => {
        const next = owner()
        if (next !== held) {
          held = next
          listener()
        }
      })
      return () => {
        offStore()
        offLayout()
      }
    },
    tabs: () => {
      const threadId = owner()
      const set = store.of(threadId)
      if (threadId === null || set === null) {
        return []
      }
      return set.ids.map((agentId) => ({
        id: agentId,
        title: store.titleOf(threadId, agentId) ?? resolveTitle(threadId, agentId),
        icon: <DelegateChannelIcon />,
        active: agentId === set.activeId,
      }))
    },
    onSelect: (agentId) => {
      const threadId = owner()
      if (threadId !== null) store.select(threadId, agentId)
    },
    onClose: (agentId) => {
      const threadId = owner()
      if (threadId === null) return
      const left = store.close(threadId, agentId)
      /* 最后一个标签关掉、而坞此刻正停在子代理组上：把选中挪回剩下的最后一格，不留一块空白面。 */
      if (left === 0 && layout.current().right.activeId === SUBAGENT_PANEL_ID) {
        const rest = layout.panes.current().byOwner[threadId]?.ids.filter((id) => id !== SUBAGENT_PANEL_ID) ?? []
        const next = rest.at(-1)
        if (next !== undefined) layout.focusPane(threadId, next)
      }
    },
    /* offer false：启动器里没有这一格，「新开」无从谈起。 */
    onOpen: () => undefined,
  }
}

/** 坞里画的那一块：归属那条对话里选中的子代理通道。 */
export function SubagentDockPanel({ store }: { readonly store: SubagentTabsStore }) {
  const threadId = useLayout().auxiliary.owner
  const set = useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribe(listener), [store]),
    () => store.of(threadId),
  )
  const agentId = set?.activeId ?? null

  if (threadId === null || agentId === null) {
    return <p className="p-4 text-xs opacity-50">在对话右上角的状态面板里点一个子代理，它的对话会出现在这里。</p>
  }
  return <DelegateChannelPane agentId={agentId} conversationId={threadId} key={`${threadId}#${agentId}`} />
}
