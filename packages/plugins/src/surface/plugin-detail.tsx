import { Button, Switch } from '@poietica/ui'

import { describeInstallSource } from '../install-source'
import type { InstalledPlugin } from '../installation'
import type { MarketplaceEntry } from '../marketplace'
import type { PluginOrigin } from '../origin'
import type { PluginStore } from '../plugin-store'
import { PluginGlyph, pluginHue } from './plugin-glyph'
import { TrustBadge } from './trust-badge'

/*
 * 详情页。
 *
 * 技能与命令不在这一页逐条列。装载它们的是 CLI，能敲什么由 agent 报回来的那张命令表说
 * 了算 —— 「技能」那一格读的就是它。本应用自己扫一遍只会得到其中一部分（全局装的技能
 * 它看不见），两份清单并存就一定有一天对不上。这一页只说这个插件声明了什么、拨得动什么。
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
  const hue = pluginHue(id)
  const diagnostics = plugin?.diagnostics ?? []

  return (
    <div className="pb-20">
      <button
        className="pt-6 text-xs text-muted-foreground hover:text-foreground"
        onClick={onBack}
        type="button"
      >
        ← 插件
      </button>
      <header className="flex items-start gap-4 pt-4">
        <PluginGlyph displayName={displayName} id={id} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{displayName}</h1>
            <TrustBadge trust={trust} />
          </div>
          <p className="pt-1 text-sm text-muted-foreground">
            {description ?? '这个插件没有写说明。'}
          </p>
        </div>
        {plugin === undefined ? (
          <Button
            onClick={() => {
              if (entry !== undefined) {
                store.beginInstall(entry.source)
              }
            }}
            size="sm"
          >
            + 安装插件
          </Button>
        ) : (
          <Button onClick={() => store.remove(id)} size="sm" variant="secondary">
            卸载
          </Button>
        )}
      </header>
      {plugin === undefined ? null : <Behaviour plugin={plugin} />}
      {plugin === undefined ? null : <Capabilities plugin={plugin} store={store} />}
      <section className="pt-8">
        <h2 className="pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          信息
        </h2>
        <dl className="divide-y divide-divider border-y border-divider">
          <InfoRow label="功能" value={joinOrDash(plugin?.manifest.capabilities ?? [])} />
          <InfoRow label="开发者" value={plugin?.manifest.developerName ?? '未署名'} />
          <InfoRow label="版本" value={plugin?.manifest.version ?? entry?.version ?? '未标注'} />
          <InfoRow label="主页" value={plugin?.manifest.homepage ?? entry?.homepage ?? '没有'} />
          <InfoRow
            label="来源"
            value={
              plugin?.source === undefined
                ? entry === undefined
                  ? '手动放进插件目录'
                  : describeInstallSource(entry.source)
                : describeInstallSource(plugin.source)
            }
          />
        </dl>
      </section>
      {diagnostics.length === 0 ? null : (
        <section className="pt-8">
          <h2 className="pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            诊断
          </h2>
          <ul className="divide-y divide-divider border-y border-divider">
            {diagnostics.map((diagnostic) => (
              <li className="py-3 text-xs leading-5 text-muted-foreground" key={diagnostic.detail}>
                <span className="pr-2 font-medium text-foreground">{diagnostic.code}</span>
                {diagnostic.detail}
              </li>
            ))}
          </ul>
        </section>
      )}
      <div
        aria-hidden="true"
        className="mt-10 h-px w-full"
        style={{ backgroundImage: `linear-gradient(90deg, oklch(0.9 0.06 ${hue}), transparent)` }}
      />
    </div>
  )
}

function joinOrDash(values: readonly string[]): string {
  return values.length === 0 ? '未声明' : values.join('、')
}

interface BehaviourProps {
  readonly plugin: InstalledPlugin
}

function Behaviour({ plugin }: BehaviourProps) {
  const { commandRoots, mcpServerNames, promptSources, sessionStartSkill } = plugin.manifest
  const hue = pluginHue(plugin.pluginId)

  /* 每一条都是清单自己说的。数技能要读盘，而读盘是 CLI 的事，所以这里不数。 */
  const lines = [
    sessionStartSkill === undefined ? undefined : `新会话开始时自动装载技能 ${sessionStartSkill}`,
    commandRoots.length === 0 ? undefined : `带来命令，在对话里以 /${plugin.pluginId}: 前缀调用`,
    mcpServerNames.length === 0 ? undefined : `带来 ${mcpServerNames.length} 台 MCP 服务器`,
    promptSources.length === 0 ? undefined : '每次会话都会注入一段系统提示词',
  ].filter((line) => line !== undefined)

  if (lines.length === 0) {
    return null
  }

  return (
    <section
      className="mt-8 rounded-xl border border-divider p-5"
      style={{
        backgroundImage: `linear-gradient(135deg, oklch(0.97 0.03 ${hue}), transparent 70%)`,
      }}
    >
      <ul className="space-y-2">
        {lines.map((line) => (
          <li className="flex gap-2 text-sm leading-6" key={line}>
            <span aria-hidden="true" className="text-muted-foreground">
              →
            </span>
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

interface CapabilitiesProps {
  readonly plugin: InstalledPlugin
  readonly store: PluginStore
}

function Capabilities({ plugin, store }: CapabilitiesProps) {
  const { mcpServerNames } = plugin.manifest

  if (mcpServerNames.length === 0) {
    return null
  }

  const disabled = new Set(plugin.disabledMcpServers)
  /* 这一页只讲一个插件，它带来的每一台服务器都出自同一个来源。 */
  const origin: PluginOrigin = { kind: 'plugin', pluginId: plugin.pluginId }

  return (
    <section className="pt-8">
      <h2 className="pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        MCP 服务器
      </h2>
      <ul className="divide-y divide-divider border-y border-divider">
        {mcpServerNames.map((name) => (
          <li className="flex items-center gap-4 py-3" key={name}>
            <span className="flex-1 text-sm">{name}</span>
            <Switch
              aria-label={`启用 ${name}`}
              checked={!disabled.has(name)}
              onCheckedChange={(next) => store.setMcpServerEnabled(origin, name, next)}
              size="sm"
            />
          </li>
        ))}
      </ul>
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
