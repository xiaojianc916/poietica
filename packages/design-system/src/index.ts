/*
 * 包的公开面。显式罗列而不是 export *：谁在用什么必须一眼可见。
 *
 * 每个导出都按「全仓有没有使用处」审过一遍，没有使用处的删掉（ContextMenu* 整个模块、
 * SearchableSelect、Banner 的两个类型导出等）；popupPositionerClassName /
 * popupSurfaceClassName 不对外导出但模块保留 —— 包内其它控件在用。tokens/*.css 一个都没改动。
 */

export { cn } from './class-names'
export {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from './control/accordion'
export { Banner } from './control/banner'
export { GitBranchPicker, type GitBranchPickerProps } from './control/branch-picker'
export { Button } from './control/button'
export { CommandMenu, type CommandMenuGroup, type CommandMenuItem } from './control/command-menu'
export { ConfirmationDialog } from './control/confirmation-dialog'
export { Dialog } from './control/dialog'
export {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRadioItemIndicator,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './control/dropdown-menu'
export { ErrorState, InlineSpinner, LoadingState } from './control/feedback'
export { SegmentedControl, type SegmentedOption } from './control/segmented-control'
export { Select, type SelectOption } from './control/select'
export { Switch } from './control/switch'
export { ToastRegion } from './control/toast'
export {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './control/tooltip'
export { type WorkspaceChoice, WorkspacePicker, type WorkspacePickerProps } from './control/workspace-picker'
export { focusOnMount } from './focus-on-mount'
export { formatBytes } from './format-bytes'
export {
  RegionSplitter,
  type SplitterActivity,
} from './layout/region-splitter'
export { FileTypeMark } from './mark/file-type-mark'
export { integrationMarkFor } from './mark/integration-mark'
export { GithubMark } from './mark/local-glyphs'
export { PixelLoader } from './mark/pixel-loader'
export { POIETICA_MARK_PATH, PoieticaMark } from './mark/poietica-mark'
export {
  type OverlayKind,
  type OverlayPresence,
  overlaysOnScreen,
  registerOverlay,
  subscribeOverlays,
  useModalOverlay,
  useOverlayRef,
} from './overlay-presence'
export {
  SettingRow,
  type SettingRowProps,
  SettingsGroup,
  type SettingsGroupProps,
  SettingsPage,
  type SettingsPageProps,
  ToggleRow,
  type ToggleRowProps,
} from './settings-primitives'
export { useCopy } from './use-copy'
