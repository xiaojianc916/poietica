import { Banner } from '@poietica/design-system'
import type { ConversationUi } from '@poietica/feature-conversation/ui-api'
import type { Logger } from '@poietica/foundation'
import { type DialogService, useFeatureStore } from '@poietica/ui-kernel'
import { LoaderCircle } from 'lucide-react'
import type { ReactElement } from 'react'
import type { UpdateApi } from './api'
import { installUpdate } from './install'
import type { UpdateUiStore } from './store'
import { updateBannerNotice } from './update-notice'

/* 更新横幅。判据（有没有未了的事决定留不留）与形制（design-system 的通用 `Banner`）照 legacy。这里曾经改写成「住在外壳栅格横幅区的
 * 一整行」—— 那偏离了 legacy，也正是「退出时闪一条没有字的 #383836 长方形」的来源（外壳按状态挂出整行、组件却按自己的判据画不出字）。
 * 「重启并安装」在有对话运行时先问一句 —— 重启会掐断它们，这个代价必须由人确认。 */
export function UpdateBanner({
  api,
  conversation,
  dialogs,
  logger,
  store,
}: {
  readonly api: UpdateApi
  readonly conversation: ConversationUi
  readonly dialogs: DialogService
  readonly logger: Logger
  readonly store: UpdateUiStore
}): ReactElement | null {
  const state = useFeatureStore(store.store, (held) => held.state)
  const dismissed = useFeatureStore(store.store, (held) => held.dismissed)
  const latest = useFeatureStore(store.store, (held) => held.latest)
  const notice = updateBannerNotice(state, dismissed, latest)
  if (notice === null) return null

  const run = (action: 'download' | 'later' | 'install'): void => {
    if (action === 'later') {
      store.dismiss(notice.version)
      return
    }
    if (action === 'download') {
      /* `timeoutMs: 0` 之后这条请求不会超时，但传输层断开、Core/Host 换代仍可能让它以错误拒绝 —— `void` 会留下一条未处理的 rejection。
       * 界面的真相来源是 update.stateChanged，这里只需要记一条日志。 */
      void api.download().catch((e: unknown) => logger.warn('update download failed', { error: String(e) }))
      return
    }
    installUpdate({ api, conversation, dialogs })
  }

  const label = (action: 'download' | 'later' | 'install'): string =>
    action === 'download' ? '下载' : action === 'later' ? '稍后' : '重启并安装'

  /* 常驻与自动消失的分界是**有没有未了的事**：下载中的人想知道下到哪了，待重启那一句带着唯一的安装入口 —— 它淡出等于把入口一起收走。
   * 所以这两档报 `holdMs: null`（连计时器都不装）。 */
  return (
    <Banner
      key={`${notice.version}:${state?.phase ?? 'none'}:${notice.tone ?? 'none'}`}
      {...(notice.spinning === true ? { icon: <LoaderCircle className="size-4 animate-spin" /> } : {})}
      {...(notice.persistent === true ? { holdMs: null } : {})}
      {...(notice.progress === undefined ? {} : { progress: Math.round(notice.progress * 100) })}
      {...(notice.tone === undefined ? {} : { tone: notice.tone })}
      actions={notice.actions.map((action) => ({
        label: label(action),
        onClick: () => {
          run(action)
        },
      }))}
      onDone={() => {
        if (notice.tone === 'success' && notice.version === '') store.clearLatest()
        else store.dismiss(notice.version)
      }}
      text={notice.text}
    />
  )
}
