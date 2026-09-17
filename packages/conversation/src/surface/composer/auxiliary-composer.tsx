import '../assistant.css'
import './composer-actions.css'
import './auxiliary-composer.css'

import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { SessionConfigControl } from '../../agent/config'
import { useAgentToolkit } from '../configuration/agent-controls-context'
import { PlusIcon, SubmitIcon } from '../primitives/icons'
import { composerPaletteGroups } from './composer-actions'
import { ComposerPalette, composerComposeGroup, type PaletteRow } from './composer-palette'
import { PermissionPicker, SessionControls } from './controls'

/*
 * 辅助对话这一格的输入条。
 *
 * 它比主对话那张卡矮一档，也少一行：辅助对话住在右栏（320–800），两行版式在那
 * 个宽度里挤不下。整条就是一颗药丸，外面不再套卡片 —— 药丸自己带一圈边，外面再
 * 套一层同色边读起来是双线框。
 *
 * 打开的三样全是主对话那几处：加号翻开的面板（composer-palette）、模型与档位
 * （session-controls）、批准方式（permission-picker）。这里只换版式，不换实现。
 *
 * 面板还没接上会话，所以档位表是占位的一份：改档位只落在这一格的 state 里，一个
 * 字都不往外发，发送键也还没有收信人。技能名册是真的（右栏本来就持有它）。接上
 * 会话时把 PLACEHOLDER_CONTROLS 换成会话报的那张表、把 select 接到 selectControl
 * 上，其余一个字不用动。
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

  /* 名册与主对话读的是同一个上下文：加号翻开的面板里那两组因此不必各拉一遍。 */
  const { mcpServers, skills } = useAgentToolkit()

  const listboxId = useId()
  const bar = useRef<HTMLFormElement | null>(null)

  /*
   * 屏幕上的值只有一个来源，就是上面那张表：占位期间它归这一格自己，接上会话之后
   * 它归 agent，这里改的只是它的 current —— 与 SessionControls 的受控读法一致。
   */
  const select = useCallback((controlId: string, value: string) => {
    setControls((held) =>
      held.map((control) => (control.id === controlId ? { ...control, current: value } : control)),
    )
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

  /* 点到条外就收面板：捕获相 pointerdown，因为点不可聚焦区域不移走焦点。 */
  useEffect(() => {
    if (!open) {
      return undefined
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && bar.current?.contains(event.target) === true) {
        return
      }

      setPaletteOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown, true)

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open])

  /*
   * 面板里能落地的只有模式开关：它改的是这一格自己的占位表。插入技能要一张装得下
   * 胶囊的编辑器，配置项要一份待发草稿，这一格都还没有 —— 那两类行先画出来。
   */
  const pick = (row: PaletteRow) => {
    setPaletteOpen(false)

    if (row.action.kind === 'run') {
      row.action.run(draft)
    }
  }

  /* 面板开着时这几个键归面板。捕获相先到 —— 与主输入框同一条理由：草稿那个输入框
     不该知道面板存在，放它冒泡上去，方向键就先去挪光标了。 */
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (!open || event.nativeEvent.isComposing) {
      return
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()

      const step = event.key === 'ArrowDown' ? 1 : -1

      setHighlighted((current) => (current + step + rows.length) % rows.length)

      return
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()

      const chosen = rows[highlighted] ?? rows[0]

      if (chosen !== undefined) {
        pick(chosen)
      }

      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      setPaletteOpen(false)
    }
  }

  return (
    <section className="assistant-surface" data-assistant-skin data-phase="live">
      {/* 正文还没有：这一格此刻只把输入条摆出来。 */}
      <div className="auxiliary-composer-pane__feed">
        <p className="auxiliary-composer-pane__empty" />
      </div>

      <div className="auxiliary-composer-pane__dock">
        <form
          className="auxiliary-composer"
          onKeyDownCapture={onKeyDown}
          onSubmit={(event) => {
            /* 还没有收信人：这一颗先把样子画出来，提交什么都不发生。 */
            event.preventDefault()
          }}
          ref={bar}
        >
          {/* 面板贴着药丸上沿向上展开，位置归 composer-palette 自己。 */}
          <ComposerPalette
            groups={groups}
            highlighted={highlighted}
            isOpen={open}
            listboxId={listboxId}
            onHighlight={setHighlighted}
            onPick={pick}
          />

          <div className="auxiliary-composer__pill">
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

            <input
              aria-label="输入"
              className="auxiliary-composer__field"
              onChange={(event) => {
                setDraft(event.target.value)
              }}
              placeholder="问问侧边聊天..."
              value={draft}
            />

            {/* 模型与档位、批准方式：与主对话工具条上的是同两个控件。 */}
            <SessionControls controls={controls} onSelect={select} />

            {/* 这一格只有侧栏那么宽，标签让位给字形；当前档位在弹层里逐档说清。 */}
            <PermissionPicker controls={controls} iconOnly onSelect={select} />

            <button aria-label="发送" data-slot="prompt-input-submit" type="submit">
              <SubmitIcon aria-hidden="true" />
            </button>
          </div>
        </form>
      </div>
    </section>
  )
}
