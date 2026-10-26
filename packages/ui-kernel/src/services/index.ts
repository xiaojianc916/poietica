import { defineServiceToken, KERNEL_OWNER, type ServiceRegistry } from '@poietica/foundation'
import { builtinPoints } from '../builtin-points'
import type { ContributionRegistry } from '../contribution'
import { type BannerService, createBannerService } from './banners'
import { type CommandService, createCommandService } from './commands'
import { type CoreStatusService, createCoreStatusService } from './core-status'
import { createDialogService, type DialogService } from './dialogs'
import { createKeybindingService, type KeybindingService } from './keybindings'
import { createLayoutService, type LayoutService } from './layout'
import { createUiLogging, type UiLogging } from './logging'
import { createNavigationService, type NavigationService, type Route, type RouteTransition } from './navigation'

export const NavigationToken = defineServiceToken<NavigationService>(KERNEL_OWNER, 'Navigation')
export const CommandsToken = defineServiceToken<CommandService>(KERNEL_OWNER, 'Commands')
export const KeybindingsToken = defineServiceToken<KeybindingService>(KERNEL_OWNER, 'Keybindings')
export const CoreStatusToken = defineServiceToken<CoreStatusService>(KERNEL_OWNER, 'CoreStatus')
export const LayoutToken = defineServiceToken<LayoutService>(KERNEL_OWNER, 'Layout')
export const BannersToken = defineServiceToken<BannerService>(KERNEL_OWNER, 'Banners')
export const DialogsToken = defineServiceToken<DialogService>(KERNEL_OWNER, 'Dialogs')
export const UiLoggingToken = defineServiceToken<UiLogging>(KERNEL_OWNER, 'UiLogging')

export interface KernelServices {
  readonly navigation: NavigationService
  readonly commands: CommandService
  readonly keybindings: KeybindingService
  readonly coreStatus: CoreStatusService
  readonly layout: LayoutService
  readonly banners: BannerService
  readonly dialogs: DialogService
  readonly logging: UiLogging
}

export function registerKernelServices(o: {
  registry: ContributionRegistry
  services: ServiceRegistry
  errorMessages: Readonly<Record<string, string>>
  defaultRoute: Route
  /** 换路由的外层过渡，组合根注入（内核不认识 design-system）。缺省即直落。 */
  routeTransition?: RouteTransition
}): KernelServices {
  const logging = createUiLogging()
  const banners = createBannerService(o.errorMessages)
  const commands = createCommandService(o.registry, banners, logging.logger)
  const s: KernelServices = {
    navigation: createNavigationService(o.defaultRoute, o.routeTransition),
    commands,
    keybindings: createKeybindingService(o.registry, commands),
    coreStatus: createCoreStatusService(),
    /* 面板的归属类别只登记在贡献里：布局服务开格前按 id 回查，设置页里开不出对话的面板，反之亦然。 */
    layout: createLayoutService({
      scopeOf: (panelId) => {
        const found = o.registry.list(builtinPoints.panels).find((c) => c.item.id === panelId)
        return found === undefined ? undefined : (found.item.scope ?? 'surface')
      },
    }),
    banners,
    dialogs: createDialogService(),
    logging,
  }
  const k = o.services.kernelScope()
  k.provide(NavigationToken, s.navigation)
  k.provide(CommandsToken, s.commands)
  k.provide(KeybindingsToken, s.keybindings)
  k.provide(CoreStatusToken, s.coreStatus)
  k.provide(LayoutToken, s.layout)
  k.provide(BannersToken, s.banners)
  k.provide(DialogsToken, s.dialogs)
  k.provide(UiLoggingToken, s.logging)
  return s
}

export { type BannerNotice, type BannerService, type BannerSeverity, createBannerService } from './banners'
export { type CommandService, createCommandService } from './commands'
export { type CoreStatus, type CoreStatusService, createCoreStatusService } from './core-status'
export { type ConfirmRequest, createDialogService, type DialogService } from './dialogs'
export { type DescribedError, describeError } from './errors'
export { createKeybindingService, type KeybindingService, type KeyOverrides, normalizeKeyEvent } from './keybindings'
export {
  type AuxiliaryState,
  createLayoutService,
  DEFAULT_LAYOUT,
  DEFAULT_PANEL_WIDTH,
  type DockPaneSet,
  type DockPanesState,
  isSettingsDockOwner,
  LAYOUT_LIMITS,
  type LayoutGeometry,
  type LayoutService,
  type LayoutServiceOptions,
  type LayoutState,
  type PanelDockState,
  type PanelScope,
  panelAdmits,
  type RegionGeometry,
  resolveLayoutGeometry,
  type SettingsDockOwner,
  type SplitterActivity,
  type SplitterRegion,
  settingsDockOwner,
} from './layout'
export { createUiLogging, type UiLogEntry, type UiLogging } from './logging'
export {
  createNavigationService,
  type NavigationService,
  type NavigationState,
  ROUTE_TRANSITION_TYPE,
  type Route,
  type RouteTransition,
} from './navigation'
export { createValue, type Observable } from './observable'
