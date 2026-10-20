import type { ToolCallRendererProps } from '@poietica/feature-conversation/ui-api'
import { ChevronDown, Globe } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { type BrowserCallModel, type BrowserStep, browserCallModel } from './tool-card-model'
import './browser-tool-card.css'

/* agent 那条线的浏览器工具卡片。折叠行那句「浏览器 · <动作> <目标>」与 legacy 的 omp 浏览器视图同一套词汇。
 * **产出形状只由 tool-card-model 解读** —— 一律读 browserCallModel(...)，不碰 args.action 或
 * details.screenshots 那套早期顶层工具的字段。依赖由 setup 注入，所以是工厂。 */

const BROWSER_ACTIONS: Readonly<Record<string, string>> = {
  call: '调用标签页',
  click: '点击',
  close: '关闭标签页',
  extract: '提取内容',
  fill: '填写',
  goto: '前往',
  observe: '查看页面',
  open: '打开',
  press: '按键',
  run: '执行脚本',
  screenshot: '截图',
  tabs: '列出标签页',
  type: '输入',
  waitFor: '等待',
}

const SHOT_CAP = 4
const LINE_CAP = 120

function dot(...parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part !== '').join(' · ')
}

function join(...parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part !== '').join(' ')
}

function oneLine(value: string): string {
  const cut = value.indexOf('\n')
  const said = (cut === -1 ? value : value.slice(0, cut)).trim()

  return said.length > LINE_CAP ? `${said.slice(0, LINE_CAP)}…` : said
}

/* 一步印在折叠行上的那句话：**一步一行**，`浏览器 · <动作> <目标>`。还没有状态事件时（预判期间）退回代码首行 —— 那一格不能是空的。 */
function lineOf(step: BrowserStep, code: string | null): string {
  if (step.action === '') {
    const said = step.said !== '' ? step.said : code === null ? '' : oneLine(code)

    return said === '' ? '浏览器' : dot('浏览器', said)
  }

  return dot('浏览器', join(BROWSER_ACTIONS[step.action] ?? step.action, step.target) || '浏览器')
}

/* 截图与代码各归各自那一步：有截图步就只归截图步，有执行脚本步就归脚本步；
 * 老会话只有一条 open 时两者都没有，退回最后一步（那时图与代码确实是那次调用唯一的产出）。 */
function stepIndexOf(steps: readonly BrowserStep[], actions: readonly string[]): number {
  for (let at = steps.length - 1; at >= 0; at -= 1) {
    const action = steps[at]?.action ?? ''
    if (actions.includes(action)) {
      return at
    }
  }

  return -1
}

/* 还没有状态事件时用代码首行垫一行，让折叠行不是空的。 */
function placeholderStep(code: string | null): BrowserStep {
  return { action: '', tab: null, target: null, said: code === null ? '' : oneLine(code) }
}

/* 放大的那张图：原生 dialog 自带顶层与 Esc 关闭，一张截图不值得引一个灯箱库。 */
function ZoomDialog({
  alt,
  onClose,
  src,
}: {
  readonly alt: string
  readonly onClose: () => void
  readonly src: string
}) {
  return (
    <dialog
      aria-label={alt}
      className="browser-tool__zoom"
      onClose={onClose}
      ref={(element) => {
        element?.showModal()
      }}
    >
      <img alt={alt} src={src} />
      <button className="browser-tool__zoom-close" onClick={onClose} type="button">
        关闭
      </button>
    </dialog>
  )
}

function Shots({ images }: { readonly images: BrowserCallModel['images'] }): ReactNode {
  const [zoomed, setZoomed] = useState<BrowserCallModel['images'][number] | null>(null)

  if (images.length === 0) {
    return null
  }

  return (
    <div className="browser-tool__shots">
      {images.slice(0, SHOT_CAP).map((image) => (
        <button
          className="browser-tool__shot"
          key={image.src}
          onClick={() => {
            setZoomed(image)
          }}
          type="button"
        >
          <img alt={image.alt} decoding="async" draggable={false} src={image.src} />
        </button>
      ))}

      {zoomed === null ? null : (
        <ZoomDialog
          alt={zoomed.alt}
          onClose={() => {
            setZoomed(null)
          }}
          src={zoomed.src}
        />
      )}
    </div>
  )
}

/* 代码就是这一步的内容：展开即全文，不再套一层「代码」折叠。 */
function CodeBlock({ code, language }: { readonly code: string; readonly language: 'js' | 'py' }): ReactNode {
  return (
    <pre className="browser-tool__code" data-language={language === 'py' ? 'python' : 'javascript'}>
      {code}
    </pre>
  )
}

/* 产出就是全文：面板自己滚，不再折成「显示全部 N 行」—— 那一行按钮点开也只是同一段字。 */
function Output({ text }: { readonly text: string }): ReactNode {
  if (text === '') {
    return null
  }

  return (
    <div className="browser-tool__output" data-browser-output="">
      <pre className="browser-tool__text">{text}</pre>
    </div>
  )
}
function StepBody({
  at,
  codeAt,
  model,
  shotsAt,
  step,
}: {
  readonly at: number
  readonly codeAt: number
  readonly model: BrowserCallModel
  readonly shotsAt: number
  readonly step: BrowserStep
}): ReactNode {
  /* 截图那一步只有图片预览：截图要看的本来就是那张图，正文是工具的旁白，不该铺在下面。
   * 执行脚本那一步是代码 + 产出（正文与错误）；其余步骤没有可画的就退回自己的原话。
   * 老会话只有一条 open、没有单列截图那一步时，图与代码落在同一格，两样都画。 */
  const shots = at === shotsAt && model.images.length > 0
  const code = at === codeAt && model.code !== null

  if (shots && at !== codeAt) {
    return (
      <div className="browser-tool__preview">
        <Shots images={model.images} />
      </div>
    )
  }

  const returned = at === codeAt && (model.text !== '' || model.error !== null)

  return (
    <div className="timeline-tool__body">
      <div className="timeline-tool__panel browser-tool__panel">
        {shots ? <Shots images={model.images} /> : null}
        {code && model.code !== null ? <CodeBlock code={model.code} language={model.language} /> : null}
        {at === codeAt ? <Output text={model.text} /> : null}
        {at === codeAt && model.error !== null ? (
          <p className="browser-tool__error" data-browser-error="">
            {model.error}
          </p>
        ) : null}
        {code || returned ? null : (
          <p className="browser-tool__said">{step.said === '' ? '浏览器没有返回内容。' : step.said}</p>
        )}
      </div>
    </div>
  )
}
/* 一次 eval 里每一步各成一行工具调用（图标、一句话、箭头，与别的工具行同一副长相），不再并成「等 N 步」。 */
export function BrowserToolCard({ args, result, status }: ToolCallRendererProps): ReactNode {
  const model = browserCallModel(args, result, status === 'failed')
  const [openAt, setOpenAt] = useState<number | null>(null)
  const steps = model.steps.length === 0 ? [placeholderStep(model.code)] : model.steps
  const shotStep = stepIndexOf(steps, ['screenshot'])
  const runStep = stepIndexOf(steps, ['run', 'call'])
  const legacy = shotStep < 0 && runStep < 0
  const shotsAt = shotStep >= 0 ? shotStep : legacy ? steps.length - 1 : -1
  const codeAt = runStep >= 0 ? runStep : legacy ? steps.length - 1 : -1

  return (
    <>
      {steps.map((step, at) => {
        const open = openAt === at
        const last = at === steps.length - 1
        return (
          <section className="timeline-tool browser-tool" data-browser-tool="" key={`${step.said}:${String(at)}`}>
            <button
              aria-expanded={open}
              className="timeline-row browser-tool__row"
              data-browser-step=""
              onClick={() => {
                setOpenAt(open ? null : at)
              }}
              type="button"
            >
              <Globe aria-hidden className="timeline-row__icon" />
              <span className="timeline-row__label">{lineOf(step, model.code)}</span>
              {last && status === 'running' ? <span className="browser-tool__status">进行中</span> : null}

              <ChevronDown aria-hidden className="timeline-row__chevron disclosure__chevron" />
            </button>

            {open ? <StepBody at={at} codeAt={codeAt} model={model} shotsAt={shotsAt} step={step} /> : null}
          </section>
        )
      })}
    </>
  )
}
