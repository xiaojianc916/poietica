import { defineServiceToken, KERNEL_OWNER, type ServiceRegistry } from '@poietica/foundation'
import type { ContributionRegistry } from '../contribution'
import { type CommandService, createCommandService } from './commands'
import { type CoreStatusService, createCoreStatusService } from './core-status'
import { createDialogService, type DialogService } from './dialogs'
import { createKeybindingService, type KeybindingService } from './keybindings'
import { createLayoutService, type LayoutService } from './layout'
import { createUiLogging, type UiLogging } from './logging'
import { createNavigationService, type NavigationService, type Route } from './navigation'
import { createToastService, type ToastService } from './toasts'

export const NavigationToken = defineServiceToken<NavigationService>(KERNEL_OWNER, 'Navigation')
export const CommandsToken = defineServiceToken<CommandService>(KERNEL_OWNER, 'Commands')
export const KeybindingsToken = defineServiceToken<KeybindingService>(KERNEL_OWNER, 'Keybindings')
export const CoreStatusToken = defineServiceToken<CoreStatusService>(KERNEL_OWNER, 'CoreStatus')
export const LayoutToken = defineServiceToken<LayoutService>(KERNEL_OWNER, 'Layout')
export const ToastsToken = defineServiceToken<ToastService>(KERNEL_OWNER, 'Toasts')
export const DialogsToken = defineServiceToken<DialogService>(KERNEL_OWNER, 'Dialogs')
export const UiLoggingToken = defineServiceToken<UiLogging>(KERNEL_OWNER, 'UiLogging')

export interface KernelServices {
  readonly navigation: NavigationService
  readonly commands: CommandService
  readonly keybindings: KeybindingService
  readonly coreStatus: CoreStatusService
  readonly layout: LayoutService
  readonly toasts: ToastService
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
  const toasts = createToastService(o.errorMessages)
  const commands = createCommandService(o.registry, toasts, logging.logger)
  const s: KernelServices = {
    navigation: createNavigationService(o.defaultRoute),
    commands,
    keybindings: createKeybindingService(o.registry, commands),
    coreStatus: createCoreStatusService(),
    layout: createLayoutService(),
    toasts,
    dialogs: createDialogService(),
    logging,
  }
  const k = o.services.kernelScope()
  k.provide(NavigationToken, s.navigation)
  k.provide(CommandsToken, s.commands)
  k.provide(KeybindingsToken, s.keybindings)
  k.provide(CoreStatusToken, s.coreStatus)
  k.provide(LayoutToken, s.layout)
  k.provide(ToastsToken, s.toasts)
  k.provide(DialogsToken, s.dialogs)
  k.provide(UiLoggingToken, s.logging)
  return s
}

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
  type DockPaneSet,
  type DockPanesState,
  LAYOUT_LIMITS,
  type LayoutService,
  type LayoutState,
  type PanelDockState,
  type SplitterActivity,
  type SplitterRegion,
} from './layout'
export { createUiLogging, type UiLogEntry, type UiLogging } from './logging'
export { createNavigationService, type NavigationService, type NavigationState, type Route } from './navigation'
export { createValue, type Observable } from './observable'
export { createToastService, type Toast, type ToastService } from './toasts'
