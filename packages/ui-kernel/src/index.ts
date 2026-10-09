export { createWindowBridgeTransport } from './bridge-transport'
export {
  builtinPoints,
  type CommandItem,
  type DockTabDescriptor,
  type EntryNoticeItem,
  type IconComponent,
  type KeybindingItem,
  type MainControlItem,
  type OverlayItem,
  type PanelDockTabs,
  type PanelItem,
  SETTINGS_GROUPS,
  type SettingsGroupItem,
  type SettingsPageItem,
  type SettingsSectionItem,
  type SidebarSectionItem,
  type StatusItem,
  type SurfaceComponent,
  type SurfaceItem,
  type TitleBarItem,
} from './builtin-points'
export { createUiChannel, type UiChannel } from './channel'
export { type Contributed, type ContributionPoint, ContributionRegistry, defineContributionPoint } from './contribution'
export { defineUiFeature, type UiFeature, type UiFeatureContext } from './feature'
export { createUiKernel, type UiKernel, type UiKernelOptions } from './kernel'
export { FeatureErrorBoundary } from './react/error-boundary'
export {
  useContributions,
  useCoreStatus,
  useLayout,
  useNavigation,
  useObservable,
  useService,
} from './react/hooks'
export { FeatureScope, KernelProvider, useFeatureId, useKernel } from './react/kernel-context'
export {
  type AuxiliaryState,
  type CommandService,
  CommandsToken,
  type CoreStatus,
  CoreStatusToken,
  createValue,
  type DialogService,
  DialogsToken,
  type DockPaneSet,
  type DockPanesState,
  describeError,
  type KernelServices,
  type KeybindingService,
  KeybindingsToken,
  type KeyOverrides,
  type LayoutService,
  type LayoutState,
  LayoutToken,
  type NavigationService,
  type NavigationState,
  NavigationToken,
  normalizeKeyEvent,
  type Observable,
  type Route,
  registerKernelServices,
  type SplitterActivity,
  type SplitterRegion,
  type Toast,
  type ToastService,
  ToastsToken,
  type UiLogEntry,
  type UiLogging,
  UiLoggingToken,
} from './services'
export {
  createFeatureStore,
  type FeatureStore,
  useFeatureStore,
  useFeatureStoreShallow,
} from './store'
