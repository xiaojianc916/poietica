import { createElement, type FunctionComponent, type SVGProps } from 'react'

/*
 * 语义命名到字形的唯一映射表，手工维护。
 *
 * 别名与图标库的一致性由 typecheck 保证：库里改名或删掉某个字形，下面的
 * re-export 会直接编译失败。
 */

/*
 * 一个图标在这个应用里是什么形状。
 *
 * 下面那些 re-export 只换了名字，没换主人：交出去的仍是图标库自己的 props 类型。
 * 图标只写在 JSX 里的时候看不出区别；一旦它被当成「值」交出去 —— 填进别的库的图标
 * 槽、存进一张表 —— 那个类型就跟着出境，而它与 React 的 SVGProps 并不兼容：库把
 * stroke 声明成 string | number，React 的可选属性读出来是 string | undefined。
 * exactOptionalPropertyTypes 打开时「可以不传」与「可以传 undefined」是两件事，
 * 函数参数又是逆变的，于是一个不肯收 undefined 的组件填不进一个会传 undefined 的槽。
 *
 * 运行时没有这回事：React 遇到值为 undefined 的属性就不写它。所以这里要的不是转换，
 * 是给出境的那一面一个本仓说了算的形状 —— 与 @poietica/ui 的本地字形同一个形状。
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
  ArrowUp as SubmitIcon,
  Atom as ThinkingIcon,
  BookOpenText as FileIcon,
  CalendarDays as PreviewIcon,
  Check as CheckIcon,
  ChevronDown as ChevronDownIcon,
  CircleAlert as FailureIcon,
  Code as CodeIcon,
  Copy as CopyIcon,
  Download as DownloadIcon,
  Ellipsis as MoreIcon,
  FolderPlus as FolderPlusIcon,
  Forward as ForwardIcon,
  Globe as GlobeIcon,
  GripVertical as DragHandleIcon,
  Layers as ToolIcon,
  ListTodo as PlanIcon,
  LoaderCircle as SpinnerIcon,
  Maximize as MaximizeIcon,
  MessageCircle as ThreadIcon,
  Paperclip as AttachIcon,
  Pencil as PencilIcon,
  Pin as PinFilledIcon,
  Pin as PinIcon,
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
  Zap as SkillIcon,
  ZoomIn as ZoomInIcon,
  ZoomOut as ZoomOutIcon,
} from 'lucide-react'
