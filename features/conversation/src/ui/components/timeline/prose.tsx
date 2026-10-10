import { invariant } from '@poietica/foundation'
import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { createMathPlugin } from '@streamdown/math'
import 'katex/dist/katex.min.css'
import { memo } from 'react'
import {
  type AnimateOptions,
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
import './timeline.css'

import { cx } from '../primitives/class-names'
import { asIcon, CheckIcon, CopyIcon } from '../primitives/icons'
import { DIAGRAM_RENDERER } from './diagram'
import { ProseLink } from './prose-link'
import { ExportableTable } from './table-export'

/* 单美元号按公式处理；成对货币符号也可能被识别为公式。 */
const MATH = createMathPlugin({ singleDollarTextMath: true })
const PLUGINS: PluginConfig = { cjk, code, math: MATH, renderers: [DIAGRAM_RENDERER] }

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

/* 中文没有词间空格；按字揭示，并限制积压动画的时长。 */
const REVEAL: AnimateOptions = {
  duration: 120,
  easing: 'ease-out',
  maxBacklogMs: 160,
  sep: 'char',
  stagger: 12,
}

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
  return (
    <Streamdown
      animated={REVEAL}
      className={cx('timeline-prose', className)}
      codeBlockMaxHeight={codeBlockMaxHeight}
      components={COMPONENTS}
      controls={CONTROLS}
      icons={ICONS}
      isAnimating={streaming}
      lineNumbers={false}
      linkSafety={LINK_SAFETY}
      mode={mode}
      plugins={PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      tableMaxHeight={TABLE_CAP}
      translations={TRANSLATIONS}
    >
      {text}
    </Streamdown>
  )
})
