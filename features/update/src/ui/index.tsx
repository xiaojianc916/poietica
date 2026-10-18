/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import { ConversationUiToken } from '@poietica/feature-conversation/ui-api'
import { PreferencesToken } from '@poietica/feature-preferences/ui-api'
import { builtinPoints, DialogsToken, defineUiFeature, ToastsToken, useFeatureStore } from '@poietica/ui-kernel'
import { createUpdateApi } from './api'
import { createUpdateStore, type UpdateUiStore } from './store'
import { UpdateBanner } from './update-banner'
import { updateBannerVisible } from './update-notice'
import { UpdateRow } from './update-row'
import { UpdateAboutGroup } from './update-settings'

/** 首屏还在装配，一个网络往返没有理由和它抢。 */
const FIRST_CHECK_DELAY_MS = 10_000

function useUpdateBannerVisible(store: UpdateUiStore): boolean {
  const state = useFeatureStore(store.store, (held) => held.state)
  const dismissed = useFeatureStore(store.store, (held) => held.dismissed)
  const latest = useFeatureStore(store.store, (held) => held.latest)
  return updateBannerVisible(state, dismissed, latest)
}

/**
 * ui 的装配：`overlays`（order 50）available / downloading / ready 三态，就绪那一档带安装入口（横幅是 design-system 的通用 `Banner`）；
 * `settingsSections`（order 950, page `platform.about`）「软件更新」那一组落在**关于页**里；手动检查那一条落在帮助菜单里（`helpMenuItems`）；
 * 启动自动检查：`idle` + 从没查过 + 偏好允许 → 十秒后问一次。自动检查由 UI 发起是 Host 模块之间无依赖的代价：Host 只有状态机，
 * 要不要问由知道偏好与生命周期的一侧决定。
 */
export default defineUiFeature({
  id: 'update',
  dependsOn: ['preferences', 'conversation'],
  setup(ctx) {
    const api = createUpdateApi(ctx)
    const store = createUpdateStore()
    const preferences = ctx.services.get(PreferencesToken)
    const conversation = ctx.services.get(ConversationUiToken)
    const dialogs = ctx.services.get(DialogsToken)
    const toasts = ctx.services.get(ToastsToken)

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
    ctx.lifecycle.onCoreReady(sync)

    /* 判据是「这一次运行还没有查过」：`lastCheckedAt` 由 Host 记住，渲染进程重载时它已有值，所以重载不会重复检查。 */
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

    ctx.contribute(builtinPoints.helpMenuItems, {
      id: 'update.check',
      order: 100,
      component: () => (
        <UpdateRow api={api} conversation={conversation} dialogs={dialogs} store={store} toasts={toasts} />
      ),
    })
  },
})
