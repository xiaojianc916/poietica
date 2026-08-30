import { Button } from '@poietica/design-system'
import { resolveLauncher } from '@poietica/native-bridge'
import { useState } from 'react'

import { BUILTIN_SERVERS, mcpServerBody } from '../catalog/builtin'
import { type CatalogRow, type RowGroup, statusText } from '../catalog/listing'
import { describeChannel } from '../catalog/scope'
import type { PluginInstallSource } from '../install-source'
import { PluginGlyph } from './plugin-glyph'
import { Section } from './section'

/*
 * 「发现」那一段：一组一个抬头，组内两列，超出前六条折起来。名单是几十条的量级，
 * 一次铺开人只会滚过去而不会读；折起的那几条没有被藏，按钮上写着还剩几条。
 *
 * 动作是一个判别联合，不是三个可缺席的回调。此前这里靠 onOpen / onInstallServer 是不是
 * undefined 反推「我现在是哪一格」—— 三态藏在两个可选属性里，技能格的调用处一次传两个
 * undefined，而加第四种用法时没有任何东西会报错。现在这一格是什么，写在类型上。
 */

const VISIBLE = 6

export type CatalogAction =
  | {
      readonly kind: 'plugin'
      readonly install: (source: PluginInstallSource) => void
      readonly open: (id: string) => void
    }
  | { readonly kind: 'skill'; readonly install: (source: PluginInstallSource) => void }
  | {
      readonly kind: 'server'
      readonly install: (name: string, body: Record<string, unknown>) => void
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
  return (
    <li className="group flex min-w-0 items-center gap-3.5 rounded-2xl px-3 py-3 transition-colors hover:bg-muted/60">
      <PluginGlyph displayName={row.displayName} id={row.id} size="md" />
      <div className="min-w-0 flex-1">
        {action.kind === 'plugin' ? (
          <button
            className="block max-w-full truncate text-left text-sm font-medium hover:underline"
            onClick={() => action.open(row.id)}
            type="button"
          >
            {row.displayName}
          </button>
        ) : (
          <span className="block truncate text-sm font-medium">{row.displayName}</span>
        )}
        <span
          className="block truncate pt-0.5 text-[13px] text-muted-foreground"
          title={row.description}
        >
          {row.description}
        </span>
      </div>
      {row.status.kind === 'installed' ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">{statusText(row.status)}</span>
      ) : (
        <CardAction action={action} row={row} />
      )}
    </li>
  )
}

/*
 * 右边那个动作。已装的一律不给按钮，只写状态 —— 按下去什么也不发生的按钮比没有按钮坏。
 * 卸载不在卡片上：装上的那一条会出现在上方「已安装」里，开关与移除都在那一行；公开名单
 * 的卡片只负责装回来，卸载之后它留在原处，状态拨回可安装。
 *
 * 来源那行小字悬停才浮出：它是给要判断「这是谁的东西」的人看的，不是每一行都要占的位。
 */
function CardAction({ action, row }: CatalogCardProps) {
  if (action.kind === 'server') {
    return <InstallServer id={row.id} onInstall={action.install} />
  }

  const { source } = row

  if (source === undefined) {
    return null
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
        {describeChannel(row.channel)}
      </span>
      <Button onClick={() => action.install(source)} size="xs" variant="soft">
        安装
      </Button>
    </div>
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
    <div className="flex shrink-0 items-center gap-2">
      {absent === undefined ? (
        server.input === undefined ? (
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
            className="h-7 w-40 rounded-lg bg-muted/60 px-2.5 text-xs outline-none ring-1 ring-transparent transition-[background-color,box-shadow] focus:bg-background focus:ring-foreground/10"
            onChange={(event) => setFilled(event.target.value)}
            placeholder={server.input.placeholder}
            title={server.needs}
            value={filled}
          />
        )
      ) : (
        <span className="max-w-40 truncate text-[11px] text-destructive">{absent}</span>
      )}
      <Button disabled={missing} onClick={install} size="xs" variant="soft">
        安装
      </Button>
    </div>
  )
}
