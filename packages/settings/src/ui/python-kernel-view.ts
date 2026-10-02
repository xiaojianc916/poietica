import type { PythonKernelState, PythonKernelStatus } from './python-kernel/gateway'

/*
 * 状态到文案的那一处映射：进来的是原生侧报的那一份，出去的是这一格该说什么、
 * 该给哪颗按钮。不认识 React，也不发请求 —— 所以它能被逐档断言。
 */

/** 这一格此刻该给用户看的字。 */
export interface PythonKernelCopy {
  readonly description: string
  /** 失败原因，排在任何状态说明之前；没有失败就是 null。 */
  readonly failure: string | null
  /** 第二行的标题；没有细节可报时与 detail 一起是 null。 */
  readonly detailLabel: string | null
  /** 第二行的内容：当前这一步，或版本与安装位置。 */
  readonly detail: string | null
}

export type PythonKernelActionKind = 'none' | 'install' | 'repair' | 'remove'

export interface PythonKernelAction {
  readonly kind: PythonKernelActionKind
  /** 按钮上的字；kind 是 none 时为空串。 */
  readonly label: string
  /** 按下去会付出什么代价；null 即没有代价要说。 */
  readonly warning: string | null
}

const READ_FAILED = '读到的状态这一版界面认不出来；升级 Poietica 后再看这一页。'
const REMOVE_WARNING = '删除会连同 agent 设置里的 python.interpreter 一起清空；下次要用得重新安装。'
const UNKNOWN_STEP = '正在准备解释器'

const DESCRIPTIONS: Readonly<Record<PythonKernelState, string>> = {
  notInstalled: '让 agent 用它自带的 Python 跑代码，不必另装一个解释器',
  installing: '正在准备解释器，这一步只发生一次',
  ready: '已就绪；agent 跑 Python 代码时用这一份解释器',
  broken: '这份安装不完整，解释器起不来',
  unsupported: '内置 Python 内核只在 Windows 上提供',
}

/*
 * 装机那四步的人话。step 由原生侧给（resolve / download / promote / setting），认不出的
 * 原样显示 —— 编一句「正在准备」盖掉它，排障时就没有线索了。
 */
const STEP_COPY: Readonly<Record<string, string>> = {
  resolve: '正在取上游的资产清单',
  download: '正在下载解释器（约 22MB）',
  promote: '正在解包并校验',
  setting: '正在把解释器路径写给 agent',
}

interface ActionCopy {
  readonly kind: PythonKernelActionKind
  readonly label: string
  readonly warning: string | null
}

const ACTIONS: Readonly<Record<PythonKernelState, ActionCopy>> = {
  notInstalled: { kind: 'install', label: '安装', warning: null },
  installing: { kind: 'none', label: '', warning: null },
  ready: { kind: 'remove', label: '删除', warning: REMOVE_WARNING },
  broken: { kind: 'repair', label: '重新安装', warning: null },
  unsupported: { kind: 'none', label: '', warning: null },
}

/**
 * 五档 + 一个兜底。
 *
 * 生成的绑定只保证编译期有哪几种取值，运行时那一份是跨越了进程边界的 JSON：线上多出
 * 一档时这里如实说认不出来，而不是把它当某一档画 —— 说错的状态比不说的状态有害得多。
 */
export function pythonKernelCopy(status: PythonKernelStatus | null): PythonKernelCopy {
  if (status === null) {
    return {
      description: '正在读取本机 Python 内核的状态…',
      failure: null,
      detail: null,
      detailLabel: null,
    }
  }

  const failure = status.install.error === null ? null : failureText(status.install.error)

  if (!Object.hasOwn(DESCRIPTIONS, status.state)) {
    return { description: READ_FAILED, detail: null, detailLabel: null, failure }
  }

  const detail = detailOf(status)

  return {
    description: DESCRIPTIONS[status.state],
    failure,
    detail: detail.value,
    detailLabel: detail.label,
  }
}

interface Detail {
  readonly label: string | null
  readonly value: string | null
}

function detailOf(status: PythonKernelStatus): Detail {
  if (status.state === 'installing') {
    return { label: '当前步骤', value: stepCopy(status.install.step) }
  }

  if (status.state === 'broken') {
    return status.path === null ? EMPTY_DETAIL : { label: '安装位置', value: status.path }
  }

  if (status.state !== 'ready') {
    return EMPTY_DETAIL
  }

  /* 就绪才报版本：坏树上挂个版本号是把「装过」当成「能用」。 */
  const parts = [status.version === null ? null : `Python ${status.version}`, status.path].filter(
    (part): part is string => part !== null && part.length > 0,
  )

  return parts.length === 0 ? EMPTY_DETAIL : { label: '已安装', value: parts.join(' · ') }
}

const EMPTY_DETAIL: Detail = { label: null, value: null }

function stepCopy(step: string | null): string {
  if (step === null || step.length === 0) {
    return UNKNOWN_STEP
  }

  return STEP_COPY[step] ?? `正在${step}`
}

/** 失败原因原样上屏：那是排障唯一拿得到的那句话。前缀只加一次。 */
export function failureText(reason: string): string {
  const detail = reason.trim().replace(/^(?:安装失败[：:]\s*)+/u, '')

  return `安装失败：${detail === '' ? '上游没有报出失败原因。' : detail}`
}

/**
 * 这一格此刻的那颗按钮。
 *
 * 未读到、正在装、本平台不支持三档都不给按钮：前两档还没有结论，后一档没有可装的
 * 版本 —— 给一颗能点的按钮，点下去都不是用户想要的那件事。
 */
export function pythonKernelAction(status: PythonKernelStatus | null): PythonKernelAction {
  if (status === null || status.state === 'installing' || status.install.running) {
    return { kind: 'none', label: '', warning: null }
  }

  return ACTIONS[status.state] ?? { kind: 'install', label: '安装', warning: null }
}
