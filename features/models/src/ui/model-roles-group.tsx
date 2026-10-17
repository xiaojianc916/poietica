import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
  Select,
  type SelectOption,
  SettingRow,
  SettingsGroup,
} from '@poietica/design-system'
import { ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { ModelRoleInfo } from '../contract'
import type { ModelsApi } from './api'

/*
 * 「通用」页里的「模型」一组：默认模型在上，其余 omp 角色（modelRoles 的每一格，含用户在 omp 里自定义的）收进「按用途指定」。
 * 清单、名字、候选、没配时的去向全由 Core 经引擎问 omp，这里不自列角色。没配的格写「跟随默认」「自动（…）」这类实际去向，
 * 用弱色；配过的才用正文色，并计入折叠条上的「已指定 N 项」。没有候选又没配过的格（如没有语音模型时的语音合成）不画。
 * 当前值不在候选里（`@smol`、停用的模型）时原样补一项，不悄悄改掉用户的配置。
 */
const UNSET = '__unset__'
const DEFAULT_ROLE = 'default'
const PANEL = 'roles'

export function ModelRolesGroup({ api }: { readonly api: ModelsApi }): React.ReactElement {
  const [roles, setRoles] = useState<readonly ModelRoleInfo[] | null>(null)
  const [open, setOpen] = useState(false)

  const load = useCallback((): void => {
    void api.roles().then(setRoles)
  }, [api])

  useEffect(() => {
    load()
    const sub = api.onChanged(load)
    return () => sub.dispose()
  }, [api, load])

  if (roles === null) return <SettingsGroup title="模型">{null}</SettingsGroup>

  const change = (role: string, selector: string | null): void => {
    setRoles((all) => all?.map((r) => (r.role === role ? { ...r, selector } : r)) ?? all)
    void api.setRole(role, selector)
  }
  const nameOf = (role: string): string => roles.find((r) => r.role === role)?.name ?? role
  const primary = roles.find((r) => r.role === DEFAULT_ROLE)
  const others = roles.filter((r) => r.role !== DEFAULT_ROLE && (r.selector !== null || r.candidates.length > 0))
  const chat = others.filter((r) => r.section === 'chat')
  const kind = others.filter((r) => r.section === 'kind')
  const assigned = others.filter((r) => r.selector !== null).length

  return (
    <SettingsGroup title="模型">
      {primary === undefined ? null : <DefaultRow nameOf={nameOf} onChange={change} role={primary} />}
      {others.length === 0 ? null : (
        <Accordion onValueChange={(next) => setOpen(next.includes(PANEL))} value={open ? [PANEL] : []}>
          <AccordionItem className="model-roles" value={PANEL}>
            <AccordionHeader className="model-roles__header">
              <AccordionTrigger className="model-roles__trigger">
                <span className="settings-row__copy">
                  <strong>按用途指定</strong>
                  <p>为快速任务、深度思考、子任务等单独选择模型</p>
                </span>
                <span className="model-roles__summary">
                  {assigned > 0 ? `已指定 ${assigned} 项` : null}
                  <ChevronDown aria-hidden="true" className="model-roles__chevron" size={14} />
                </span>
              </AccordionTrigger>
            </AccordionHeader>
            <AccordionPanel className="model-roles__panel">
              <RoleSection nameOf={nameOf} onChange={change} roles={chat} title="对话与任务" />
              <RoleSection nameOf={nameOf} onChange={change} roles={kind} title="专用能力" />
            </AccordionPanel>
          </AccordionItem>
        </Accordion>
      )}
    </SettingsGroup>
  )
}

type Change = (role: string, selector: string | null) => void

function DefaultRow({
  role,
  nameOf,
  onChange,
}: {
  readonly role: ModelRoleInfo
  readonly nameOf: (role: string) => string
  readonly onChange: Change
}): React.ReactElement {
  if (role.candidates.length === 0 && role.selector === null) {
    return <SettingRow description="还没有可用的模型，先在「模型」页添加服务商" label="默认模型" />
  }
  return (
    <SettingRow description="新对话使用的模型" label="默认模型">
      <Select
        align="end"
        className="settings-select-trigger"
        data={optionsOf(role, nameOf)}
        onValueChange={(v) => onChange(role.role, v)}
        type="默认模型"
        value={role.selector ?? ''}
      />
    </SettingRow>
  )
}

function RoleSection({
  title,
  roles,
  nameOf,
  onChange,
}: {
  readonly title: string
  readonly roles: readonly ModelRoleInfo[]
  readonly nameOf: (role: string) => string
  readonly onChange: Change
}): React.ReactElement | null {
  if (roles.length === 0) return null
  return (
    <section aria-label={title} className="model-roles__section">
      {roles.map((role) => (
        <SettingRow description={role.description ?? undefined} key={role.role} label={role.name}>
          <Select
            align="end"
            /* 没配的格画成空心、弱色：一眼只看得见配过的那几格 */
            className={
              role.selector === null
                ? 'settings-select-trigger bg-transparent text-muted-foreground'
                : 'settings-select-trigger'
            }
            data={[{ value: UNSET, label: unsetLabelOf(role, nameOf) }, ...optionsOf(role, nameOf)]}
            onValueChange={(v) => onChange(role.role, v === UNSET ? null : v)}
            type={role.name}
            value={role.selector ?? UNSET}
          />
        </SettingRow>
      ))}
    </section>
  )
}

/** 没配时那一项的字：照 omp 的实际去向写，不写「未设置」 */
export function unsetLabelOf(role: ModelRoleInfo, nameOf: (role: string) => string): string {
  switch (role.fallback.kind) {
    case 'role':
      return `跟随${nameOf(role.fallback.role)}`
    case 'conversation':
      return '跟随当前对话'
    case 'auto':
      return role.fallback.model === null ? '自动选择' : `自动（${role.fallback.model}）`
  }
}

/*
 * 候选列表 + 当前值。当前值带思考档（`provider/id:high`）时顶替同一模型那一项，名字照旧、值保留后缀；
 * `@role` 写成「跟随某角色」；其余认不出的（停用、没凭据）原样列出并标「不可用」。
 */
export function optionsOf(role: ModelRoleInfo, nameOf: (role: string) => string): SelectOption[] {
  const current = role.selector
  const options: SelectOption[] = role.candidates.map((c) => ({ value: c.selector, label: c.label }))
  if (current === null || options.some((o) => o.value === current)) return options
  const colon = current.lastIndexOf(':')
  const base = colon > current.indexOf('/') ? current.slice(0, colon) : current
  const same = options.findIndex((o) => o.value === base)
  if (same >= 0) {
    return options.map((o, i) => (i === same ? { value: current, label: o.label } : o))
  }
  const label = current.startsWith('@') ? `跟随${nameOf(current.slice(1).split(':')[0] ?? '')}` : `${current}（不可用）`
  return [{ value: current, label }, ...options]
}
