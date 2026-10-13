import type { ToolCallRendererProps } from '@poietica/feature-conversation/ui-api'
import { Globe } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import type { BrowserApi } from './api'
import type { BrowserPanelStore } from './store'
import { type BrowserCallModel, type BrowserStep, browserCallModel, revealTabFor } from './tool-card-model'
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
const TEXT_LINES = 12
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

/* 折叠行那句话：`浏览器 · <动作> <目标>`，多步时追加「等 N 步」。还没有状态事件时退回代码首行 —— 那一格不能是空的。 */
function headlineOf(steps: readonly BrowserStep[], code: string | null): string {
  const [first] = steps

  if (first === undefined) {
    const opening = code === null ? null : oneLine(code)

    return opening === null ? '浏览器' : dot('浏览器', opening)
  }

  const action = BROWSER_ACTIONS[first.action] ?? first.action
  const rest = steps.length > 1 ? `等 ${String(steps.length)} 步` : null

  return dot('浏览器', join(action, first.target) || '浏览器', rest)
}

function StepLine({ step }: { readonly step: BrowserStep }): ReactNode {
  const action = BROWSER_ACTIONS[step.action] ?? step.action

  if (action === '') {
    return <li className="browser-tool__step">{step.said}</li>
  }

  return (
    <li className="browser-tool__step">
      <span className="browser-tool__step-action">{action}</span>
      {step.tab === null ? null : <span className="browser-tool__step-tab">{step.tab}</span>}
      {step.target === null ? null : <span className="browser-tool__step-target">{step.target}</span>}
    </li>
  )
}

function Steps({ steps }: { readonly steps: readonly BrowserStep[] }): ReactNode {
  if (steps.length === 0) {
    return null
  }

  return (
    <ul className="browser-tool__steps">
      {steps.map((step) => (
        <StepLine key={step.said} step={step} />
      ))}
    </ul>
  )
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

function CodeBlock({ code, language }: { readonly code: string; readonly language: 'js' | 'py' }): ReactNode {
  return (
    <details className="browser-tool__details">
      <summary className="browser-tool__summary">代码</summary>
      <pre className="browser-tool__code" data-language={language === 'py' ? 'python' : 'javascript'}>
        {code}
      </pre>
    </details>
  )
}

function Output({ text }: { readonly text: string }): ReactNode {
  const [all, setAll] = useState(false)

  if (text === '') {
    return null
  }

  const lines = text.split('\n')
  const clipped = !all && lines.length > TEXT_LINES

  return (
    <div className="browser-tool__output" data-browser-output="">
      <pre className="browser-tool__text">{clipped ? lines.slice(0, TEXT_LINES).join('\n') : text}</pre>
      {clipped ? (
        <button
          className="browser-tool__more"
          onClick={() => {
            setAll(true)
          }}
          type="button"
        >
          显示全部 {String(lines.length)} 行
        </button>
      ) : null}
    </div>
  )
}

function CardBody({ model, onReveal }: { readonly model: BrowserCallModel; readonly onReveal: () => void }): ReactNode {
  return (
    <div className="browser-tool__body">
      <Steps steps={model.steps} />
      <Shots images={model.images} />
      {model.code === null ? null : <CodeBlock code={model.code} language={model.language} />}
      <Output text={model.text} />

      {model.error === null ? null : (
        <p className="browser-tool__error" data-browser-error="">
          {model.error}
        </p>
      )}

      <div className="browser-tool__actions">
        <button className="browser-tool__open" onClick={onReveal} type="button">
          在面板中查看
        </button>
      </div>
    </div>
  )
}

export interface BrowserToolCardDeps {
  readonly api: BrowserApi
  readonly store: BrowserPanelStore
  readonly openPanel: () => void
  readonly report: (message: string, cause?: unknown) => void
}

export function createBrowserToolCard(deps: BrowserToolCardDeps) {
  return function BrowserToolCard({ args, result, status }: ToolCallRendererProps): ReactNode {
    const model = browserCallModel(args, result, status === 'failed')
    const [open, setOpen] = useState(false)

    const reveal = (): void => {
      deps.openPanel()

      const state = deps.store.snapshot()
      const tabId = state === null ? null : revealTabFor(state, model.lastUrl)

      if (tabId !== null) {
        void deps.api.selectTab(tabId).catch((cause: unknown) => {
          deps.report('标签页没能切换', cause)
        })
      }
    }

    return (
      <section className="timeline-tool browser-tool" data-browser-tool="">
        <button
          aria-expanded={open}
          className="timeline-row browser-tool__row"
          onClick={() => {
            setOpen(!open)
          }}
          type="button"
        >
          <Globe aria-hidden className="timeline-row__icon" />
          <span className="timeline-row__label">{headlineOf(model.steps, model.code)}</span>
          {status === 'running' ? <span className="browser-tool__status">进行中</span> : null}
          {status === 'failed' ? <span className="browser-tool__status browser-tool__status--failed">失败</span> : null}
        </button>

        {open ? <CardBody model={model} onReveal={reveal} /> : null}
      </section>
    )
  }
}
