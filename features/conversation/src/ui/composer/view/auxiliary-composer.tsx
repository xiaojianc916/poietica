import '../../shared/styles/surface.css'
import './composer-actions.css'
import './auxiliary-composer.css'

import { useWorkspacesView, type WorkspacesUi, WorkspacesUiToken } from '@poietica/feature-workspaces/ui-api'
import { useService } from '@poietica/ui-kernel'
import { type KeyboardEvent, type ReactNode, type Ref, useCallback, useId, useMemo, useRef, useState } from 'react'
import type { SessionConfigControl } from '../../shared/model/config'
import { PlusIcon, SubmitIcon } from '../../shared/primitives/icons'
import { useAgentToolkit } from '../toolkit'
import { composerPaletteGroups } from './composer-actions'
import {
  ComposerPalette,
  composerComposeGroup,
  type PaletteRow,
  paletteKeyDown,
  useDismissOutside,
} from './composer-palette'
import { PermissionPicker, SessionControls } from './controls'

/*
 * 比主对话那张卡矮一档也少一行（右栏只有 320–800），整条就是一颗药丸；打开的三样与主对话相同，
 * 这里只换版式不换实现。面板还没接上会话：档位表是占位的一份，改档位只落在本格 state。
 */

const PLACEHOLDER_CONTROLS: readonly SessionConfigControl[] = [
  {
    id: 'model',
    label: '模型',
    purpose: 'model',
    current: 'deepseek-v4-flash',
    choices: [
      { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { value: 'kimi-k2', label: 'Kimi K2' },
    ],
  },
  /* 档位名是 agent 报的原文（英文），与模型名同一个来源 —— 这里不翻译它。 */
  {
    id: 'thought',
    label: '思考',
    purpose: 'thought',
    current: 'high',
    choices: [
      { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' },
      { value: 'high', label: 'high' },
    ],
  },
  {
    id: 'permission',
    label: '批准方式',
    purpose: 'permission',
    current: 'auto',
    choices: [
      { value: 'manual', label: '请求批准' },
      { value: 'yolo', label: '帮我批准' },
      { value: 'auto', label: '完全访问权限' },
    ],
  },
  {
    id: 'plan',
    label: '计划',
    purpose: 'mode',
    current: 'off',
    choices: [
      { value: 'off', label: '计划' },
      { value: 'on', label: '计划', detail: '只读分析并先产出计划' },
    ],
  },
  {
    id: 'goal',
    label: '目标',
    purpose: 'mode',
    current: 'off',
    choices: [
      { value: 'off', label: '目标' },
      { value: 'on', label: '目标', detail: '以当前草稿为目标持续推进' },
    ],
  },
]

/* 这一格还没有收附件的地方：那一行先画出来，点了不做事。 */
const noFilePicker = () => undefined

export function AuxiliaryComposer() {
  const [controls, setControls] = useState(PLACEHOLDER_CONTROLS)
  const [draft, setDraft] = useState('')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)

  /* 名册与主对话读同一个贡献点；辅助对话没有自己的工作区，问的是全局活动的那一个。 */
  const workspaces = useService(WorkspacesUiToken) as WorkspacesUi
  const { activeId } = useWorkspacesView(workspaces)
  const { mcpServers, skills } = useAgentToolkit(activeId)

  const listboxId = useId()
  const bar = useRef<HTMLFormElement | null>(null)

  /* 屏幕上的值只有一个来源：占位期间归本格，接上会话后归 agent，这里只改它的 current。 */
  const select = useCallback((controlId: string, value: string) => {
    setControls((held) => held.map((control) => (control.id === controlId ? { ...control, current: value } : control)))
  }, [])

  const groups = useMemo(
    () => [
      composerComposeGroup(noFilePicker),
      ...composerPaletteGroups({ controls, mcpServers, onSelectControl: select, skills }),
    ],
    [controls, mcpServers, select, skills],
  )

  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups])
  const open = paletteOpen && rows.length > 0

  useDismissOutside(open, bar, () => setPaletteOpen(false))

  /* 面板里能落地的只有模式开关：插入技能要一张编辑器，配置项要一份待发草稿，这一格都还没有。 */
  const pick = (row: PaletteRow) => {
    setPaletteOpen(false)

    if (row.action.kind === 'run') {
      row.action.run(draft)
    }
  }

  /* 面板开着时这几个键归面板：捕获相先到，否则方向键会先去挪草稿输入框的光标。 */
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    paletteKeyDown(event, {
      highlighted,
      onClose: () => setPaletteOpen(false),
      onHighlight: setHighlighted,
      onPick: pick,
      open,
      rows,
      stopPropagation: false,
    })
  }

  return (
    <section className="assistant-surface" data-assistant-skin data-phase="live">
      {/* 正文还没有：这一格此刻只把输入条摆出来。 */}
      <div className="auxiliary-composer-pane__feed">
        <p className="auxiliary-composer-pane__empty" />
      </div>

      <AuxiliaryComposerBar
        formRef={bar}
        leading={
          <button
            aria-controls={listboxId}
            aria-expanded={open}
            aria-label="添加内容"
            className="assistant-plus"
            onClick={() => {
              setHighlighted(0)
              setPaletteOpen((current) => !current)
            }}
            type="button"
          >
            <PlusIcon aria-hidden="true" />
          </button>
        }
        onChange={setDraft}
        onKeyDownCapture={onKeyDown}
        /* 还没有收信人：这一颗先把样子画出来，提交什么都不发生。 */
        onSubmit={() => undefined}
        overlay={
          /* 面板贴着药丸上沿向上展开，位置归 composer-palette 自己。 */
          <ComposerPalette
            groups={groups}
            highlighted={highlighted}
            isOpen={open}
            listboxId={listboxId}
            onHighlight={setHighlighted}
            onPick={pick}
          />
        }
        placeholder="问问侧边聊天..."
        trailing={
          <>
            {/* 模型与档位、批准方式：与主对话工具条上的是同两个控件。 */}
            <SessionControls controls={controls} onSelect={select} />
            {/* 这一格只有侧栏那么宽，标签让位给字形；当前档位在弹层里逐档说清。 */}
            <PermissionPicker controls={controls} iconOnly onSelect={select} />
          </>
        }
        value={draft}
      />
    </section>
  )
}

export interface AuxiliaryComposerBarProps {
  readonly value: string
  readonly onChange: (value: string) => void
  /** 提交（Enter 或点发送键）；表单默认的整页提交已在这一层拦掉。 */
  readonly onSubmit: () => void
  readonly placeholder: string
  readonly inputLabel?: string | undefined
  readonly submitLabel?: string | undefined
  /** 输入框不可用（例如正在停止）。 */
  readonly disabled?: boolean | undefined
  /** 发送键不可用（空草稿、正在发送）。 */
  readonly submitDisabled?: boolean | undefined
  /** 药丸左端（加号）。 */
  readonly leading?: ReactNode
  /** 输入框与发送键之间（模型、档位、批准方式）。 */
  readonly trailing?: ReactNode
  /** 贴着药丸的浮层（加号面板），以表单为定位上下文。 */
  readonly overlay?: ReactNode
  readonly onKeyDownCapture?: ((event: KeyboardEvent<HTMLFormElement>) => void) | undefined
  readonly formRef?: Ref<HTMLFormElement> | undefined
}

/*
 * 侧栏那颗一行高的输入药丸：辅助对话与子代理标签页共用这一份（版式、键位、发送键都一样），
 * 两端放什么由调用方决定。它只管画和收发草稿，不认识会话。
 */
export function AuxiliaryComposerBar({
  disabled,
  formRef,
  inputLabel = '输入',
  leading,
  onChange,
  onKeyDownCapture,
  onSubmit,
  overlay,
  placeholder,
  submitDisabled,
  submitLabel = '发送',
  trailing,
  value,
}: AuxiliaryComposerBarProps) {
  return (
    <div className="auxiliary-composer-pane__dock">
      <form
        className="auxiliary-composer"
        onKeyDownCapture={onKeyDownCapture}
        onSubmit={(event) => {
          event.preventDefault()
          if (submitDisabled !== true) onSubmit()
        }}
        ref={formRef}
      >
        {overlay}
        <div className="auxiliary-composer__pill" data-leading={leading === undefined ? 'none' : undefined}>
          {leading}
          <input
            aria-label={inputLabel}
            className="auxiliary-composer__field"
            disabled={disabled}
            onChange={(event) => {
              onChange(event.target.value)
            }}
            placeholder={placeholder}
            value={value}
          />
          {trailing}
          <button aria-label={submitLabel} data-slot="prompt-input-submit" disabled={submitDisabled} type="submit">
            <SubmitIcon aria-hidden="true" />
          </button>
        </div>
      </form>
    </div>
  )
}
