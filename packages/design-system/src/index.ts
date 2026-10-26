/*
 * 包的公开面。显式罗列而不是 export *：谁在用什么必须一眼可见。
 *
 * 每个导出都按「全仓有没有使用处」审过一遍，没有使用处的删掉（ContextMenu* 整个模块、
 * SearchableSelect、Banner 的两个类型导出等）；popupPositionerClassName /
 * popupSurfaceClassName 不对外导出但模块保留 —— 包内其它控件在用。tokens/*.css 一个都没改动。
 */

export { cn } from './class-names'
export { Accordion, AccordionHeader, AccordionItem, AccordionPanel, AccordionTrigger } from './control/accordion'
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
export { StateDot, type StateDotState } from './control/state-dot'
export { Switch } from './control/switch'
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './control/tooltip'
export { ViewSwitch, type ViewSwitchOption } from './control/view-switch'
export { type WorkspaceChoice, WorkspacePicker, type WorkspacePickerProps } from './control/workspace-picker'
export { focusOnMount } from './focus-on-mount'
export { formatBytes } from './format-bytes'
export { RegionSplitter, type SplitterActivity } from './layout/region-splitter'
export { FileTypeMark } from './mark/file-type-mark'
export { integrationMarkFor } from './mark/integration-mark'
export { GithubMark } from './mark/local-glyphs'
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
export { FileTree, type FileTreeProps, type FileTreeRow } from './tree/file-tree'
export { type PathTreeFile, type PathTreeFolder, type PathTreeNode, pathTreeRows } from './tree/path-tree'
export { useCopy } from './use-copy'
export { type ViewTransitionOptions, withViewTransition } from './view-transition'
