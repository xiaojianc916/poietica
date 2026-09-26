import { Switch } from '@poietica/design-system'
import type { ReactNode } from 'react'

/*
 * 设置页排版词汇：页、组、行、开关行。骨架只有这一份，样式只有 settings-surface.css 一个来源。
 */

export interface SettingsPageProps {
  readonly children?: ReactNode
}

export function SettingsPage({ children }: SettingsPageProps) {
  return <section className="settings-page">{children}</section>
}

export interface SettingsGroupProps {
  /* 省略即不画表头：整页只有一张卡时，一个组标题是在复述页面标题。 */
  /* 显式 | undefined：转发的组名可能缺席，exactOptionalPropertyTypes 下 ?: 收不下转发值。 */
  readonly title?: string | undefined
  readonly className?: string
  /* 标题右侧的操作按钮，如"导入…""管理"入口；仅在有 title 时显示。 */
  readonly headerAction?: ReactNode
  readonly children: ReactNode
}

export function SettingsGroup({ title, className, headerAction, children }: SettingsGroupProps) {
  return (
    <section className={`settings-group${className ? ` ${className}` : ''}`}>
      {title === undefined ? null : (
        <header className="settings-group__header">
          <h3>{title}</h3>
          {headerAction}
        </header>
      )}

      <div className="settings-group__surface">{children}</div>
    </section>
  )
}

export interface SettingRowProps {
  readonly label: string
  /* 显式 | undefined：description 由 ToggleRow 转发，exactOptionalPropertyTypes 下 ?: 收不下转发值。 */
  readonly description?: string | undefined
  /*
   * 风险提示，排在说明之上。
   *
   * 单独立一格而不拼进 description：它说的是「这件事有代价」，与「这一格是什么」是两句话，
   * 拼在一起就没有一种排版能只强调其中一句。上游同一处分法（agent 自己那份 setting 面板的
   * `src/config/settings-ui.ts` 给 warning 的注释）。
   */
  readonly warning?: string | undefined
  readonly children?: ReactNode
}

export function SettingRow({ label, description, warning, children }: SettingRowProps) {
  return (
    <div className="settings-row">
      <div className="settings-row__copy">
        {warning ? (
          <p className="settings-row__warning" role="alert">
            {warning}
          </p>
        ) : null}

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
