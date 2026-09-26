import { Select, type SelectOption, Switch } from '@poietica/design-system'
import { useEffect, useState } from 'react'
import type { AgentSettingEntry } from '../../index'
import './agent-settings.css'

/*
 * 一格设置画成什么控件，全由 agent 报的元数据决定：这里没有 per-setting 的表单代码。
 *
 * | 判据 | 控件 |
 * | --- | --- |
 * | 有选项表（`options`，退回 `enumValues`） | Select |
 * | `boolean` | Switch |
 * | `number` | 数字输入 |
 * | `string` | 文本输入；`secret` 为真则掩码 |
 * | `array` / `record` | 只读，说清去哪改（见 OpaqueControl） |
 *
 * 「number 有选项表也画 Select」不是我们加的规矩，是照上游自己那张表：`pi-tui` 的
 * `settings-defs.ts` 把带选项的 number 归成 submenu，`settings-selector.ts` 的
 * `#setSettingValue` 再按 schema 类型折回数值。它给的是标好单位的台阶（"20 KB" 这类），
 * 画成自由输入框就丢了单位，人得自己换算。
 *
 * 本文件只出控件本身，行（label / description / 控件那一格）由 SettingRow 承担 ——
 * 控件不重复排版。
 */

export interface SettingControlProps {
  readonly entry: AgentSettingEntry
  /**
   * 正在写这一格。
   *
   * 可缺席，因为不是每种控件都锁得住：Select 的公开面没有 disabled（面板由 Base UI 渲染在
   * 别处），而写本身是幂等的整格替换，连点两次打的是同一个值。开关与输入框锁得住，就锁。
   */
  readonly saving?: boolean | undefined
  readonly onChange: (value: unknown) => void
}

export function SettingControl({ entry, saving, onChange }: SettingControlProps) {
  const choices = optionTable(entry)

  if (choices !== undefined) {
    return <ChoiceControl choices={choices} entry={entry} onChange={onChange} />
  }

  switch (entry.type) {
    case 'boolean':
      return (
        <Switch
          aria-label={entry.label}
          checked={entry.value === true}
          disabled={saving}
          onCheckedChange={(next) => {
            onChange(next)
          }}
          size="sm"
        />
      )
    case 'number':
      return <NumberControl entry={entry} onChange={onChange} saving={saving} />
    case 'string':
      return <TextControl entry={entry} onChange={onChange} saving={saving} />
    default:
      return <OpaqueControl entry={entry} />
  }
}

/** 选项表：agent 给的 `options` 优先，没有就退回 `enumValues`（只有取值没有说法）。 */
function optionTable(entry: AgentSettingEntry): readonly SelectOption[] | undefined {
  if (entry.options !== undefined && entry.options.length > 0) {
    return entry.options.map((option) => ({
      value: option.value,
      label:
        option.description === undefined ? option.label : `${option.label} — ${option.description}`,
    }))
  }

  if (entry.enumValues !== undefined && entry.enumValues.length > 0) {
    return entry.enumValues.map((value) => ({ value, label: value }))
  }

  return undefined
}

/*
 * 触发器不吃 disabled：Select 的公开面里没有这一格，所以写的时候不锁它 —— 锁不住的东西
 * 假装锁了，比不锁更坏。写是幂等的整格替换，连点两次打的是同一个值。
 */
function ChoiceControl({
  entry,
  choices,
  onChange,
}: SettingControlProps & { readonly choices: readonly SelectOption[] }) {
  const current = textOf(entry.value)

  /*
   * 此刻的值不在候选表里时（上游换了枚举值而配置还留着旧的），如实把它自己添进去再选中。
   * 丢掉它会让触发器显示「选择…」，看上去像这一格没配过 —— 而它其实配着一个我们不认识的值。
   */
  const data =
    current === '' || choices.some((choice) => choice.value === current)
      ? choices
      : [...choices, { value: current, label: current }]

  return (
    <Select
      align="end"
      className="settings-select-trigger"
      data={data}
      onValueChange={(next) => {
        onChange(coerce(entry, next))
      }}
      type={entry.label}
      value={current}
    />
  )
}

function NumberControl({ entry, saving, onChange }: SettingControlProps) {
  const [draft, setDraft] = useState(() => textOf(entry.value))

  /* 值从 agent 那头回来时（写完之后整份目录换掉）以那一份为准，草稿作废。 */
  useEffect(() => {
    setDraft(textOf(entry.value))
  }, [entry.value])

  return (
    <input
      aria-label={entry.label}
      className="settings-input agent-setting__input"
      disabled={saving}
      inputMode="numeric"
      onBlur={() => {
        const parsed = Number(draft)

        if (draft.trim() !== '' && Number.isFinite(parsed) && parsed !== entry.value) {
          onChange(parsed)
        } else {
          /* 没改、写了个不认得的数、或者空着：一律退回 agent 报的那个值。 */
          setDraft(textOf(entry.value))
        }
      }}
      onChange={(event) => {
        setDraft(event.target.value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
        }
      }}
      type="number"
      value={draft}
    />
  )
}

/*
 * 文本输入：草稿只在本地，落盘只在一处（回车或失焦），空串一律当「没说」。
 *
 * 不需要「路径变了就清草稿」那条重置：行由 entry.path 做 key（见 agent-settings.tsx），
 * 换一格就是重新挂载一个新实例，草稿自然从空开始。
 */
function TextControl({ entry, saving, onChange }: SettingControlProps) {
  const [draft, setDraft] = useState('')

  /*
   * 钥匙那一格：**永远不显示值**，输入框只收新值，空着就是不改。它说的是配过没有
   * （`hasValue`），不是值本身 —— 值根本没有过这条线（桥与 Rust 各自折过一次，
   * 见 agent-settings/model.ts 的 `value`）。
   *
   * 「这一页只有 3 格钥匙」不等于「agent 只有 3 条凭据」：实测 agent 自己判定的凭据有 8
   * 条，另外 5 条没有 ui 元数据，上游自己的设置面板也不画它们（ADR 0054 决定四）。
   */
  if (entry.secret) {
    return (
      <input
        aria-label={entry.label}
        autoComplete="off"
        className="settings-input agent-setting__input"
        disabled={saving}
        onChange={(event) => {
          setDraft(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && draft !== '') {
            onChange(draft)
            setDraft('')
          }
        }}
        placeholder={entry.hasValue ? '已配置' : '未配置'}
        type="password"
        value={draft}
      />
    )
  }

  return (
    <input
      aria-label={entry.label}
      className="settings-input agent-setting__input"
      disabled={saving}
      onBlur={() => {
        if (draft !== '') {
          onChange(draft)
          setDraft('')
        }
      }}
      onChange={(event) => {
        setDraft(event.target.value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && draft !== '') {
          onChange(draft)
          setDraft('')
        }
      }}
      placeholder={textOf(entry.value) || '未设置'}
      value={draft}
    />
  )
}

/*
 * array / record：**不发明控件**，只读显示并说清去哪改。
 *
 * 上游自己的设置面板对它们分两种：有 options 的 array 画成多选，自由 map 干脆不画
 * （它的 `entryToSettingDef` 对没有 options 的 array 返回 null）。多选控件要承担
 * 「改的是整个数组」这件事，而写路径是整格替换：一次点错就把用户手写的表整份换掉。
 * 代价与收益不成比例，所以如实显示、不改。
 */
function OpaqueControl({ entry }: { readonly entry: AgentSettingEntry }) {
  return (
    <span className="agent-setting__opaque" title="在 agent 自己的配置文件里编辑">
      {collectionSize(entry.value)}
    </span>
  )
}

function collectionSize(value: unknown): string {
  if (Array.isArray(value)) {
    return `${String(value.length)} 项`
  }

  if (typeof value === 'object' && value !== null) {
    return `${String(Object.keys(value).length)} 项`
  }

  return '—'
}

/** 选中的值按 agent 自己报的类型折回去：选项表的 value 一律是字符串。 */
function coerce(entry: AgentSettingEntry, raw: string): unknown {
  return entry.type === 'number' ? Number(raw) : raw
}

/** 此刻的值 → 触发器/输入框上的字。对象与数组不进输入框，走 OpaqueControl。 */
function textOf(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }

  return typeof value === 'string' ? value : String(value)
}
