import { createElement, type FunctionComponent, type SVGProps } from 'react'

/*
 * 语义命名到字形的唯一映射表，手工维护。
 *
 * 别名与图标库的一致性由 typecheck 保证：库里改名或删掉某个字形，下面的
 * re-export 会直接编译失败。
 */

/*
 * 一个图标在这个应用里是什么形状。re-export 只换名字，交出去的仍是图标库自己的
 * props 类型；一旦被当「值」出境（填进别的库的图标槽、存进表），它就与 React 的
 * SVGProps 不兼容：lucide 把 stroke 声明成 string | number，React 可选属性读出来是
 * string | undefined，exactOptionalPropertyTypes 下「不传」与「传 undefined」是两件事，
 * 函数参数又是逆变的。所以出境面要有本仓说了算的形状
 * （与 @poietica/design-system 的本地字形同一个形状）。
 */
export type IconProps = SVGProps<SVGSVGElement> & { readonly size?: number }

export type Icon = FunctionComponent<IconProps>

/*
 * 把一枚字形收进上面那个形状。
 *
 * 按「没有就不传」转发：显式传 undefined 与压根不传，在 exactOptionalPropertyTypes
 * 之下正是要分开的那两件事。只转发字形认得的那两样，其余由样式表决定。
 */
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
  CalendarDays as PreviewIcon,
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  ChevronUp as ChevronUpIcon,
  CircleAlert as FailureIcon,
  Clock as FollowUpIcon,
  Code as CodeIcon,
  Copy as CopyIcon,
  Download as DownloadIcon,
  Ellipsis as MoreIcon,
  FolderPlus as FolderPlusIcon,
  Globe as GlobeIcon,
  Hourglass as WaitIcon,
  Layers as ToolIcon,
  ListChecks as AllAtOnceIcon,
  ListOrdered as OneAtATimeIcon,
  ListTodo as PlanIcon,
  LoaderCircle as SpinnerIcon,
  MessageSquare as SteerIcon,
  MousePointerClick as ElementIcon,
  Octagon as HaltIcon,
  Paperclip as AttachIcon,
  Pencil as PencilIcon,
  Pin as PinIcon,
  Play as ResumeIcon,
  Plus as PlusIcon,
  RefreshCw as ResetIcon,
  ScanSearch as ModelIcon,
  ScanSearch as SwarmIcon,
  Search as SearchIcon,
  Send as AgentIcon,
  Siren as SirenIcon,
  Square as StopIcon,
  SquareTerminal as TerminalIcon,
  Target as GoalIcon,
  Wifi as LinkIcon,
  X as CloseIcon,
  Zap as InterruptIcon,
  Zap as SkillIcon,
  ZoomIn as ZoomInIcon,
  ZoomOut as ZoomOutIcon,
} from 'lucide-react'
