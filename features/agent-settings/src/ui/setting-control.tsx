import { Select, type SelectOption, Switch } from '@poietica/design-system'
import { useEffect, useState } from 'react'
import type { SettingDescriptor } from '../contract'
import './agent-settings.css'

/*
 * 一格设置画成什么控件，全由 descriptor 的 type 决定：这里没有 per-setting 的表单代码
 * （07 页 §7.2）。
 *
 * **迁移自** legacy \`packages/settings/src/ui/agent-settings/setting-control.tsx\`：
 * DOM、类名（\`agent-setting__input\`）、四个分支的判据与三条提交时机（数字失焦、文本回车或失焦、
 * 枚举即选即写）逐条照旧。换的是**载荷形状**：legacy 的 AgentSettingEntry 换成新契约的
 * SettingDescriptor（04 页 §2.2），对应的三处收敛在这里写明 ——
 *
 *   - legacy 的 \`options: {value,label}[]\` 与 \`enumValues: string[]\` 两档，在 descriptor 里合成
 *     \`options: string[] | null\`（取值与说法同一件事：上游只给标识符，中文行标签在 description 里）；
 *   - legacy 的 \`secret` / \`hasValue\`（凭据格永远不回显）在引擎端口就已经处理掉了：
 *     凭据类设置的 \`value\` 一律为 null，这里因此不再需要那一支；
 *   - legacy 的 \`array\` / \`record\` 两档不进目录（engine-omp 的 isProductSetting 只放行四档），
 *     所以 OpaqueControl 那一支随目录一起消失。
 */

export interface SettingControlProps {
  readonly entry: SettingDescriptor
  /**
   * 正在写这一格。可缺席：不是每种控件都锁得住 —— Select 的公开面没有 disabled，
   * 而写是幂等的整格替换，连点两次打的是同一个值。开关与输入框锁得住，就锁。
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
      return null
  }
}

/*
 * 选项表：descriptor 的 `options` 就是取值表，`value` 是写回 agent 的标识、`label` 是给人看的。
 *
 * 只画 `label`：上游那一格 `description` 是**读设置的人**才需要的长句，塞进下拉每一行
 * 会把清单撑成一堆半截话（触发器还要截断）。要看那一格的说明，行的说明就在控件左边。
 */
function optionTable(entry: SettingDescriptor): readonly SelectOption[] | undefined {
  const options = entry.options
  if (options === null || options.length === 0) return undefined
  return options.map((option) => ({ value: option.value, label: option.label }))
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
        onChange(entry.type === 'number' ? Number(next) : next)
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
 * 不需要「路径变了就清草稿」那条重置：行由 entry.path 做 key，换一格就是重新挂载
 * 一个新实例，草稿自然从空开始。
 */
function TextControl({ entry, saving, onChange }: SettingControlProps) {
  const [draft, setDraft] = useState('')

  /*
   * 凭据那一格：**永远不显示值**，输入框只收新值，空着就是不改。它说的是配过没有
   * （`hasValue`），不是值本身 —— 值根本没有过这条线（端口那一侧已经折成一个布尔）。
   */
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

/*
 * 凭据输入：与普通文本同一套草稿纪律（回车提交、提交后清空），但**不挂失焦** ——
 * 失焦多半是「点去别处看看」，拿半截输入去覆盖一把能用的钥匙，代价与收益不成比例。
 *
 * 占位符只说配过没有；`type="password"` 让新输入也不上屏。
 */
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

/** 此刻的值 → 触发器/输入框上的字。对象与数组不进输入框（它们本来也不进目录）。 */
function textOf(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
}
