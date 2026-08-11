import { Button } from '@poietica/ui'
import { useState } from 'react'

import { BUILTIN_SERVERS, mcpConfigFragment } from '../catalog/builtin'
import { type CatalogRow, type RowGroup, statusText } from '../catalog/listing'
import { describeChannel } from '../catalog/scope'
import type { PluginInstallSource } from '../install-source'
import { PluginGlyph } from './plugin-glyph'

/*
 * 分组网格。
 *
 * 一组一个标题，组内两列，超出前四条折起来 —— 名单是几十条的量级，一次铺开人只会滚过去
 * 而不会读。折起来的那几条不是被藏了：标题下那个按钮写着还有几条。
 */

const VISIBLE = 4

export interface CatalogGridProps {
  readonly groups: readonly RowGroup[]
  /** 有详情页的行才给回调。内置 MCP 名单没有详情页，传 undefined。 */
  readonly onOpen: ((id: string) => void) | undefined
  readonly onInstall: (source: PluginInstallSource) => void
}

export function CatalogGrid({ groups, onInstall, onOpen }: CatalogGridProps) {
  return (
    <>
      {groups.map((group) => (
        <CatalogSection group={group} key={group.title} onInstall={onInstall} onOpen={onOpen} />
      ))}
    </>
  )
}

interface CatalogSectionProps {
  readonly group: RowGroup
  readonly onOpen: ((id: string) => void) | undefined
  readonly onInstall: (source: PluginInstallSource) => void
}

function CatalogSection({ group, onInstall, onOpen }: CatalogSectionProps) {
  const [expanded, setExpanded] = useState(false)

  const shown = expanded ? group.rows : group.rows.slice(0, VISIBLE)
  const rest = group.rows.length - shown.length

  return (
    <section className="pt-10">
      <h2 className="pb-3 text-sm font-medium">{group.title}</h2>
      <ul className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
        {shown.map((row) => (
          <CatalogCard key={row.key} onInstall={onInstall} onOpen={onOpen} row={row} />
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
}

function CatalogCard({ onInstall, onOpen, row }: CatalogCardProps) {
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
      <CardAction onInstall={onInstall} row={row} />
    </li>
  )
}

interface CardActionProps {
  readonly row: CatalogRow
  readonly onInstall: (source: PluginInstallSource) => void
}

/*
 * 右边那个动作。
 *
 * 已装的一律不给按钮，只写状态 —— 按下去什么也不发生的按钮比没有按钮坏。
 *
 * 内置名单给的是「复制配置」而不是「安装」：装一台 MCP 服务器要写这个 agent 的 mcp.json，
 * 而本应用现在只读那个文件（origin.ts 的 ManagedOrigin 在类型上就把它排除在外，写入通道
 * 需要一条新的原生命令）。在那条通道打通之前，把能直接粘贴的那段交到人手上是唯一诚实的
 * 做法 —— 它真的能用，只是要两步。
 */
function CardAction({ onInstall, row }: CardActionProps) {
  if (row.status.kind === 'installed') {
    return (
      <span className="shrink-0 text-[11px] text-muted-foreground">{statusText(row.status)}</span>
    )
  }

  if (row.channel === 'builtin') {
    return <CopyConfig id={row.id} />
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

interface CopyConfigProps {
  readonly id: string
}

function CopyConfig({ id }: CopyConfigProps) {
  const [copied, setCopied] = useState(false)

  const server = BUILTIN_SERVERS.find((one) => one.id === id)

  if (server === undefined) {
    return null
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      {server.needs === undefined ? null : (
        <span className="max-w-40 truncate text-[11px] text-muted-foreground" title={server.needs}>
          {server.needs}
        </span>
      )}
      <Button
        onClick={() => {
          void navigator.clipboard.writeText(mcpConfigFragment(server)).then(() => {
            setCopied(true)
          })
        }}
        size="xs"
        variant="secondary"
      >
        {copied ? '已复制' : '复制配置'}
      </Button>
    </div>
  )
}
