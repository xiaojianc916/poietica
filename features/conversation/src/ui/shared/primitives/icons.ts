import { createElement, type FunctionComponent, type SVGProps } from 'react'

/* 语义命名到字形的映射表，手工维护：库里改名或删掉某个字形，下面的 re-export 会直接编译失败。 */

/*
 * lucide 字形被当「值」填进别的库的图标槽、存进表时，与 React 的 SVGProps 不兼容（stroke 是
 * string | number；exactOptionalPropertyTypes 下「不传」与「传 undefined」是两件事），所以出境面用本仓的形状。
 */
export type IconProps = SVGProps<SVGSVGElement> & { readonly size?: number }

export type Icon = FunctionComponent<IconProps>

/* 按「没有就不传」转发：显式传 undefined 与压根不传在 exactOptionalPropertyTypes 之下是两件事。 */
export function asIcon(glyph: FunctionComponent<{ className?: string; size?: number }>): Icon {
  return ({ className, size }) =>
    createElement(glyph, {
      ...(className === undefined ? {} : { className }),
      ...(size === undefined ? {} : { size }),
    })
}

export {
  Archive as ArchiveIcon,
  ArrowDown as ToLatestIcon,
  ArrowUp as SubmitIcon,
  Atom as ThinkingIcon,
  BookOpenText as FileIcon,
  Brain as BrainIcon,
  BrainCircuit as LearningIcon,
  Bug as BugIcon,
  CalendarDays as PreviewIcon,
  Check as CheckIcon,
  CheckCheck as CheckCheckIcon,
  ChevronDown as ChevronDownIcon,
  ChevronUp as ChevronUpIcon,
  CircleAlert as FailureIcon,
  CircleDotDashed as YieldIcon,
  CircleQuestionMark as QuestionIcon,
  Code as CodeIcon,
  Computer as ComputerIcon,
  Copy as CopyIcon,
  Download as DownloadIcon,
  Ellipsis as MoreIcon,
  FolderPlus as FolderPlusIcon,
  FoldVertical as CompactionIcon,
  Globe as GlobeIcon,
  Image as ImageIcon,
  Layers as ToolIcon,
  ListTodo as PlanIcon,
  LoaderCircle as SpinnerIcon,
  Mic as MicIcon,
  MousePointerClick as ElementIcon,
  Paperclip as AttachIcon,
  Pencil as PencilIcon,
  Pin as PinIcon,
  Play as ResumeIcon,
  Plus as PlusIcon,
  RefreshCw as ResetIcon,
  RotateCcwSquare as DeviceIcon,
  RotateCwFadingClock as ClockIcon,
  ScanSearch as ModelIcon,
  ScanSearch as SwarmIcon,
  Search as SearchIcon,
  Send as AgentIcon,
  Siren as SirenIcon,
  Square as StopIcon,
  SquareDashedBottomCode as LspIcon,
  SquarePen as ComposeIcon,
  SquareTerminal as TerminalIcon,
  Target as GoalIcon,
  Trash2 as TrashIcon,
  TriangleAlert as WarningIcon,
  Unplug as PluginIcon,
  WandSparkles as WandIcon,
  Wifi as LinkIcon,
  Wifi as RetryIcon,
  WifiOff as RetryFailedIcon,
  X as CloseIcon,
  Zap as QueueSteerIcon,
  Zap as SkillIcon,
  ZoomIn as ZoomInIcon,
  ZoomOut as ZoomOutIcon,
} from 'lucide-react'
