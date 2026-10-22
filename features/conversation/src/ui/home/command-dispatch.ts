import type { BannerService, CommandService, DialogService } from '@poietica/ui-kernel'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Thread } from '../../contract'
import type { SlashCommandContribution } from '../../ui-api'
import type { ControlsOpenRequest, PromptInputMessage } from '../composer'
import { PLAN_CONTROL_ID, PLAN_DISABLED, PLAN_ENABLED } from '../session'
import { commandArgsOf, commandNameOf, findCommand, type ThreadCommands } from '../shared/model/commands'
import type { SessionConfigControl } from '../shared/model/config'
import type { ChatStatus } from '../shared/model/run'
import type { SessionUsage } from '../shared/model/usage'
import {
  type AvailableCommand,
  availableCommands,
  type CommandContext,
  type CommandPlace,
  type CommandResolution,
  type NativeAction,
  resolveCommand,
} from './command-manifest'

/*
 * 斜杠命令的分发收在这一处，不摊进 AssistantSurface。命令只有一个入口：草稿里的 `/名字`（手打回车，
 * 或在斜杠面板里选中 —— 面板把整句放回草稿再提交，到这里是同一句话）。
 *
 * 结果各回各的地方，不再全挤进输入框上方那一块：
 *   - 打开控件（模型卡、上下文面板、改名框、任务浮层）与打开设置页 —— 那个控件 / 那一页就是结果；
 *   - 要人确认的（分享会生成一条任何人可打开的链接）—— 确认弹窗；
 *   - omp 说的话（「已开启快速模式」「当前模型不支持慢速模式」）、此刻办不了的原因 —— 横幅，色调随成败；
 *   - 交给模型的（/review、文件命令）—— 时间线上那一轮。
 */

/* 带补救动作的横幅多留一会儿：人要有时间读完再去点 */
const REMEDY_HOLD_MS = 8_000
/* 自动生成标题最多等这么久：omp 走一次小模型，正常几秒；超时只收回「正在生成」，标题到了照样换 */
const TITLING_TIMEOUT_MS = 30_000

export interface SlashCommandsInput {
  readonly commands: ThreadCommands | undefined
  readonly contributed: readonly SlashCommandContribution[]
  readonly isNew: boolean
  readonly status: ChatStatus
  readonly controls: readonly SessionConfigControl[]
  readonly controlsPending: boolean | undefined
  readonly thread: Thread | undefined
  readonly usage: SessionUsage | undefined
  readonly endpoint: string
  readonly todo: { set(next: string | null): void } | undefined
  readonly onRenameThread: ((threadId: string, title: string) => void) | undefined
  readonly onExportThread: ((threadId: string) => void) | undefined
  readonly onShareThread: ((threadId: string) => void) | undefined
  readonly onSelectControl: (controlId: string, value: string) => void
  /** 命令没执行（此刻办不了）时把原句放回输入框：人敲的字不该因为一次「不行」就没了 */
  readonly restore: (text: string) => void
  readonly services: {
    readonly banners: BannerService
    readonly dialogs: DialogService
    readonly commands: CommandService
  }
}

export interface SlashCommandsView {
  /** 面板此刻该列的命令（已按场所筛过） */
  readonly list: readonly AvailableCommand[]
  /** 这句话是不是命令、并且已经办了：true = 不要再当一句话发给模型 */
  readonly route: (message: Omit<PromptInputMessage, 'queued'>) => boolean
  readonly modelPickerRequest: ControlsOpenRequest | undefined
  readonly contextPanelRequest: number | undefined
  readonly renameRequest: number | undefined
  /** 正在按对话内容生成标题 */
  readonly titling: boolean
  /** 时间线上「重试」那一钮：只是 `/retry` 的快捷方式，有这条命令才给 */
  readonly retry: (() => void) | undefined
}

const BUSY: readonly ChatStatus[] = ['submitted', 'streaming', 'queued', 'cancelling']

function placeOf(isNew: boolean, status: ChatStatus): CommandPlace {
  if (isNew) return 'draft'
  return BUSY.includes(status) ? 'busy' : 'idle'
}

/** 在一张选项表里认人敲的那个词：原词或名字相等优先，否则唯一的包含命中；认不出 / 不唯一交回 null */
export function pickChoice(control: SessionConfigControl | undefined, wanted: string): string | null {
  if (control === undefined) return null
  const query = wanted.trim().toLowerCase()
  const exact = control.choices.find(
    (choice) => choice.value.toLowerCase() === query || choice.label.toLowerCase() === query,
  )
  if (exact !== undefined) return exact.value
  const hits = control.choices.filter(
    (choice) => choice.value.toLowerCase().includes(query) || choice.label.toLowerCase().includes(query),
  )
  return hits.length === 1 ? (hits[0]?.value ?? null) : null
}

/** 计划模式的参数：开 / 关；不写就是切换 */
function planValueOf(args: string, control: SessionConfigControl | undefined): string | null {
  const word = args.trim().toLowerCase()
  if (word === '') return control?.current === PLAN_ENABLED ? PLAN_DISABLED : PLAN_ENABLED
  if (['on', '开', '开启'].includes(word)) return PLAN_ENABLED
  if (['off', '关', '关闭'].includes(word)) return PLAN_DISABLED
  return null
}

/* 横幅上的补救动作：改名没成给「手动改名」；多行输出（扩展命令的报表）横幅只放得下第一行，给「复制全部输出」 */
function remedyOf(
  output: NonNullable<ThreadCommands['output']>,
  lines: number,
  openRename: () => void,
): { readonly label: string; readonly run: () => void } | undefined {
  if (output.command.startsWith('/rename') && (output.tone === 'warning' || output.tone === 'error')) {
    return { label: '手动改名', run: openRename }
  }
  if (lines > 1) return { label: '复制全部输出', run: () => void navigator.clipboard.writeText(output.text) }
  return undefined
}

/** 最近一句命令输出 → 横幅（色调由引擎适配器定）。/rename 回了话就收回「正在生成标题」 */
function useOutputBanner(
  output: ThreadCommands['output'],
  banners: BannerService,
  hooks: { readonly onRenameOutput: () => void; readonly openRename: () => void },
): void {
  const shown = useRef(output?.seq)
  const { onRenameOutput, openRename } = hooks
  useEffect(() => {
    if (output === null || output.seq === shown.current) return
    shown.current = output.seq
    if (output.command.startsWith('/rename')) onRenameOutput()
    const lines = output.text.split('\n').filter((line) => line.trim() !== '')
    const [first = output.text] = lines
    const action = remedyOf(output, lines.length, openRename)
    banners.show({
      severity: output.tone,
      title: lines.length > 1 ? `${first}（共 ${lines.length} 行）` : first,
      ...(action === undefined ? {} : { action, holdMs: REMEDY_HOLD_MS }),
    })
  }, [banners, onRenameOutput, openRename, output])
}

/** 「正在生成标题」：开始于不带标题的 /rename，收于新标题到了、omp 回了话、或超时 */
function useTitling(title: string | undefined) {
  const [titling, setTitling] = useState(false)
  const [seenTitle, setSeenTitle] = useState(title)
  if (seenTitle !== title) {
    setSeenTitle(title)
    if (titling) setTitling(false)
  }
  useEffect(() => {
    if (!titling) return
    const timer = setTimeout(() => setTitling(false), TITLING_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [titling])
  const begin = useCallback(() => setTitling(true), [])
  const end = useCallback(() => setTitling(false), [])
  return { titling, begin, end }
}

type Requests = {
  readonly model?: ControlsOpenRequest
  readonly context?: number
  readonly rename?: number
}

export function useSlashCommands(input: SlashCommandsInput): SlashCommandsView {
  const { commands, restore, services, thread } = input
  const place = placeOf(input.isNew, input.status)
  const [requests, setRequests] = useState<Requests>({})
  const titling = useTitling(thread?.title)

  const context = useMemo<CommandContext>(
    () => ({
      place,
      engine: commands?.list ?? [],
      contributed: input.contributed,
      controls: input.controls,
      status: input.status,
      can: {
        rename: thread !== undefined && input.onRenameThread !== undefined,
        export: thread !== undefined && input.onExportThread !== undefined,
        share: thread !== undefined && input.onShareThread !== undefined,
        context: input.usage !== undefined && input.usage.size > 0,
        todo: input.todo !== undefined && input.endpoint !== '',
      },
    }),
    [
      commands?.list,
      input.contributed,
      input.controls,
      input.endpoint,
      input.onExportThread,
      input.onRenameThread,
      input.onShareThread,
      input.status,
      input.todo,
      input.usage,
      place,
      thread,
    ],
  )
  const list = useMemo(() => availableCommands(context), [context])

  const openRename = useCallback(() => {
    titling.end()
    setRequests((held) => ({ ...held, rename: (held.rename ?? 0) + 1 }))
  }, [titling.end])
  const openControls = useCallback((pane: ControlsOpenRequest['pane']) => {
    setRequests((held) => ({ ...held, model: { seq: (held.model?.seq ?? 0) + 1, pane } }))
  }, [])

  useOutputBanner(commands?.output ?? null, services.banners, { onRenameOutput: titling.end, openRename })

  const native = useNativeActions(input, { openControls, openRename, titling: titling.begin, setRequests })

  const route = useCallback(
    (message: Omit<PromptInputMessage, 'queued'>): boolean => {
      const resolved = resolutionOf(message, context)
      if (resolved === null) return false
      if (resolved.kind !== 'ready') {
        services.banners.show({
          severity: 'warning',
          title: resolved.kind === 'blocked' ? resolved.reason : `Poietica 里没有 /${resolved.name} 这条命令`,
        })
        restore(message.text)
        return true
      }
      const args = commandArgsOf(message.text)
      const { effect } = resolved.command
      if (effect.kind === 'contributed') effect.run()
      else if (effect.kind === 'native') native(effect.action, args)
      else void commands?.run(message.text.trim())
      return true
    },
    [commands, context, native, restore, services.banners],
  )

  const canRetry = findCommand(context.engine, 'retry') !== null
  const retry = useCallback(() => {
    void commands?.run('/retry')
  }, [commands])

  return {
    list,
    route,
    modelPickerRequest: requests.model,
    contextPanelRequest: requests.context,
    renameRequest: requests.rename,
    titling: titling.titling,
    retry: canRetry ? retry : undefined,
  }
}

/* 一次提交是不是在点名命令：带了附件或技能的就是一句话（命令不收附件）；不认识的名字也是一句话（`/usr/bin`） */
function resolutionOf(message: Omit<PromptInputMessage, 'queued'>, context: CommandContext): CommandResolution | null {
  if (message.assets.length > 0 || message.skills.length > 0) return null
  const name = commandNameOf(message.text)
  return name === null ? null : resolveCommand(name, context)
}

/** conversation 自己办的那几条：每条落到它现成的那个控件或动作上 */
function useNativeActions(
  input: SlashCommandsInput,
  tools: {
    readonly openControls: (pane: ControlsOpenRequest['pane']) => void
    readonly openRename: () => void
    readonly titling: () => void
    readonly setRequests: (update: (held: Requests) => Requests) => void
  },
): (action: NativeAction, args: string) => void {
  const { banners, commands: kernelCommands, dialogs } = input.services
  const { commands, controls, endpoint, onExportThread, onRenameThread, onSelectControl, onShareThread, thread, todo } =
    input
  const { openControls, openRename, setRequests, titling } = tools

  const rename = useCallback(
    (args: string) => {
      if (thread === undefined) return
      if (args !== '') {
        onRenameThread?.(thread.id, args)
        return
      }
      /* 不带标题：omp 按对话内容生成（它只在空闲时收命令）；忙着的时候、或 omp 没有这条，就打开改名框让人自己写 */
      const busy = BUSY.includes(input.status)
      if (busy || commands === undefined || findCommand(commands.list, 'rename') === null) {
        openRename()
        return
      }
      titling()
      void commands.run('/rename')
    },
    [commands, input.status, onRenameThread, openRename, thread, titling],
  )

  const choose = useCallback(
    (purpose: SessionConfigControl['purpose'], args: string, what: string) => {
      const pane = purpose === 'model' ? 'model' : 'level'
      if (args === '') {
        openControls(pane)
        return
      }
      const control = controls.find((entry) => entry.purpose === purpose)
      const value = pickChoice(control, args)
      if (control === undefined || value === null) {
        banners.show({ severity: 'warning', title: `没有唯一匹配「${args}」的${what}，从列表里选一个` })
        openControls(pane)
        return
      }
      if (value !== control.current) onSelectControl(control.id, value)
    },
    [banners, controls, onSelectControl, openControls],
  )

  const share = useCallback(async () => {
    if (thread === undefined || onShareThread === undefined) return
    const ok = await dialogs.confirm({
      title: '分享这条对话？',
      body: '会把这条对话加密上传，生成一条链接并复制到剪贴板。拿到链接的人都能打开它。',
      confirmLabel: '生成并复制链接',
    })
    if (ok) onShareThread(thread.id)
  }, [dialogs, onShareThread, thread])

  return useCallback(
    (action: NativeAction, args: string) => {
      switch (action) {
        case 'new':
          void kernelCommands.execute('conversation.newThread')
          return
        case 'fork':
          void kernelCommands.execute('conversation.forkThread')
          return
        case 'settings':
          void kernelCommands.execute('workbench.openSettings')
          return
        case 'rename':
          rename(args)
          return
        case 'model':
          choose('model', args, '模型')
          return
        case 'effort':
          choose('thought', args, '推理强度')
          return
        case 'plan': {
          const control = controls.find((entry) => entry.id === PLAN_CONTROL_ID)
          const value = planValueOf(args, control)
          if (value === null) banners.show({ severity: 'warning', title: '/plan 只接受「开启」或「关闭」' })
          else onSelectControl(PLAN_CONTROL_ID, value)
          return
        }
        case 'context':
          setRequests((held) => ({ ...held, context: (held.context ?? 0) + 1 }))
          return
        case 'export':
          if (thread !== undefined) onExportThread?.(thread.id)
          return
        case 'share':
          void share()
          return
        case 'todo':
          todo?.set(endpoint)
          return
      }
    },
    [
      banners,
      choose,
      controls,
      endpoint,
      kernelCommands,
      onExportThread,
      onSelectControl,
      rename,
      setRequests,
      share,
      thread,
      todo,
    ],
  )
}
