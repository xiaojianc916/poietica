import { Button } from '@poietica/design-system'
import { type ReactNode, useState } from 'react'
import {
  availableServerName,
  BUILTIN_SERVERS,
  type CatalogEntryRow,
  type CatalogRow,
  isRegistryRow,
  mcpServerBody,
  missingRegistryInputs,
  type RowGroup,
  registryServerBody,
  statusText,
} from './catalog'
import { PluginGlyph } from './plugin-glyph'

import './catalog-grid.css'

const VISIBLE = 6

interface CatalogAction {
  readonly install: (name: string, body: Record<string, unknown>) => void
}

export interface CatalogGridProps {
  readonly groups: readonly RowGroup[]
  readonly action: CatalogAction
  /** 已占用的配置名：目录条目重名时据此让开（omp 的 -2 / -3 规矩）。 */
  readonly taken: ReadonlySet<string>
}

/* DOM、类名、文案、展开行为照 legacy；去掉的只有 resolveLauncher —— 新架构没有原生启动器解析这条通道。
 * 目录来的那几行是后加的（在线检索），卡片形状与精选一致，只有动作区不同。 */
export function CatalogGrid({ action, groups, taken }: CatalogGridProps) {
  if (groups.length === 0) {
    return null
  }

  return (
    <>
      {groups.map((group) => (
        <CatalogSection action={action} group={group} key={group.title} taken={taken} />
      ))}
    </>
  )
}

interface CatalogSectionProps {
  readonly group: RowGroup
  readonly action: CatalogAction
  readonly taken: ReadonlySet<string>
}

function CatalogSection({ action, group, taken }: CatalogSectionProps) {
  const [expanded, setExpanded] = useState(false)

  const shown = expanded ? group.rows : group.rows.slice(0, VISIBLE)
  const rest = group.rows.length - shown.length

  return (
    <Section
      action={
        rest > 0 ? (
          <Button onClick={() => setExpanded(true)} size="xs" variant="ghost">
            展开其余 {rest} 个
          </Button>
        ) : undefined
      }
      title={group.title}
    >
      <ul className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">
        {shown.map((row) => (
          <CatalogCard action={action} key={row.key} row={row} taken={taken} />
        ))}
      </ul>
    </Section>
  )
}

interface CatalogCardProps {
  readonly row: CatalogRow
  readonly action: CatalogAction
  readonly taken: ReadonlySet<string>
}

function CatalogCard({ action, row, taken }: CatalogCardProps) {
  /* 中间那列给了最小宽度：卡片变窄时动作区换到下一行，名字与说明完整换行，不会被挤成一两个字加省略号。 */
  return (
    <li className="catalog-card group flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-2 rounded-2xl px-3 py-3 transition-colors">
      <PluginGlyph displayName={row.displayName} id={row.id} />
      <div className="min-w-36 flex-1">
        <span className="block text-sm font-medium break-words">{row.displayName}</span>
        <span className="block pt-0.5 text-[13px] truncate text-muted-foreground">{row.description}</span>
      </div>
      {row.status.kind === 'installed' ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">{statusText(row.status)}</span>
      ) : isRegistryRow(row) ? (
        <InstallRegistry row={row} onInstall={action.install} taken={taken} />
      ) : (
        <InstallServer id={row.id} onInstall={action.install} />
      )}
    </li>
  )
}

interface InstallServerProps {
  readonly id: string
  readonly onInstall: (name: string, body: Record<string, unknown>) => void
}

/* 内置名单是真安装：把这一台写进这个 agent 的 mcp.json。要人补钥匙的，输入就长在卡片上 —— 装上才发现跑不起来，比多一格输入更糟。 */
function InstallServer({ id, onInstall }: InstallServerProps) {
  const [filled, setFilled] = useState('')

  const server = BUILTIN_SERVERS.find((one) => one.id === id)

  if (server === undefined) {
    return null
  }

  const missing = server.input?.required === true && filled.trim() === ''

  const install = (): void => {
    const body = mcpServerBody(server, filled)

    if (body !== null) {
      onInstall(server.id, body)
    }
  }

  return (
    <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2">
      {server.input === undefined ? (
        server.needs === undefined ? null : (
          <span className="max-w-44 text-[11px] break-words text-muted-foreground" title={server.needs}>
            {server.needs}
          </span>
        )
      ) : (
        <input
          aria-label={server.input.label}
          className="h-7 w-40 max-w-full min-w-0 rounded-lg bg-muted/60 px-2.5 text-xs outline-none ring-1 ring-transparent transition-[background-color,box-shadow] focus:bg-background focus:ring-foreground/10"
          onChange={(event) => setFilled(event.target.value)}
          placeholder={server.input.placeholder}
          title={server.needs}
          value={filled}
        />
      )}
      <Button className="catalog-card__install-btn" disabled={missing} onClick={install} size="xs" variant="soft">
        安装
      </Button>
    </div>
  )
}

interface InstallRegistryProps {
  readonly row: CatalogEntryRow
  readonly onInstall: (name: string, body: Record<string, unknown>) => void
  readonly taken: ReadonlySet<string>
}

/*
 * 目录条目是真安装，但**先决条件由目录给**：`inputs` 里标了 required 的得先补上，否则装上也跑不起来。
 * 这里把输入框折成一行显示（最多三个），缺什么就禁用安装键 —— 与精选卡片同一套判据，只是来源不同。
 */
function InstallRegistry({ onInstall, row, taken }: InstallRegistryProps) {
  const { entry } = row
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(entry.inputs.map((input) => [input.key, input.defaultValue ?? ''])),
  )
  const [open, setOpen] = useState(false)

  const missing = missingRegistryInputs(entry, values)
  const name = availableServerName(entry.name, taken)
  /* 目录方给的提示（例如「运行时要经 Smithery CLI」）值得看一眼，但不能占满卡片。 */
  const hint = entry.warnings[0] ?? (entry.homepage === null ? undefined : entry.homepage)

  return (
    <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2">
      {entry.inputs.length === 0 ? null : (
        <button
          aria-expanded={open}
          className="mcp__text-btn text-[11px]"
          onClick={() => setOpen((was) => !was)}
          title={missing.length === 0 ? undefined : `还缺：${missing.join('、')}`}
          type="button"
        >
          {missing.length === 0 ? '已填输入' : `需要填写（${String(missing.length)}）`}
        </button>
      )}
      {hint === undefined ? null : (
        <span className="max-w-44 text-[11px] break-words text-muted-foreground" title={hint}>
          {entry.verified ? '已核验' : `${String(entry.useCount)} 人在用`}
        </span>
      )}
      <Button
        className="catalog-card__install-btn"
        disabled={missing.length > 0}
        onClick={() => {
          onInstall(name, registryServerBody(entry, values))
        }}
        size="xs"
        variant="soft"
      >
        安装
      </Button>
      {!open ? null : (
        <div className="flex w-full flex-col gap-1.5 pt-1">
          {entry.inputs.map((input) => (
            <label className="flex items-center gap-2" key={input.key}>
              <span className="min-w-28 text-[11px] text-muted-foreground">
                {input.label === '' ? input.key : input.label}
                {input.required ? '' : '（可选）'}
              </span>
              <input
                aria-label={input.key}
                className="h-7 min-w-0 flex-1 rounded-lg bg-muted/60 px-2.5 text-xs outline-none ring-1 ring-transparent transition-[background-color,box-shadow] focus:bg-background focus:ring-foreground/10"
                onChange={(event) => {
                  const next = event.target.value
                  setValues((was) => ({ ...was, [input.key]: next }))
                }}
                placeholder={input.sensitive ? '密钥' : (input.defaultValue ?? '')}
                title={input.description ?? undefined}
                type={input.sensitive ? 'password' : 'text'}
                value={values[input.key] ?? ''}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

interface SectionProps {
  readonly title: string
  readonly action?: ReactNode
  readonly children: ReactNode
}

function Section({ action, children, title }: SectionProps) {
  return (
    <section className="pt-9">
      <div className="flex items-center gap-4 pb-4">
        <h2 className="shrink-0 text-[13px] font-medium">{title}</h2>
        <span aria-hidden="true" className="h-0 min-w-8 flex-1 border-t" style={{ borderColor: 'var(--ui-sunken)' }} />
        {action === undefined ? null : <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  )
}
