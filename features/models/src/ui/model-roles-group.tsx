import { Select, SettingRow, SettingsGroup } from '@poietica/design-system'
import { useCallback, useEffect, useState } from 'react'
import type { ModelRoleInfo } from '../contract'
import type { ModelsApi } from './api'

/* 「通用」页里的「模型角色」一组：omp 的 modelRoles 每格一行（内置 + 用户在 omp 里自定义的角色），清单、名字、候选全由 Core 经引擎问 omp，
 * 这里不自列角色、不自己过滤候选。default 不在这里画：「模型」页与输入框已有默认模型控件（单一来源）。选「未设置」= 删掉这一格，交回 omp 自己的
 * 回退链（如 tiny → commit → smol → 对话模型）。当前值不在候选里（`@smol`、带 `:high` 的选择器、停用的模型）时原样补一项，不悄悄改掉用户的配置。 */
const UNSET = '__unset__'
const HIDDEN_ROLES: readonly string[] = ['default']

export function ModelRolesGroup({ api }: { readonly api: ModelsApi }): React.ReactElement {
  const [roles, setRoles] = useState<readonly ModelRoleInfo[] | null>(null)

  const load = useCallback((): void => {
    void api.roles().then(setRoles)
  }, [api])

  useEffect(() => {
    load()
    const sub = api.onChanged(load)
    return () => sub.dispose()
  }, [api, load])

  if (roles === null) return <SettingsGroup title="模型角色">{null}</SettingsGroup>

  const shown = roles.filter((r) => !HIDDEN_ROLES.includes(r.role))
  return (
    <SettingsGroup title="模型角色">
      {shown.map((role) => (
        <RoleRow
          key={role.role}
          onChange={(selector) => {
            setRoles((all) => all?.map((r) => (r.role === role.role ? { ...r, selector } : r)) ?? all)
            void api.setRole(role.role, selector)
          }}
          role={role}
        />
      ))}
    </SettingsGroup>
  )
}

function RoleRow({
  role,
  onChange,
}: {
  readonly role: ModelRoleInfo
  readonly onChange: (selector: string | null) => void
}): React.ReactElement {
  const known = role.selector === null || role.candidates.some((c) => c.selector === role.selector)
  const data = [
    { value: UNSET, label: '未设置（omp 自动挑选）' },
    ...(known || role.selector === null ? [] : [{ value: role.selector, label: role.selector }]),
    ...role.candidates.map((c) => ({ value: c.selector, label: c.label })),
  ]
  return (
    <SettingRow description={role.description ?? `omp 角色 ${role.role}`} label={role.name}>
      <Select
        align="end"
        className="settings-select-trigger"
        data={data}
        onValueChange={(v) => onChange(v === UNSET ? null : v)}
        type={role.name}
        value={role.selector ?? UNSET}
      />
    </SettingRow>
  )
}
