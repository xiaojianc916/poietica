import { Button } from '@poietica/design-system'
import type { AppUpdateStore } from '@poietica/update'
import { Download, LoaderCircle } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { advance, hint, isBusy } from './update-phase'

interface UpdateCapsuleProps {
  readonly store: AppUpdateStore
}
/**
 * 有更新就一直在场的那枚胶囊。
 *
 * 与帮助菜单里那一行是同一份状态的两个投影，措辞与下一步动作都取自
 * update-phase。idle / checking / latest 不在场：那三个相位没有要人动手的事，
 * 常驻只会变成噪音。
 */
export function UpdateCapsule({ store }: UpdateCapsuleProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  if (state.phase === 'idle' || state.phase === 'checking' || state.phase === 'latest') {
    return null
  }
  const busy = isBusy(state)
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-3 z-50 flex justify-center"
      role="status"
    >
      <Button
        className="pointer-events-auto h-auto gap-2 rounded-full bg-chrome px-3 py-1.5 text-xs shadow-lg"
        disabled={busy}
        onClick={() => {
          advance(state, store)
        }}
        type="button"
        variant="ghost"
      >
        {busy ? (
          <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
        ) : (
          <Download aria-hidden="true" className="size-3.5" />
        )}
        <span>{hint(state)}</span>
      </Button>
    </div>
  )
}
