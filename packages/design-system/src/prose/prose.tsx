import { invariant } from '@poietica/foundation'
import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { clsx } from 'clsx'
import { memo, useEffect, useSyncExternalStore } from 'react'
import {
  type ControlsConfig,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  type IconMap,
  type LinkSafetyConfig,
  type PluginConfig,
  Streamdown,
  type StreamdownProps,
  type StreamdownTranslations,
} from 'streamdown'
import { DIAGRAM_RENDERER } from './diagram'
import { FILE_HREF_PREFIX } from './file-ref'
import { asIcon, CheckIcon, CopyIcon } from './icons'
import { currentMath, loadMath, mayContainMath, subscribeMath } from './math-plugin'
import { ProseLink } from './prose-link'
import { remarkFileRefs } from './remark-file-refs'
import { ExportableTable } from './table-export'
import { useWaveReveal } from './wave/use-wave-reveal'

/* 插件表必须是稳定引用：Streamdown 按它的引用做 useMemo，每次给新对象就会重建处理链。 */
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
const COMPONENTS = { a: ProseLink, table: ExportableTable }

/* 图片走资产协议：streamdown 的默认净化链只放行 http/https 的 src，这里补的是**协议名**，
 * 不是放行任意地址：file://、data:、javascript: 仍在白名单之外。
 * 必须换整条链：rehypePlugins 是**替换**语义，少一环就等于把净化摘了。
 * 链接同理只补一个协议名：`poietica-file:` 是 remark-file-refs.ts 改写出来的本地文件地址，点击由 FileLink 拦下交给宿主，
 * 浏览器从不导航过去；file:、javascript: 依旧被摘。 */
const ASSET_SRC_SCHEME = 'poietica-asset'
const FILE_HREF_SCHEME = FILE_HREF_PREFIX.slice(0, -1)
type RehypeChain = NonNullable<StreamdownProps['rehypePlugins']>
type RehypeEntry = RehypeChain[number]

/* 只有元组形状带 schema；上游改名时那一格会缺席 —— 那时抛而不是静默跳过，
 * 少一环就等于把净化摘了，而那种失效在界面上看不出来。 */
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
      protocols: {
        ...protocols,
        href: [...(protocols.href ?? []), FILE_HREF_SCHEME],
        src: [...(protocols.src ?? []), ASSET_SRC_SCHEME],
      },
    },
  ] as RehypeEntry
}

/* remarkPlugins 也是**替换**语义：默认的 gfm 与 codeMeta 必须原样带上，文件引用接在它们之后（要认 gfm 的链接与表格里的代码）。 */
type RemarkChain = NonNullable<StreamdownProps['remarkPlugins']>
const REMARK_PLUGINS: RemarkChain = [...Object.values(defaultRemarkPlugins), remarkFileRefs]

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
  /* 流式淡入是批次波浪（use-wave-reveal.ts），不用 Streamdown 自带的逐字 animated */
  const wave = useWaveReveal(REHYPE_PLUGINS, streaming)
  return (
    <div className="timeline-prose-host" ref={wave.hostRef}>
      <Streamdown
        className={clsx('timeline-prose', wave.active && 'timeline-prose--wave', className)}
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
        remarkPlugins={REMARK_PLUGINS}
        tableMaxHeight={TABLE_CAP}
        translations={TRANSLATIONS}
      >
        {text}
      </Streamdown>
    </div>
  )
})
