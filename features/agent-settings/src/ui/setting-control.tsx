import { Select, type SelectOption, Switch } from '@poietica/design-system'
import { useEffect, useState } from 'react'
import type { SettingDescriptor } from '../contract'
import './agent-settings.css'

/* 一格设置画成什么控件，全由 descriptor 的 type 决定：这里没有 per-setting 的表单代码。DOM、类名、四个分支的判据与三条提交时机
 * （数字失焦、文本回车或失焦、枚举即选即写）照 legacy。换的是**载荷形状**，三处收敛：legacy 的 `options` 与 `enumValues` 两档合成
 * descriptor 的 `options: string[] | null`；legacy 的 `secret` / `hasValue` 在引擎端口就处理掉了（凭据类设置的 `value` 一律为 null）；
 * legacy 的 `array` / `record` 两档不进目录，OpaqueControl 那一支随之消失。 */

export interface SettingControlProps {
  readonly entry: SettingDescriptor
  /** 可缺席：不是每种控件都锁得住 —— Select 的公开面没有 disabled，而写是幂等的整格替换，连点两次打的是同一个值。 */
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
      return null
  }
}

/* 只画 `label`：上游那一格 `description` 是**读设置的人**才需要的长句，塞进下拉每一行会把清单撑成一堆半截话（触发器还要截断）。
 * 要看那一格的说明，行的说明就在控件左边。 */
function optionTable(entry: SettingDescriptor): readonly SelectOption[] | undefined {
  const options = entry.options
  if (options === null || options.length === 0) return undefined
  return options.map((option) => ({ value: option.value, label: option.label }))
}

/* 触发器不吃 disabled：锁不住的东西假装锁了，比不锁更坏。写是幂等的整格替换，连点两次打的是同一个值。 */
function ChoiceControl({
  entry,
  choices,
  onChange,
}: SettingControlProps & { readonly choices: readonly SelectOption[] }) {
  const current = textOf(entry.value)

  /* 此刻的值不在候选表里时（上游换了枚举值而配置还留着旧的），如实添进去再选中。丢掉它会让触发器显示「选择…」，看上去像这一格没配过。 */
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
        onChange(entry.type === 'number' ? Number(next) : next)
      }}
      type={entry.label}
      value={current}
    />
  )
}

function NumberControl({ entry, saving, onChange }: SettingControlProps) {
  const [draft, setDraft] = useState(() => textOf(entry.value))

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

/* 草稿只在本地，落盘只在一处（回车或失焦），空串一律当「没说」。不需要「路径变了就清草稿」的重置：行由 entry.path 做 key，换一格
 * 就是重新挂载一个新实例。 */
function TextControl({ entry, saving, onChange }: SettingControlProps) {
  const [draft, setDraft] = useState('')

  /* **永远不显示值**，输入框只收新值，空着就是不改。它说的是配过没有（`hasValue`），不是值本身 —— 值根本没有过这条线。 */
  if (entry.secret) {
    return <SecretControl entry={entry} onChange={onChange} saving={saving} />
  }

  return (
    <input
      aria-label={entry.label}
      autoComplete="off"
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

/* 与普通文本同一套草稿纪律（回车提交、提交后清空），但**不挂失焦** —— 失焦多半是「点去别处看看」，拿半截输入去覆盖一把能用的钥匙，
 * 代价与收益不成比例。占位符只说配过没有；`type="password"` 让新输入也不上屏。 */
function SecretControl({ entry, saving, onChange }: SettingControlProps) {
  const [draft, setDraft] = useState('')

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

function textOf(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
}
