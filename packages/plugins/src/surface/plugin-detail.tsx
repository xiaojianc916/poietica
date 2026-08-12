import { Button, Switch } from '@poietica/ui'
import type { ReactNode } from 'react'

import { describeInstallSource } from '../install-source'
import type { InstalledPlugin } from '../installation'
import type { MarketplaceEntry } from '../marketplace'
import type { PluginOrigin } from '../origin'
import type { PluginStore } from '../plugin-store'
import { PluginGlyph } from './plugin-glyph'
import { TrustBadge } from './trust-badge'

/*
 * 详情页：一个扩展的家。骨架是市场详情页的通用形状 —— 面包屑、主操作区、能力分组、信息表。
 *
 * 技能与命令不逐条列。装载它们的是 CLI，能敲什么由 agent 报回来的那张命令表说了算 ——
 * 「技能」那一格读的就是它。本应用自己扫一遍只会得到其中一部分（全局装的技能它看不见），
 * 两份清单并存就一定有一天对不上。这一页只说这个插件声明了什么、拨得动什么。
 */

export interface PluginDetailProps {
  readonly entry: MarketplaceEntry | undefined
  readonly plugin: InstalledPlugin | undefined
  readonly store: PluginStore
  readonly onBack: () => void
}

export function PluginDetail({ entry, onBack, plugin, store }: PluginDetailProps) {
  const id = plugin?.pluginId ?? entry?.id ?? ''
  const displayName = plugin?.manifest.displayName ?? entry?.displayName ?? id
  const description = plugin?.manifest.description ?? entry?.description
  const trust = plugin?.trust ?? entry?.trust ?? 'third-party'
  const developer = plugin?.manifest.developerName
  const version = plugin?.manifest.version ?? entry?.version
  const keywords = entry?.keywords ?? []

  return (
    <div className="pb-20">
      <nav aria-label="面包屑" className="flex items-center gap-1.5 pt-6 text-xs">
        <button
          className="text-muted-foreground transition-colors hover:text-foreground"
          onClick={onBack}
          type="button"
        >
          扩展
        </button>
        <span aria-hidden="true" className="text-muted-foreground">
          ›
        </span>
        <span className="min-w-0 truncate font-medium">{displayName}</span>
      </nav>
      <header className="flex items-start gap-4 pt-6">
        <PluginGlyph displayName={displayName} id={id} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{displayName}</h1>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1.5 text-xs text-muted-foreground">
            {developer === undefined ? null : <span>{developer}</span>}
            <TrustBadge trust={trust} />
            {version === undefined ? null : <span>v{version}</span>}
            {plugin?.installedAt === undefined ? null : (
              <span>装于 {new Date(plugin.installedAt).toLocaleDateString()}</span>
            )}
          </div>
        </div>
        <PluginActions
          displayName={displayName}
          entry={entry}
          onBack={onBack}
          plugin={plugin}
          store={store}
        />
      </header>
      <p className="max-w-prose pt-4 text-sm leading-6 text-muted-foreground">
        {description ?? '这个扩展没有写说明。'}
      </p>
      {keywords.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1.5 pt-3">
          {keywords.map((keyword) => (
            <li
              className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
              key={keyword}
            >
              {keyword}
            </li>
          ))}
        </ul>
      )}
      {plugin === undefined ? (
        <p className="pt-8 text-xs leading-5 text-muted-foreground">
          清单要装上之后才读得到 —— 目录只记来源、说明与分类。装好后这里会列出它带来的 MCP
          服务器与行为。
        </p>
      ) : (
        <>
          <Behaviour plugin={plugin} />
          <McpServers plugin={plugin} store={store} />
        </>
      )}
      <DetailSection title="信息">
        <dl className="divide-y divide-divider border-y border-divider">
          {plugin === undefined ? null : (
            <>
              <InfoRow label="功能" value={joinOrDash(plugin.manifest.capabilities)} />
              <InfoRow label="开发者" value={developer ?? '未署名'} />
            </>
          )}
          <InfoRow label="版本" value={version ?? '未标注'} />
          <InfoRow label="主页" value={plugin?.manifest.homepage ?? entry?.homepage ?? '没有'} />
          <InfoRow label="来源" value={pluginSourceDescription(plugin, entry)} />
        </dl>
      </DetailSection>
      <Diagnostics plugin={plugin} />
    </div>
  )
}

interface PluginActionsProps {
  readonly displayName: string
  readonly entry: MarketplaceEntry | undefined
  readonly plugin: InstalledPlugin | undefined
  readonly store: PluginStore
  readonly onBack: () => void
}

function PluginActions({ displayName, entry, onBack, plugin, store }: PluginActionsProps) {
  if (plugin === undefined) {
    if (entry === undefined) {
      return null
    }

    return (
      <Button
        onClick={() => {
          /* 确认卡与安装进度挂在列表视图上，留在这一页会看不见流程。 */
          store.beginInstall(entry.source)
          onBack()
        }}
        size="sm"
      >
        安装
      </Button>
    )
  }

  return (
    <div className="flex items-center gap-3">
      <Switch
        aria-label={`启用 ${displayName}`}
        checked={plugin.enabled}
        onCheckedChange={(next) => store.setEnabled(plugin.pluginId, next)}
        size="sm"
      />
      <Button
        onClick={() => {
          store.remove(plugin.pluginId)
          onBack()
        }}
        size="sm"
        variant="secondary"
      >
        移除
      </Button>
    </div>
  )
}

function pluginSourceDescription(
  plugin: InstalledPlugin | undefined,
  entry: MarketplaceEntry | undefined,
): string {
  const source = plugin === undefined ? entry?.source : plugin.source
  return source === undefined ? '账本没记它从哪来' : describeInstallSource(source)
}

function joinOrDash(values: readonly string[]): string {
  return values.length === 0 ? '未声明' : values.join('、')
}

interface BehaviourProps {
  readonly plugin: InstalledPlugin
}

/* 每一条都是清单自己说的。数技能要读盘，而读盘是 CLI 的事，所以这里不数。 */
function Behaviour({ plugin }: BehaviourProps) {
  const { commandRoots, promptSources, sessionStartSkill } = plugin.manifest

  const lines = [
    sessionStartSkill === undefined ? undefined : `新会话开始时自动装载技能 ${sessionStartSkill}`,
    commandRoots.length === 0 ? undefined : `带来命令，在对话里以 /${plugin.pluginId}: 前缀调用`,
    promptSources.length === 0 ? undefined : '每次会话都会注入一段系统提示词',
  ].filter((line) => line !== undefined)

  if (lines.length === 0) {
    return null
  }

  return (
    <DetailSection title="行为">
      <ul className="divide-y divide-divider border-y border-divider">
        {lines.map((line) => (
          <li className="py-3 text-sm leading-6" key={line}>
            {line}
          </li>
        ))}
      </ul>
    </DetailSection>
  )
}

interface McpServersProps {
  readonly plugin: InstalledPlugin
  readonly store: PluginStore
}

function McpServers({ plugin, store }: McpServersProps) {
  const { mcpServerNames } = plugin.manifest

  if (mcpServerNames.length === 0) {
    return null
  }

  const disabled = new Set(plugin.disabledMcpServers)
  /* 这一页只讲一个插件，它带来的每一台服务器都出自同一个来源。 */
  const origin: PluginOrigin = { kind: 'plugin', pluginId: plugin.pluginId }

  return (
    <DetailSection count={mcpServerNames.length} title="MCP 服务器">
      <ul className="divide-y divide-divider border-y border-divider">
        {mcpServerNames.map((name) => (
          <li className="flex items-center gap-4 py-3" key={name}>
            <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
            <Switch
              aria-label={`启用 ${name}`}
              checked={!disabled.has(name)}
              onCheckedChange={(next) => store.setMcpServerEnabled(origin, name, next)}
              size="sm"
            />
          </li>
        ))}
      </ul>
    </DetailSection>
  )
}

interface DiagnosticsProps {
  readonly plugin: InstalledPlugin | undefined
}

function Diagnostics({ plugin }: DiagnosticsProps) {
  const diagnostics = plugin?.diagnostics ?? []

  if (diagnostics.length === 0) {
    return null
  }

  return (
    <DetailSection count={diagnostics.length} title="诊断">
      <ul className="divide-y divide-divider border-y border-divider">
        {diagnostics.map((diagnostic) => (
          <li className="py-3 text-xs leading-5 text-muted-foreground" key={diagnostic.detail}>
            <span className="pr-2 font-medium text-foreground">{diagnostic.code}</span>
            {diagnostic.detail}
          </li>
        ))}
      </ul>
    </DetailSection>
  )
}

interface DetailSectionProps {
  readonly title: string
  readonly count?: number
  readonly children: ReactNode
}

function DetailSection({ children, count, title }: DetailSectionProps) {
  return (
    <section className="pt-8">
      <h2 className="flex items-center gap-2 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
        {count === undefined ? null : (
          <span className="rounded-full bg-muted px-1.5 font-normal">{count}</span>
        )}
      </h2>
      {children}
    </section>
  )
}

interface InfoRowProps {
  readonly label: string
  readonly value: string
}

function InfoRow({ label, value }: InfoRowProps) {
  return (
    <div className="flex gap-4 py-3">
      <dt className="w-24 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 truncate text-xs">{value}</dd>
    </div>
  )
}
