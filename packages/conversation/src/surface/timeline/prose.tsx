import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { createMathPlugin } from '@streamdown/math'
import 'katex/dist/katex.min.css'
import { memo } from 'react'
import {
  type AnimateOptions,
  type ControlsConfig,
  type IconMap,
  type LinkSafetyConfig,
  type PluginConfig,
  Streamdown,
  type StreamdownProps,
  type StreamdownTranslations,
} from 'streamdown'
import 'streamdown/styles.css'
import '../composer/composer-metrics.css'
import './timeline.css'

import { cx } from '../primitives/class-names'
import { asIcon, CheckIcon, CopyIcon } from '../primitives/icons'
import { DIAGRAM_RENDERER } from './diagram'
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
const COMPONENTS = { table: ExportableTable }

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
      tableMaxHeight={TABLE_CAP}
      translations={TRANSLATIONS}
    >
      {text}
    </Streamdown>
  )
})
