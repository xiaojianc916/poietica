/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import { type ConversationUi, ConversationUiToken } from '@poietica/feature-conversation/ui-api'
import { type PreferencesApi, PreferencesToken } from '@poietica/feature-preferences/ui-api'
import {
  builtinPoints,
  type DialogService,
  DialogsToken,
  defineUiFeature,
  type ToastService,
  ToastsToken,
  useFeatureStore,
} from '@poietica/ui-kernel'
import { createUpdateApi } from './api'
import { createUpdateStore, type UpdateUiStore } from './store'
import { UpdateBanner } from './update-banner'
import { updateBannerVisible } from './update-notice'
import { UpdateRow } from './update-row'
import { UpdateAboutGroup } from './update-settings'

/**
 * 启动后自动检查的延迟（07 页 §15E）。
 *
 * 首屏还在装配，一个网络往返没有理由和它抢；十秒之后更新这件事才会说话。
 */
const FIRST_CHECK_DELAY_MS = 10_000

/** 横幅的可见性：useVisible 是同步的，两格状态都从同一个 store 读。 */
function useUpdateBannerVisible(store: UpdateUiStore): boolean {
  const state = useFeatureStore(store.store, (held) => held.state)
  const dismissed = useFeatureStore(store.store, (held) => held.dismissed)
  const latest = useFeatureStore(store.store, (held) => held.latest)
  return updateBannerVisible(state, dismissed, latest)
}

/**
 * ui 的装配（07 页 §15E）：
 *   - `overlays`（order 50）：available / downloading / ready 三态，就绪那一档带安装入口。
 *     横幅本身是 design-system 的通用 `Banner`（portal 浮层）——原先它住在外壳栅格的
 *     横幅行里，那一行已按产品负责人 2026-10-06 的要求整条删除；
 *   - `settingsSections`（order 950，page `platform.about`）：「软件更新」那一组
 *     （只有「自动检查软件更新」一个开关）落在**关于页**里，不单占导航一格
 *     —— 产品负责人 2026-10-06 的要求；手动检查那一条落在帮助菜单里
 *     （`helpMenuItems`，产品负责人 2026-10-08 要求「检查更新」回到帮助菜单）；
 *   - 启动自动检查：`idle` + 从没查过 + 偏好允许 → 十秒后问一次。
 *
 * 「启动后自动检查由 UI 发起」是 Host 模块之间无依赖的代价与分工：Host 只有状态机，
 * 要不要问由知道偏好与生命周期的一侧决定（15 页 §8.2）。
 */
export default defineUiFeature({
  id: 'update',
  dependsOn: ['preferences', 'conversation'],
  setup(ctx) {
    const api = createUpdateApi(ctx)
    const store = createUpdateStore()
    const preferences = ctx.services.get(PreferencesToken) as PreferencesApi
    const conversation = ctx.services.get(ConversationUiToken) as ConversationUi
    const dialogs = ctx.services.get(DialogsToken) as DialogService
    const toasts = ctx.services.get(ToastsToken) as ToastService

    /* 相位由 Host 说了算：通知是唯一的新值来源，UI 不在本地推演状态机。 */
    ctx.lifecycle.onDispose(
      api.onStateChanged((state) => {
        store.apply(state)
      }).dispose,
    )

    const sync = (): void => {
      void api.state().then(
        (state) => store.apply(state),
        (e: unknown) => ctx.logger.warn('update state unavailable', { error: String(e) }),
      )
    }
    sync()
    /* Core 就绪时再拉一次：渲染进程重载后 first paint 与 Host 通知之间会有空窗。 */
    ctx.lifecycle.onCoreReady(sync)

    /*
     * 十秒后的那次自动检查。
     *
     * 判据是「这一次运行还没有查过」：`lastCheckedAt` 由 Host 记住，渲染进程重载时它
     * 已有值，所以重载不会重复检查。开发版与安装版同一套相位（Host 打开
     * forceDevUpdateConfig），所以这一条在两处都会走。
     */
    let scheduled = false
    const maybeSchedule = (): void => {
      if (scheduled) return
      const state = store.store.getState().state
      if (state === null || state.phase !== 'idle' || state.lastCheckedAt !== null) return
      if (!preferences.current().updates.autoCheck) return
      scheduled = true
      const timer = setTimeout(() => {
        void api.check().then(
          (next) => store.apply(next),
          (e: unknown) => ctx.logger.warn('update check failed', { error: String(e) }),
        )
      }, FIRST_CHECK_DELAY_MS)
      ctx.lifecycle.onDispose(() => {
        clearTimeout(timer)
      })
    }
    /* 第一次状态到达之后才判断（setup 这一刻的 store 还是空的）。 */
    ctx.lifecycle.onDispose(store.store.subscribe(maybeSchedule))
    sync()

    ctx.contribute(builtinPoints.overlays, {
      id: 'update.available',
      order: 50,
      component: () => (
        <UpdateBanner api={api} conversation={conversation} dialogs={dialogs} logger={ctx.logger} store={store} />
      ),
      useVisible: () => useUpdateBannerVisible(store),
    })

    ctx.contribute(builtinPoints.settingsSections, {
      id: 'update.settings',
      order: 950,
      page: 'platform.about',
      component: () => <UpdateAboutGroup preferences={preferences} />,
    })

    /* 帮助菜单里的「检查更新」：legacy `app-shell.tsx` 传的就是这一行。 */
    ctx.contribute(builtinPoints.helpMenuItems, {
      id: 'update.check',
      order: 100,
      component: () => (
        <UpdateRow api={api} conversation={conversation} dialogs={dialogs} store={store} toasts={toasts} />
      ),
    })
  },
})
