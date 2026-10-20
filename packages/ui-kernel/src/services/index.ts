import { defineServiceToken, KERNEL_OWNER, type ServiceRegistry } from '@poietica/foundation'
import type { ContributionRegistry } from '../contribution'
import { type BannerService, createBannerService } from './banners'
import { type CommandService, createCommandService } from './commands'
import { type CoreStatusService, createCoreStatusService } from './core-status'
import { createDialogService, type DialogService } from './dialogs'
import { createKeybindingService, type KeybindingService } from './keybindings'
import { createLayoutService, type LayoutService } from './layout'
import { createUiLogging, type UiLogging } from './logging'
import { createNavigationService, type NavigationService, type Route } from './navigation'

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
}): KernelServices {
  const logging = createUiLogging()
  const banners = createBannerService(o.errorMessages)
  const commands = createCommandService(o.registry, banners, logging.logger)
  const s: KernelServices = {
    navigation: createNavigationService(o.defaultRoute),
    commands,
    keybindings: createKeybindingService(o.registry, commands),
    coreStatus: createCoreStatusService(),
    layout: createLayoutService(),
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
export {
  createKeybindingService,
  type KeybindingService,
  type KeyOverrides,
  normalizeKeyEvent,
} from './keybindings'
export {
  type AuxiliaryState,
  createLayoutService,
  DEFAULT_LAYOUT,
  DEFAULT_PANEL_WIDTH,
  type DockPaneSet,
  type DockPanesState,
  LAYOUT_LIMITS,
  type LayoutGeometry,
  type LayoutService,
  type LayoutState,
  type PanelDockState,
  type RegionGeometry,
  resolveLayoutGeometry,
  type SplitterActivity,
  type SplitterRegion,
} from './layout'
export { createUiLogging, type UiLogEntry, type UiLogging } from './logging'
export { createNavigationService, type NavigationService, type NavigationState, type Route } from './navigation'
export { createValue, type Observable } from './observable'
