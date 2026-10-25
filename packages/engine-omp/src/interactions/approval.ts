import type { InteractionAnswer } from '@poietica/engine'
import type { InteractionDraft } from './broker'

/*
 * omp 的授权闸门有两条入口：18.11.3 起正式的 uiContext.approve(...)，与没有实现 approve 的宿主
 * 走 uiContext.select(full, approvalChoiceLabels(...)) 的回退。两条都靠标题首行的 `Allow tool:` 与
 * 选项集来认。回退那条的选项**不再恒为两颗按钮**（有 sessionSubject 或 grants 时各有第三、四颗），
 * 认不出就交回 null，由通用问题那条路处置。
 */

/** 回退 select 里「只批这一次」的两种可能标签：omp 的 approvalOnceLabel 有 grants 时用前者，否则用后者 */
export const APPROVE_LABEL = 'Approve'
export const APPROVE_ONCE_LABEL = 'Approve Once'

/** 「拒绝」那颗按钮；dismiss 也归它（fail closed：没人答就是不批） */
export const DENY_LABEL = 'Deny'

/** 标题里那一行的前缀；正本 tools/approval.ts 的 formatApprovalPrompt：`Allow tool: ${tool.name}` */
export const APPROVAL_LINE = 'Allow tool:'

/** 一次授权问话：批准什么（工具名）、它将要做什么（原样细节），以及这次对话框给了哪些答复 */
export interface ApprovalPrompt {
  readonly tool: string
  /** 那一行之后的全部内容，原样保留不翻译；没有可说的就是 null */
  readonly detail: string | null
  /** 「只批这一次」那颗按钮的标签：回退 select 里是 `Approve` 或 `Approve Once` */
  readonly onceLabel: string
  /** 「本次会话都放行」那颗按钮的标签；omp 没给这一档时是 null（产品不编一个上游不认的答复） */
  readonly sessionLabel: string | null
}

/** 第一条以 `Allow tool:` 开头的行冒号后的内容，取不到就是 null。认不出时**不编**一个名字：那一格既是屏幕上的说法、也是会话级放行的设置键 */
export function approvalToolOf(title: string): string | null {
  const line = findLine(title)
  if (line === undefined) return null
  const tool = line.trim().slice(APPROVAL_LINE.length).trim()
  return tool === '' ? null : tool
}

/* 「要不要允许 Bash」回答不了任何问题：人要知道的是**将跑哪条命令**。omp 把工具自报的细节（bash 的 `Command: …`、write 的路径）逐行拼在 `Allow tool: <name>` 之后 */
export function approvalDetailOf(title: string): string | null {
  const lines = title.split('\n')
  const at = lines.findIndex((line) => line.trim().startsWith(APPROVAL_LINE))
  const said = (at === -1 ? title : lines.slice(at + 1).join('\n')).trim()
  return said === '' ? null : said
}

/** omp 回退 select 里「本次会话都放行」的标签形状：`Approve <subject> for this session` */
const SESSION_SUFFIX = ' for this session'

/** 选项里那一颗「本次会话都放行」；没有就是 null */
function sessionLabelOf(options: readonly string[], onceLabel: string): string | null {
  for (const label of options) {
    if (label === onceLabel) continue
    if (label.startsWith('Approve ') && label.endsWith(SESSION_SUFFIX)) return label
  }
  return null
}

/*
 * 这道对话框是不是授权闸门（判据次序无关）：标题里有 `Allow tool:` 开头的行且工具名非空；
 * 选项里同时有 Deny 与一颗「只批这一次」按钮。多出来的 grant / session 标签不挡识别 ——
 * 产品表达不了 always/folder 授权，但只要能答「只批这一次」就仍然问得下去。没有 once 按钮的
 * 认不出，交回 null：不把一次批准冒充成上游没提供的会话放行，也不伪造 `{ grant, always }`。
 */
export function approvalOf(title: string, options: readonly string[]): ApprovalPrompt | null {
  const tool = approvalToolOf(title)
  if (tool === null) return null
  if (!options.includes(DENY_LABEL)) return null
  const onceLabel = options.includes(APPROVE_ONCE_LABEL)
    ? APPROVE_ONCE_LABEL
    : options.includes(APPROVE_LABEL)
      ? APPROVE_LABEL
      : null
  if (onceLabel === null) return null
  return {
    tool,
    detail: approvalDetailOf(title),
    onceLabel,
    sessionLabel: sessionLabelOf(options, onceLabel),
  }
}

/**
 * 一次授权问话 → 产品交互草稿（标题是产品说法，工具名与细节各归各格）。
 *
 * `allowSessionScope` 由调用方定：
 * - select 回退这条一直允许「本次会话都放行」—— 那是写本产品的 tools.approval overlay，上游不需要先给这一档；
 * - approve 正式入口按 prompt.session 是否有值来定（没有这一档就不给产品画一颗上游不认的按钮）。
 */
export function approvalInteraction(
  prompt: ApprovalPrompt,
  options: { readonly allowSessionScope?: boolean } = {},
): InteractionDraft {
  return {
    kind: 'approval',
    tool: prompt.tool,
    title: `允许使用工具：${prompt.tool}`,
    detail: prompt.detail ?? '',
    allowSessionScope: options.allowSessionScope ?? true,
  }
}

/** 产品答复 → 上游 select 要的那颗按钮；不认识的答复也按 `Deny` —— fail closed，宁可这一次不放行也不误批 */
export function approvalLabelOf(answer: InteractionAnswer, prompt: ApprovalPrompt): string {
  if (answer.kind !== 'approval' || answer.decision !== 'approve') return DENY_LABEL
  /*
   * 人答了「本次会话都批」时优先交回上游的会话标签；上游没给这一档（只有两颗按钮 / 只有 grants）就退回
   * 「只批这一次」—— 会话级放行由本产品自己的 tools.approval overlay 记住，不靠上游那句标签。
   */
  if (answer.scope === 'session' && prompt.sessionLabel !== null) return prompt.sessionLabel
  return prompt.onceLabel
}

/** 这一答复是不是「本次会话都放行」；调用方据此 grantToolForSession（写会话 overlay，不落盘） */
export function approvalGrantsSession(answer: InteractionAnswer): boolean {
  return answer.kind === 'approval' && answer.decision === 'approve' && answer.scope === 'session'
}

/** 标题里第一条 `Allow tool:` 行（原样，不 trim） */
function findLine(title: string): string | undefined {
  return title.split('\n').find((entry) => entry.trim().startsWith(APPROVAL_LINE))
}
