import { Button } from '@poietica/design-system'
import { useState } from 'react'
import {
  BUILTIN_SERVERS,
  type CatalogRow,
  type Launcher,
  mcpServerBody,
  type RowGroup,
  statusText,
} from '../index'

import { PluginGlyph } from './plugin-glyph'
import { Section } from './section'

const VISIBLE = 6

interface CatalogAction {
  readonly kind: 'server'
  readonly install: (name: string, body: Record<string, unknown>) => void
  readonly resolveLauncher: (program: string) => Promise<Launcher | null>
}

export interface CatalogGridProps {
  readonly groups: readonly RowGroup[]
  readonly action: CatalogAction
}

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
      count={group.rows.length}
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
    <li className="group flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-2 rounded-2xl px-3 py-3 transition-colors hover:bg-muted/60">
      <PluginGlyph displayName={row.displayName} id={row.id} size="md" />
      <div className="min-w-36 flex-1">
        <span className="block text-sm font-medium break-words">{row.displayName}</span>
        <span className="block pt-0.5 text-[13px] break-words text-muted-foreground">
          {row.description}
        </span>
      </div>
      {row.status.kind === 'installed' ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">{statusText(row.status)}</span>
      ) : (
        <InstallServer
          id={row.id}
          onInstall={action.install}
          resolveLauncher={action.resolveLauncher}
        />
      )}
    </li>
  )
}

interface InstallServerProps {
  readonly id: string
  readonly onInstall: (name: string, body: Record<string, unknown>) => void
  readonly resolveLauncher: (program: string) => Promise<Launcher | null>
}

/*
 * 内置名单是真安装：把这一台写进这个 agent 的 mcp.json。要人补钥匙的，那一格输入就长在
 * 卡片上 —— 装上才发现跑不起来，比多一格输入更糟。
 */
function InstallServer({ id, onInstall, resolveLauncher }: InstallServerProps) {
  const [filled, setFilled] = useState('')
  /* 这台机器上没有那个启动器时，安装当场把原因说出来，条目不写。 */
  const [absent, setAbsent] = useState<string | undefined>(undefined)

  const server = BUILTIN_SERVERS.find((one) => one.id === id)

  if (server === undefined) {
    return null
  }

  const missing = server.input?.required === true && filled.trim() === ''

  const install = (): void => {
    void (async () => {
      if (server.transport.kind === 'http') {
        const body = mcpServerBody(server, filled, null)

        if (body !== null) {
          onInstall(server.id, body)
        }

        return
      }

      const launcher = await resolveLauncher(server.transport.command)

      if (launcher === null) {
        setAbsent(`这台机器上没有 ${server.transport.command}`)

        return
      }

      const body = mcpServerBody(server, filled, launcher)

      if (body !== null) {
        onInstall(server.id, body)
      }
    })()
  }

  return (
    <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2">
      {absent === undefined ? (
        server.input === undefined ? (
          server.needs === undefined ? null : (
            <span
              className="max-w-44 text-[11px] break-words text-muted-foreground"
              title={server.needs}
            >
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
        )
      ) : (
        <span className="max-w-44 text-[11px] break-words text-destructive">{absent}</span>
      )}
      <Button disabled={missing} onClick={install} size="xs" variant="soft">
        安装
      </Button>
    </div>
  )
}
