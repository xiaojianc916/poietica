import { Switch } from '@poietica/ui'
import type { ReactNode } from 'react'

/*
 * 设置页面的排版词汇：页、组、行、开关行。
 *
 * 分类页各自渲染内容，但页面骨架只有这一份。否则每加一页就多一套边距与分隔线的
 * 写法，屏幕上会出现几种"差不多"的设置页 —— 那正是这轮重构在收敛的那类问题。
 * 样式仍旧只有 settings-surface.css 一个来源，这里只负责结构。
 */

export interface SettingsPageProps {
  readonly children: ReactNode
}

export function SettingsPage({ children }: SettingsPageProps) {
  return (
    <section className="settings-page">
      <div className="settings-page__body">{children}</div>
    </section>
  )
}

export interface SettingsGroupProps {
  readonly title: string
  readonly children: ReactNode
}

export function SettingsGroup({ title, children }: SettingsGroupProps) {
  return (
    <section className="settings-group">
      <header className="settings-group__header">
        <h3>{title}</h3>
      </header>

      <div className="settings-group__surface">{children}</div>
    </section>
  )
}

export interface SettingRowProps {
  readonly label: string
  readonly description?: string
  readonly children: ReactNode
}

export function SettingRow({ label, description, children }: SettingRowProps) {
  return (
    <div className="settings-row">
      <div className="settings-row__copy">
        <strong>{label}</strong>
        {description ? <p>{description}</p> : null}
      </div>

      <div className="settings-row__control">{children}</div>
    </div>
  )
}

export interface ToggleRowProps {
  readonly checked: boolean
  readonly label: string
  readonly description?: string
  readonly onChange: (checked: boolean) => void
}

export function ToggleRow({ checked, label, description, onChange }: ToggleRowProps) {
  return (
    <SettingRow description={description} label={label}>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} size="sm" />
    </SettingRow>
  )
}
