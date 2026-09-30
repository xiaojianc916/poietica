import { DropdownMenuItem } from '@poietica/design-system'
import type { AppUpdateStore } from '@poietica/update'
import { Download, LoaderCircle } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { advance, hint, isBusy } from './update-phase'

interface UpdateRowProps {
  readonly store: AppUpdateStore
}
/**
 * 帮助菜单里那一行「检查更新」。
 *
 * 这一行只负责**发起**：结果由 UpdateBanner 报（菜单一关就卸载，结果留在这里等于没报）。
 * 触发与回话因此不在一处，但状态是同一份，两处不会各说各话。
 */
export function UpdateRow({ store }: UpdateRowProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return (
    <DropdownMenuItem
      aria-label={hint(state)}
      closeOnClick={false}
      disabled={isBusy(state)}
      onClick={() => {
        advance(state, store)
      }}
    >
      <Download aria-hidden="true" className="text-muted-foreground" />
      <span>检查更新</span>
      {state.phase === 'checking' ? (
        <LoaderCircle
          aria-hidden="true"
          className="ml-auto size-3.5 animate-spin text-muted-foreground"
        />
      ) : null}
    </DropdownMenuItem>
  )
}
