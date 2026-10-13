import { invariant } from '@poietica/foundation'
import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { memo, useEffect, useSyncExternalStore } from 'react'
import {
  type ControlsConfig,
  defaultRehypePlugins,
  type IconMap,
  type LinkSafetyConfig,
  type PluginConfig,
  Streamdown,
  type StreamdownProps,
  type StreamdownTranslations,
} from 'streamdown'
import 'streamdown/styles.css'
import './prose.css'

import { cx } from '../../primitives/class-names'
import { asIcon, CheckIcon, CopyIcon } from '../../primitives/icons'
import { useWaveReveal } from '../wave/use-wave-reveal'
import { DIAGRAM_RENDERER } from './diagram'
import { currentMath, loadMath, mayContainMath, subscribeMath } from './math-plugin'
import { ProseLink } from './prose-link'
import { ExportableTable } from './table-export'

/*
 * 插件表必须是稳定引用：Streamdown 按 plugins.math / plugins.cjk 的引用做 useMemo，
 * 每次给新对象就会重建处理链。公式模块到达前用 BASE_PLUGINS，到达后所有 Prose 共用同一份
 * 带 math 的表（P-06：katex 按需加载，见 math-plugin.ts）。
 */
const BASE_PLUGINS: PluginConfig = { cjk, code, renderers: [DIAGRAM_RENDERER] }
let pluginsWithMath: PluginConfig | undefined

function useProsePlugins(text: string): PluginConfig {
  const math = useSyncExternalStore(subscribeMath, currentMath)
  const wanted = math === undefined && mayContainMath(text)
  useEffect(() => {
    /* 失败时正文保持源码显示；预取那一处（index.tsx）会记日志，这里不重复报 */
    if (wanted) void loadMath().catch(() => undefined)
  }, [wanted])
  if (math === undefined) return BASE_PLUGINS
  pluginsWithMath ??= { ...BASE_PLUGINS, math }
  return pluginsWithMath
}

/* 表格使用产品自己的导出控件，图片交互由媒体视图接管。 */
const CONTROLS: ControlsConfig = {
  code: { copy: true, download: false },
  image: false,
  table: false,
}

const TRANSLATIONS: Partial<StreamdownTranslations> = {
  copied: '已复制',
  copyCode: '复制代码',
  imageNotAvailable: '图片无法显示',
}

const ICONS: Partial<IconMap> = {
  CheckIcon: asIcon(CheckIcon),
  CopyIcon: asIcon(CopyIcon),
}

const LINK_SAFETY: LinkSafetyConfig = { enabled: false }
const CODE_CAP = 'var(--cp-timeline-code-cap)'
const TABLE_CAP = 0
/* 表格换成产品自己的导出控件；链接要带一枚显示地址的悬停提示。 */
const COMPONENTS = { a: ProseLink, table: ExportableTable }

/*
 * 助手产物里的图片走资产协议：地址形状与投递端都是 poietica-asset://（见
 * packages/host-kernel/src/asset-protocol.ts 与 features/attachments/src/host/asset-handler.ts）。streamdown 的默认净化链只放行
 * http/https 的 src，所以这里把协议的 scheme 补进它的 schema —— 补的是**协议名**，
 * 不是放行任意地址：file://、data:、javascript: 仍在默认白名单之外。
 *
 * 换的是整条链而不是加一个插件：Streamdown 的 rehypePlugins 是**替换**语义
 * （dist 的 Ja() 直接用 e.rehypePlugins 取代默认值），少一环就等于把净化摘了。
 */
const ASSET_SRC_SCHEME = 'poietica-asset'
type RehypeChain = NonNullable<StreamdownProps['rehypePlugins']>
type RehypeEntry = RehypeChain[number]

/*
 * 往净化 schema 的 src 协议表里补一个 scheme；只有元组形状带 schema，别的形状原样交回。
 *
 * 上游改名时那一格会缺席 —— 那时抛，而不是静默跳过：少一环就等于把净化摘了，
 * 而那种失效在界面上看不出来。
 */
function withAssetImages(entry: RehypeEntry | undefined): RehypeEntry {
  if (entry === undefined) {
    invariant(false, 'streamdown 的默认净化链改了形状：有一格不在了')
  }

  if (!Array.isArray(entry)) {
    return entry
  }

  const [plugin, schema] = entry as [RehypeEntry, Record<string, unknown> | undefined]
  const protocols = (schema?.protocols ?? {}) as Record<string, readonly string[]>

  return [
    plugin,
    {
      ...schema,
      protocols: { ...protocols, src: [...(protocols.src ?? []), ASSET_SRC_SCHEME] },
    },
  ] as RehypeEntry
}

const REHYPE_PLUGINS: RehypeChain = [
  withAssetImages(defaultRehypePlugins.raw),
  withAssetImages(defaultRehypePlugins.sanitize),
  withAssetImages(defaultRehypePlugins.harden),
]

export interface ProseProps {
  readonly text: string
  readonly streaming?: boolean
  readonly className?: string
  readonly mode?: StreamdownProps['mode']
  readonly codeBlockMaxHeight?: StreamdownProps['codeBlockMaxHeight']
}

export const Prose = memo(function Prose({
  className,
  codeBlockMaxHeight = CODE_CAP,
  mode = 'streaming',
  streaming = false,
  text,
}: ProseProps) {
  const plugins = useProsePlugins(text)
  /* 流式淡入是批次波浪（use-wave-reveal.ts，P-03），不用 Streamdown 自带的逐字 animated */
  const wave = useWaveReveal(REHYPE_PLUGINS, streaming)
  return (
    <div className="timeline-prose-host" ref={wave.hostRef}>
      <Streamdown
        className={cx('timeline-prose', wave.active && 'timeline-prose--wave', className)}
        codeBlockMaxHeight={codeBlockMaxHeight}
        components={COMPONENTS}
        controls={CONTROLS}
        icons={ICONS}
        isAnimating={streaming}
        lineNumbers={false}
        linkSafety={LINK_SAFETY}
        mode={mode}
        plugins={plugins}
        rehypePlugins={wave.rehypePlugins}
        tableMaxHeight={TABLE_CAP}
        translations={TRANSLATIONS}
      >
        {text}
      </Streamdown>
    </div>
  )
})
