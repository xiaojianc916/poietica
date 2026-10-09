import { Banner } from '@poietica/design-system'
import type { ConversationUi } from '@poietica/feature-conversation/ui-api'
import { type DialogService, useFeatureStore } from '@poietica/ui-kernel'
import { LoaderCircle } from 'lucide-react'
import type { ReactElement } from 'react'
import type { UpdateApi } from './api'
import { installUpdate } from './install'
import type { UpdateUiStore } from './store'
import { updateBannerNotice } from './update-notice'

/*
 * 更新横幅（07 页 §15E）。
 *
 * **迁移自** legacy `apps/desktop/src/update/update-banner.tsx`：判据（有没有未了的事决定
 * 留不留）与形制（design-system 的通用 `Banner`）都照它来。
 *
 * 这里曾经改写成「住在外壳栅格横幅区的一整行」—— 那偏离了 legacy，也正是「退出时闪一条
 * 没有字的 #383836 长方形」的来源（外壳按状态挂出整行、组件却按自己的判据画不出字）。
 * 产品负责人 2026-10-06 要求横幅一律回到通用 Banner：portal 浮层，不占栅格、不铺满整宽。
 *
 * 「重启并安装」在有对话运行时先问一句 —— 重启会掐断它们，这个代价必须由人确认。
 * legacy 里「发现新版本就自动下载」，新仓保留 available 这一档的「下载 / 稍后」。
 */
export function UpdateBanner({
  api,
  conversation,
  dialogs,
  store,
}: {
  readonly api: UpdateApi
  readonly conversation: ConversationUi
  readonly dialogs: DialogService
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
      void api.download()
      return
    }
    /* 运行中的对话数 > 0 时先确认：判据与文案都在 installUpdate 一处（菜单行同此）。 */
    installUpdate({ api, conversation, dialogs })
  }

  const label = (action: 'download' | 'later' | 'install'): string =>
    action === 'download' ? '下载' : action === 'later' ? '稍后' : '重启并安装'

  /*
   * 常驻与自动消失的分界不是时间长短，是**有没有未了的事**：下载中的人想知道下到哪了，
   * 待重启那一句带着唯一的安装入口 —— 它淡出等于把入口一起收走。所以下载中与待重启报
   * `holdMs: null`（连计时器都不装），不是「一个够长的毫秒数」。
   *
   * 「稍后」那一档只在 available 相位存在，它说完自己走，由 onDone 记下 dismissed。
   */
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
        /* 「已是最新」是一次性回话：报完清掉标记，别在下一次开菜单时又冒出来。 */
        if (notice.tone === 'success' && notice.version === '') store.clearLatest()
        else store.dismiss(notice.version)
      }}
      text={notice.text}
    />
  )
}
