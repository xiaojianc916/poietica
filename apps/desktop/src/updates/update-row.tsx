import type { AppUpdateStore } from '@poietica/desktop-adapters'
import { DropdownMenuItem } from '@poietica/ui'
import { Download, LoaderCircle } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { advance, hint, isBusy, note } from './update-phase'

interface UpdateRowProps {
  readonly store: AppUpdateStore
}
/**
 * 帮助菜单里那一行「检查更新」。
 *
 * 触发与回话在同一行上，所以这一行不关菜单；常驻胶囊读同一份相位，两处不会
 * 各说各话。
 */
export function UpdateRow({ store }: UpdateRowProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const said = note(state)
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
      {said === null ? null : (
        <span className="ml-auto text-muted-foreground text-xs" role="status">
          {said}
        </span>
      )}
    </DropdownMenuItem>
  )
}
