import { Button } from '@poietica/design-system'
import { type ReactNode, useState } from 'react'
import { BUILTIN_SERVERS, type CatalogRow, mcpServerBody, type RowGroup, statusText } from './catalog'
import { PluginGlyph } from './plugin-glyph'

import './catalog-grid.css'

const VISIBLE = 6

interface CatalogAction {
  /** 把一条装进这个 agent 的 mcp.json；名字是名单里那个 id。 */
  readonly install: (name: string, body: Record<string, unknown>) => void
}

export interface CatalogGridProps {
  readonly groups: readonly RowGroup[]
  readonly action: CatalogAction
}

/*
 * 名单页的网格。**迁移自** legacy `packages/extension/src/ui/catalog-grid.tsx`：DOM、类名、
 * 文案、展开行为一字未改。去掉的只有 `resolveLauncher` —— 新架构没有原生启动器解析这条通道
 * （见 catalog.ts 的头注与 docs/refactor-log.md 偏差 22）。
 */
export function CatalogGrid({ action, groups }: CatalogGridProps) {
  if (groups.length === 0) {
    return null
  }

  return (
    <>
      {groups.map((group) => (
        <CatalogSection action={action} group={group} key={group.title} />
      ))}
    </>
  )
}

interface CatalogSectionProps {
  readonly group: RowGroup
  readonly action: CatalogAction
}

function CatalogSection({ action, group }: CatalogSectionProps) {
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
          <CatalogCard action={action} key={row.key} row={row} />
        ))}
      </ul>
    </Section>
  )
}

interface CatalogCardProps {
  readonly row: CatalogRow
  readonly action: CatalogAction
}

function CatalogCard({ action, row }: CatalogCardProps) {
  /*
   * 中间那列给了最小宽度而不是任由压扁：卡片变窄时动作区换到下一行，
   * 名字与说明完整换行显示，不会被挤成一两个字加省略号。
   */
  return (
    <li className="catalog-card group flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-2 rounded-2xl px-3 py-3 transition-colors">
      <PluginGlyph displayName={row.displayName} id={row.id} />
      <div className="min-w-36 flex-1">
        <span className="block text-sm font-medium break-words">{row.displayName}</span>
        <span className="block pt-0.5 text-[13px] truncate text-muted-foreground">{row.description}</span>
      </div>
      {row.status.kind === 'installed' ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">{statusText(row.status)}</span>
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

/*
 * 内置名单是真安装：把这一台写进这个 agent 的 mcp.json。要人补钥匙的，那一格输入就长在
 * 卡片上 —— 装上才发现跑不起来，比多一格输入更糟。
 */
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
