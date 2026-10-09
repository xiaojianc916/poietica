import { DropdownMenuItem } from '@poietica/design-system'
import type { ConversationUi } from '@poietica/feature-conversation/ui-api'
import { type DialogService, type ToastService, useFeatureStore } from '@poietica/ui-kernel'
import { Download, LoaderCircle } from 'lucide-react'
import type { ReactElement } from 'react'
import type { UpdateState } from '../contract'
import type { UpdateApi } from './api'
import { installUpdate } from './install'
import type { UpdateUiStore } from './store'

/**
 * 帮助菜单里那一行「检查更新」（迁移自 legacy `update/update-row.tsx`）。
 *
 * 这一行只负责**发起**：结果由 UpdateBanner 报（菜单一关就卸载，结果留在这里等于没报）。
 * 触发与回话因此不在一处，但状态是同一份，两处不会各说各话。
 *
 * `closeOnClick={false}` 与 legacy 一致：点完菜单不收起，那一枚转着的字形就在原地说
 * 「正在检查」；关不关由人自己按 Esc / 点外面决定。
 */
export function UpdateRow({
  api,
  conversation,
  dialogs,
  store,
  toasts,
}: {
  readonly api: UpdateApi
  readonly conversation: ConversationUi
  readonly dialogs: DialogService
  readonly store: UpdateUiStore
  readonly toasts: ToastService
}): ReactElement {
  const state = useFeatureStore(store.store, (held) => held.state)
  const phase = state?.phase ?? null
  const busy = phase === 'checking' || phase === 'downloading'
  return (
    <DropdownMenuItem
      aria-label={hintOf(phase)}
      closeOnClick={false}
      disabled={busy || phase === 'disabled'}
      onClick={() => {
        /*
         * 与 legacy 的 `advance()` 同一套两条路：待重启那一档点下去就是安装
         * （存档好的字节就在盘上，重新检查只会拿到同一个版本）；其余一律重新检查。
         * 手动检查必须回话：没有新版本时播一次「已是最新」（横幅报，报完自己走）。
         */
        if (phase === 'ready') {
          installUpdate({ api, conversation, dialogs })
          return
        }
        /* 上一句「已是最新」先撤掉：这一趟是新的一次动作，回话以它自己的结果为准。 */
        store.clearLatest()
        void api.check().then(
          (next) => {
            /*
             * 手动检查是人按下之后的动作，两种结果都要回话：
             *   - `idle`：这一趟没有新版本 → 横幅报一句「已是最新」，报完自己走；
             *   - `error`：原生异常已由状态机记进日志，这里把给用户看的中文抬上屏
             *     （自动检查遇到同样的相位保持安静，免得启动时就嚷）。
             */
            if (next.phase === 'idle') {
              store.announceLatest()
            } else if (next.phase === 'error') {
              toasts.show({ severity: 'error', title: next.error ?? '检查更新失败' })
            }
          },
          /* 传输层都打不开：同样要回话，文案走错误面（AppError 的 __messages）。 */
          (e: unknown) => {
            toasts.error(e, '检查更新失败')
          },
        )
      }}
    >
      <Download aria-hidden="true" className="text-muted-foreground" />
      <span>检查更新</span>
      {state?.phase === 'checking' ? (
        <LoaderCircle aria-hidden="true" className="ml-auto size-3.5 animate-spin text-muted-foreground" />
      ) : null}
    </DropdownMenuItem>
  )
}

/** 行内的无障碍提示：与 legacy 的 `hint()` 同一套相位口径。 */
function hintOf(phase: UpdateState['phase'] | null): string {
  switch (phase) {
    case 'checking':
      return '正在检查更新'
    case 'downloading':
      return '正在下载更新'
    case 'ready':
      return '新版本已就绪，点击安装'
    default:
      return '检查更新'
  }
}
