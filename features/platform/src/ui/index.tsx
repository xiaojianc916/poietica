/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import { systemContract } from '@poietica/contract-kit'
import {
  builtinPoints,
  type CommandItem,
  defineUiFeature,
  type KeybindingItem,
  type NavigationService,
  NavigationToken,
  SETTINGS_GROUPS,
  type SettingsPageItem,
  ToastsToken,
  type UiLogging,
  UiLoggingToken,
  useCoreStatus,
} from '@poietica/ui-kernel'
// 设置页图标用 legacy SECTIONS 里那两枚（lucide 的 HardDrive / Info），不手描 path。
import { HardDrive, Info } from 'lucide-react'
import { WindowCloseToken } from '../ui-api'
import { AboutPage } from './about-page'
import { createPlatformApi } from './api'
import './core-failure-notice.css'
import { CoreFailureNotice, coreFailureVisible } from './core-failure-notice'
import { StoragePage } from './storage-page'
import { WindowButtons } from './window-buttons'
import { createWindowCloseGuard } from './window-close'

/**
 * 开发版判定：vite 的 import.meta.env.DEV；在 bun 测试与其它环境下 import.meta.env 不存在，
 * 此时按“非开发版”处理（更保守：不注册仅开发版才有的命令）。
 */
const IS_DEV: boolean = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true

/* 入口提示的可见性：只有 failed 那一档占位（见 core-failure-notice.tsx）。 */
function useCoreFailureVisible(): boolean {
  return coreFailureVisible(useCoreStatus())
}

export default defineUiFeature({
  id: 'platform',
  setup(ctx) {
    const api = createPlatformApi(ctx)
    // system 契约（core.restart / core.getStatus）由内核拥有：ui-kernel 的 ctx.rpc 无条件放行它
    const system = ctx.rpc(systemContract)
    const navigation = ctx.services.get(NavigationToken) as NavigationService
    const logging = ctx.services.get(UiLoggingToken) as UiLogging
    ctx.services.get(ToastsToken)

    // 内核日志接线：UI 的日志经 platform 的 log.write 落到主日志
    logging.setSink((entries) => {
      void api.logWrite(entries).catch(() => undefined)
    })

    // ── 贡献 ────────────────────────────────────────────────────────
    ctx.contribute(builtinPoints.titleBarItems, {
      id: 'platform.windowButtons',
      align: 'right',
      order: 1000,
      component: () => <WindowButtons api={api} />,
    })

    /*
     * Core 的状态不再有任何「正在启动 Agent 引擎…」横幅（产品负责人 2026-10-06）。
     *
     * 这条横幅整条删除。「正在启动」是应用自己的事，Core 起来之前界面本来也做不了什么；
     * 报在屏幕顶上只会在每次启动时闪出一条横贯整窗的色块 —— 用户报的「退出时顶部栏下方
     * 闪一次 #383836 长方形」正是它的收尾一闪：退出时 Core 走 stopping → stopped，外壳按
     * `stopped` 立刻挂出这一行（底色 `--ui-accent`，深色下就是 #383836），而组件因 3 秒
     * 宽限还没到画不出字 —— 屏幕上于是只剩一条没有字的纯色行。
     *
     * 此前 `restarting`（重连提示）与 `failed`（要人重新启动）也已先后离场：前者删、后者
     * 改成入口提示 —— 与「还没有配置任何模型服务商」同一个样式、同一个位置（吉祥物上方），
     * 见下面那条 entryNotices 贡献。
     */

    /*
     * 引擎起不来（failed）那一格：画在**入口界面吉祥物上方**，与模型未配置那条同形同位。
     *
     * 动作与文案照 07 页 §1E 的表（重新启动 / 打开日志文件夹），容器从横幅行换成入口提示
     * 那一列 —— 与 models 的「还没有配置任何模型服务商」完全一样。
     */
    const openLogsFolder = (): void => {
      // 日志目录 = <数据根>/logs；数据根只有 Host 知道（Windows 专有应用，分隔符固定）
      void api.appInfo().then((info) => api.openPath(`${info.dataRoot}\\logs`))
    }
    ctx.contribute(builtinPoints.entryNotices, {
      id: 'platform.coreFailure',
      order: 10,
      component: () => (
        <CoreFailureNotice onOpenLogs={openLogsFolder} onRestart={() => void system.call('core.restart', {})} />
      ),
      useVisible: useCoreFailureVisible,
    })

    ctx.contribute(builtinPoints.settingsPages, {
      id: 'platform.storage',
      group: SETTINGS_GROUPS.system,
      order: 900,
      title: '存储',
      icon: HardDrive,
      component: () => <StoragePage api={api} />,
    } satisfies SettingsPageItem)

    ctx.contribute(builtinPoints.settingsPages, {
      id: 'platform.about',
      group: SETTINGS_GROUPS.system,
      order: 1000,
      title: '关于',
      icon: Info,
      component: () => <AboutPage api={api} />,
    } satisfies SettingsPageItem)

    const command = (id: string, title: string, run: () => void): void => {
      ctx.contribute(builtinPoints.commands, { id, title, category: '应用', run } satisfies CommandItem)
    }
    command('platform.openDevtools', '打开开发者工具', () => void api.openDevtools())
    command('platform.openDataFolder', '打开数据文件夹', () => void api.openDataFolder())
    if (IS_DEV) {
      command('platform.reload', '重新加载界面', () => window.location.reload())
    }

    const bind = (command_: string, key: string): void => {
      ctx.contribute(builtinPoints.keybindings, { command: command_, key } satisfies KeybindingItem)
    }
    bind('platform.openDevtools', 'Ctrl+Shift+I')
    if (IS_DEV) bind('platform.reload', 'Ctrl+R')
    void navigation

    // ── ui-api：关闭拦截 ────────────────────────────────────────────
    const guard = createWindowCloseGuard(api)
    ctx.services.provide(WindowCloseToken, guard)
    ctx.lifecycle.onDispose(() => {
      guard.bind().dispose()
    })
    guard.bind()
  },
})

export { createPlatformApi, type PlatformApi } from './api'
