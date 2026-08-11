import { Button } from '@poietica/ui'
import { useState } from 'react'

import { BUILTIN_SERVERS, mcpServerBody } from '../catalog/builtin'
import { type CatalogRow, type RowGroup, statusText } from '../catalog/listing'
import { describeChannel } from '../catalog/scope'
import type { PluginInstallSource } from '../install-source'
import { PluginGlyph } from './plugin-glyph'

/*
 * 分组网格。一组一个标题，组内两列，超出前四条折起来 —— 名单是几十条的量级，一次铺开
 * 人只会滚过去而不会读。折起的那几条没有被藏：标题下那个按钮写着还有几条。
 */

const VISIBLE = 4

export interface CatalogGridProps {
  readonly groups: readonly RowGroup[]
  /** 有详情页的行才给回调。内置 MCP 名单没有详情页，传 undefined。 */
  readonly onOpen: ((id: string) => void) | undefined
  readonly onInstall: (source: PluginInstallSource) => void
  /** 内置 MCP 名单的一键安装：把这一台写进这个 agent 的 mcp.json。插件名单传 undefined。 */
  readonly onInstallServer: ((name: string, body: Record<string, unknown>) => void) | undefined
}

export function CatalogGrid({ groups, onInstall, onInstallServer, onOpen }: CatalogGridProps) {
  return (
    <>
      {groups.map((group) => (
        <CatalogSection
          group={group}
          key={group.title}
          onInstall={onInstall}
          onInstallServer={onInstallServer}
          onOpen={onOpen}
        />
      ))}
    </>
  )
}

interface CatalogSectionProps {
  readonly group: RowGroup
  readonly onOpen: ((id: string) => void) | undefined
  readonly onInstall: (source: PluginInstallSource) => void
  readonly onInstallServer: ((name: string, body: Record<string, unknown>) => void) | undefined
}

function CatalogSection({ group, onInstall, onInstallServer, onOpen }: CatalogSectionProps) {
  const [expanded, setExpanded] = useState(false)

  const shown = expanded ? group.rows : group.rows.slice(0, VISIBLE)
  const rest = group.rows.length - shown.length

  return (
    <section className="pt-10">
      <h2 className="pb-3 text-sm font-medium">{group.title}</h2>
      <ul className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
        {shown.map((row) => (
          <CatalogCard
            key={row.key}
            onInstall={onInstall}
            onInstallServer={onInstallServer}
            onOpen={onOpen}
            row={row}
          />
        ))}
      </ul>
      {rest > 0 ? (
        <button
          className="pt-3 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded(true)}
          type="button"
        >
          显示其余 {rest} 个
        </button>
      ) : null}
    </section>
  )
}

interface CatalogCardProps {
  readonly row: CatalogRow
  readonly onOpen: ((id: string) => void) | undefined
  readonly onInstall: (source: PluginInstallSource) => void
  readonly onInstallServer: ((name: string, body: Record<string, unknown>) => void) | undefined
}

function CatalogCard({ onInstall, onInstallServer, onOpen, row }: CatalogCardProps) {
  return (
    <li className="flex items-center gap-3 py-2">
      <PluginGlyph displayName={row.displayName} id={row.id} size="sm" />
      <div className="min-w-0 flex-1">
        {onOpen === undefined ? (
          <span className="block truncate text-sm font-medium">{row.displayName}</span>
        ) : (
          <button
            className="block max-w-full truncate text-left text-sm font-medium"
            onClick={() => onOpen(row.id)}
            type="button"
          >
            {row.displayName}
          </button>
        )}
        <span className="block truncate text-xs text-muted-foreground">{row.description}</span>
      </div>
      <CardAction onInstall={onInstall} onInstallServer={onInstallServer} row={row} />
    </li>
  )
}

interface CardActionProps {
  readonly row: CatalogRow
  readonly onInstall: (source: PluginInstallSource) => void
  readonly onInstallServer: ((name: string, body: Record<string, unknown>) => void) | undefined
}

/*
 * 右边那个动作。已装的一律不给按钮，只写状态 —— 按下去什么也不发生的按钮比没有按钮坏。
 * 卸载不在卡片上：装上的那一台会出现在上方已装列表里，开关与移除都在那一行；公开名单
 * 的卡片只负责「装回来」，卸载之后它留在原处，状态拨回可安装。
 *
 * 内置名单是真安装：把这一台写进这个 agent 的 mcp.json。要人补钥匙或路径的，那一格
 * 输入就长在卡片上 —— 装上才发现跑不起来，比多一格输入更糟。
 */
function CardAction({ onInstall, onInstallServer, row }: CardActionProps) {
  if (row.status.kind === 'installed') {
    return (
      <span className="shrink-0 text-[11px] text-muted-foreground">{statusText(row.status)}</span>
    )
  }

  if (row.channel === 'builtin') {
    return onInstallServer === undefined ? null : (
      <InstallServer id={row.id} onInstall={onInstallServer} />
    )
  }

  const { source } = row

  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="text-[11px] text-muted-foreground">{describeChannel(row.channel)}</span>
      {source === undefined ? null : (
        <Button onClick={() => onInstall(source)} size="xs" variant="secondary">
          安装
        </Button>
      )}
    </div>
  )
}

interface InstallServerProps {
  readonly id: string
  readonly onInstall: (name: string, body: Record<string, unknown>) => void
}

function InstallServer({ id, onInstall }: InstallServerProps) {
  const [filled, setFilled] = useState('')

  const server = BUILTIN_SERVERS.find((one) => one.id === id)

  if (server === undefined) {
    return null
  }

  const missing = server.input?.required && filled.trim() === ''

  return (
    <div className="flex shrink-0 items-center gap-2">
      {server.input === undefined ? (
        server.needs === undefined ? null : (
          <span
            className="max-w-40 truncate text-[11px] text-muted-foreground"
            title={server.needs}
          >
            {server.needs}
          </span>
        )
      ) : (
        <input
          aria-label={server.input.label}
          className="h-7 w-40 rounded-md border border-divider bg-background px-2 text-xs outline-none focus:border-foreground/25"
          onChange={(event) => setFilled(event.target.value)}
          placeholder={server.input.placeholder}
          title={server.needs}
          value={filled}
        />
      )}
      <Button
        disabled={missing}
        onClick={() => onInstall(server.id, mcpServerBody(server, filled))}
        size="xs"
        variant="secondary"
      >
        安装
      </Button>
    </div>
  )
}
