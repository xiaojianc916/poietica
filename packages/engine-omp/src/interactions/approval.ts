import type { InteractionAnswer } from '@poietica/engine'
import type { InteractionDraft } from './broker'

/*
 * omp 的授权闸门没有独立 API：它调用 `uiContext.select(formatApprovalPrompt(...), ["Approve", "Deny"])`，
 * 靠**选项集**与标题首行的 `Allow tool:` 来识别。认不出就交回 null，由通用问题那条路处置。
 */

/** 闸门问的那两颗按钮，次序照 omp 的正本 */
export const APPROVAL_OPTIONS: readonly [string, string] = ['Approve', 'Deny']

/** 标题里那一行的前缀；正本 tools/approval.ts 的 formatApprovalPrompt：`Allow tool: ${tool.name}` */
export const APPROVAL_LINE = 'Allow tool:'

/** 产品那两颗按钮里「批准」落到哪一颗 */
export const APPROVE_LABEL: string = APPROVAL_OPTIONS[0]

/** 「拒绝」落到哪一颗；dismiss 也归它（fail closed：没人答就是不批） */
export const DENY_LABEL: string = APPROVAL_OPTIONS[1]

/** 一次授权问话：批准什么（工具名），以及它将要做什么（原样细节） */
export interface ApprovalPrompt {
  readonly tool: string
  /** 那一行之后的全部内容，原样保留不翻译；没有可说的就是 null */
  readonly detail: string | null
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

/*
 * 这道对话框是不是授权闸门。两条同时满足才算：选项恰好是 `Approve` 与 `Deny`（次序无关，多一个少一个都不算
 * —— 上游靠选项集区分，没有独立 method）；标题里有以 `Allow tool:` 开头的行，且冒号后的工具名非空。
 */
export function approvalOf(title: string, options: readonly string[]): ApprovalPrompt | null {
  if (options.length !== APPROVAL_OPTIONS.length) return null
  for (const label of APPROVAL_OPTIONS) {
    if (!options.includes(label)) return null
  }
  const tool = approvalToolOf(title)
  if (tool === null) return null
  return { tool, detail: approvalDetailOf(title) }
}

/** 一次授权问话 → 产品交互草稿（标题是产品说法，工具名与细节各归各格） */
export function approvalInteraction(prompt: ApprovalPrompt): InteractionDraft {
  return {
    kind: 'approval',
    tool: prompt.tool,
    title: `允许使用工具：${prompt.tool}`,
    detail: prompt.detail ?? '',
    allowSessionScope: true,
  }
}

/** 产品答复 → 上游 select 要的那颗按钮；不认识的答复也按 `Deny` —— fail closed，宁可这一次不放行也不误批 */
export function approvalLabelOf(answer: InteractionAnswer): string {
  return answer.kind === 'approval' && answer.decision === 'approve' ? APPROVE_LABEL : DENY_LABEL
}

/** 这一答复是不是「本次会话都放行」；调用方据此 grantToolForSession（写会话 overlay，不落盘） */
export function approvalGrantsSession(answer: InteractionAnswer): boolean {
  return answer.kind === 'approval' && answer.decision === 'approve' && answer.scope === 'session'
}

/** 标题里第一条 `Allow tool:` 行（原样，不 trim） */
function findLine(title: string): string | undefined {
  return title.split('\n').find((entry) => entry.trim().startsWith(APPROVAL_LINE))
}
