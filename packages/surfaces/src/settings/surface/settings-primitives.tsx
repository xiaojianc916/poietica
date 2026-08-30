import { Switch } from '@poietica/design-system'
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
  /* 省略即不画表头：整页只有一张卡时，一个组标题是在复述页面标题。 */
  readonly title?: string
  readonly children: ReactNode
}

export function SettingsGroup({ title, children }: SettingsGroupProps) {
  return (
    <section className="settings-group">
      {title === undefined ? null : (
        <header className="settings-group__header">
          <h3>{title}</h3>
        </header>
      )}

      <div className="settings-group__surface">{children}</div>
    </section>
  )
}

export interface SettingRowProps {
  readonly label: string
  /*
   * 显式带上 undefined。
   *
   * exactOptionalPropertyTypes 下「?: string」的意思是「可以不写，写了必须是字符串」，
   * 它不接受一个显式传进来的 undefined。而这个属性的用法恰恰是被转发的 —— ToggleRow 从
   * 自己的可选属性里解构出 string | undefined，再原样交给这里。转发正是那个组件存在的
   * 理由，所以这个契约必须容得下转发。
   *
   * 同一个包里 SettingsGroupProps.title 保持「?: string」不动：它在调用点手写，从不被
   * 转发，窄一档是更准确的声明，不是漏改。
   */
  readonly description?: string | undefined
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
  /* 与 SettingRow 同一档：这里只是把它原样转发下去，收得不该比转发的目标还窄。 */
  readonly description?: string | undefined
  readonly onChange: (checked: boolean) => void
}

export function ToggleRow({ checked, label, description, onChange }: ToggleRowProps) {
  return (
    <SettingRow description={description} label={label}>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} size="sm" />
    </SettingRow>
  )
}
