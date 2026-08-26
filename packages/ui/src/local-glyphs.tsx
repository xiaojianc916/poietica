import type { SVGProps } from 'react'

/**
 * 本地字形。
 *
 * 这些不是  @lucide/react 里的图标，改这个文件不会影响图标库，升级图标库
 * 也不会影响这里——放在设计系统里只是因为工作区外壳和 AI 界面都要用，字形不该
 * 有两份。
 *
 * 几何取自 Lucide（ISC 许可），放进图标库的默认视口：width=24 height=24
 * fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"
 * 圆头圆角（见  @lucide/react 仓库 icons/chevron-left.svg 原文）。描边而非实心，
 * 是因为实心字形无法与描边字形对齐视觉重量，也不随 currentColor 变化粗细。
 */

type GlyphProps = SVGProps<SVGSVGElement>

/*
 * 唯一的字形外框。属性表与图标库逐项一致，字形不各抄一遍；className 之类
 * 由调用方覆盖，所以 props 展开在后面。
 */
function Glyph({ children, ...props }: GlyphProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={24}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="var(--ui-icon-stroke, 2)"
      viewBox="0 0 24 24"
      width={24}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {children}
    </svg>
  )
}

/** arrow-left：返回。几何取自 Lucide 的 arrow-left。 */
export function ArrowLeftIcon(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </Glyph>
  )
}

/**
 * play：试运行。
 *
 * 描边而非实心：它与旁边的返回箭头同处一行，实心三角的视觉重量会明显压过
 * 描边字形，而这两颗按钮的分量本该相等。
 */
export function PlayIcon(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M6 4.5v15l12-7.5-12-7.5Z" />
    </Glyph>
  )
}

/**
 * 品牌标记。不走上面那个 Glyph 外框。
 *
 * 字形来自图标库、可替换、描边、粗细跟着 --ui-icon-stroke 走；标记来自商标持有者、
 * 不可重绘、实心、没有描边概念。后缀 Mark 就是为了在调用点分开这两类。
 */
function BrandMark({ children, ...props }: GlyphProps) {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      role="presentation"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {children}
    </svg>
  )
}

/**
 * GitHub 的官方标记，取自 GitHub 自己的图标库 Octicons（MIT）的 mark-github。
 *
 * 用 16 视口那一版而不是 24 视口版：16px 这一档是 GitHub 专门绘制的，内边距
 * 与拐点按这个尺寸调过。24 视口版铺满画布，放进 16px 盒子里会比旁边的描边字
 * 形明显重一档，要么缩小要么留白补偿 —— 而 tokens/controls.css 只允许 16 / 32
 * 两档尺寸（S / 16 必须在 dpr 1.5 下取整）。用官方在目标尺寸上的那一版，就不
 * 需要任何补偿。
 *
 * width / height 不写在这里：全局的 :where(svg) 规则已经把尺寸绑到 --ui-icon，
 * 那是零特异性的，调用方给 className 仍然能盖过去。
 */
export function GithubMark(props: GlyphProps) {
  return (
    <BrandMark viewBox="0 0 16 16" {...props}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </BrandMark>
  )
}
