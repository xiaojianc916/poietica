/// <reference path="./css.d.ts" />

/*
 * 包的公开面。显式罗列而不是 export *：谁在用什么必须一眼可见。
 *
 * 导出清单按 13 页 §4 审查过：对每个导出在 legacy 全仓搜索使用处，没有使用处的导出删除。
 * 已删除（legacy 无任何使用处）：ContextMenu*（整个 control/context-menu.tsx 模块一并删除）、
 * SearchableSelect（连同 .css）、popupPositionerClassName / popupSurfaceClassName（模块保留，
 * 供包内其它控件使用）、Banner 的 BannerAction / BannerProps 类型导出。
 * 样式变量（tokens/*.css）一个都没有改动。
 */

import './control/menu-surface.css'

export { cn } from './class-names'
export {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from './control/accordion'
export { Banner } from './control/banner'
export { Button } from './control/button'
export { CommandMenu, type CommandMenuGroup, type CommandMenuItem } from './control/command-menu'
export { ConfirmationDialog } from './control/confirmation-dialog'
export { Dialog } from './control/dialog'
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
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
  SettingRow,
  type SettingRowProps,
  SettingsGroup,
  type SettingsGroupProps,
  SettingsPage,
  type SettingsPageProps,
  ToggleRow,
  type ToggleRowProps,
} from './settings-primitives'
export {
  applyThemePreference,
  type ResolvedTheme,
  type ThemePreference,
  type ThemePreferenceBinding,
} from './theme/theme-controller'
export { useCopy } from './use-copy'
