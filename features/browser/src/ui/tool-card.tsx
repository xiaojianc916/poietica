import type { ToolCallRendererProps } from '@poietica/feature-conversation/ui-api'
import { Globe } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import type { BrowserApi } from './api'
import type { BrowserPanelStore } from './store'
import { type BrowserCallModel, type BrowserStep, browserCallModel, revealTabFor } from './tool-card-model'
import './browser-tool-card.css'

/*
 * agent 那条线的浏览器工具卡片（07 页 §12E 的 `toolCallRenderers`）。
 *
 * 折叠行那句「浏览器 · <动作> <目标>」与 legacy 的 omp 浏览器视图同一套词汇，所以同一件事
 * 在两处读起来是同一句话。**产出形状只由 tool-card-model 解读** —— 浏览器是 eval 的
 * prelude（不是顶层工具），卡片这边一律读 `browserCallModel(...)`，不再碰 args.action
 * 或 details.screenshots 那套早期顶层工具的字段。
 *
 * 卡片要拿 api 与 store（「在面板中查看」要切标签），所以它是工厂：依赖由 ui/index.tsx
 * 的 setup 注入，与 widget-card 同一形制。
 */

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

/** 展开区最多画四张缩略图；再多也是同一屏的重复画面。 */
const SHOT_CAP = 4
/** 输出先给 12 行：够看清结论，又不至于把卡片撑到一屏。 */
const TEXT_LINES = 12
const LINE_CAP = 120

/** 折叠行上那两段之间用间隔号，与时间线其余「名字 · 主语」的行同一读法。 */
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

/*
 * 折叠行那句话：`浏览器 · <动作> <目标>`，多步时追加「等 N 步」。
 *
 * 还没有状态事件时（调用刚发出、prelude 第一条 status 还没到）退回代码首行 —— 这一格
 * 不能是空的：卡片在那几百毫秒里就该说清自己是什么。
 */
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

/** 一步一步一行：动作、标签、目标。认不出的 detail 就照原话说。 */
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

/*
 * 放大的那张图：原生 `<dialog>` 自带顶层与 Esc 关闭，一张截图不值得引一个灯箱库。
 *
 * 关闭有两条路 —— Esc（原生）与下面那枚按钮（点哪里都能关的写法要给 dialog 挂键盘处理，
 * 而这一层里能点的只有那张图，多一枚按钮比一个拦截点击的背景更直白）。
 */
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
        /* 打开是宿主的动作：showModal() 只为「进顶层」这一件事存在，React 没有对应属性。 */
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

/** 真正跑过的那几行。默认收起 —— 大多数时候读的是步骤与截图，代码是回查用的。 */
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

/** 展开区，自上而下：步骤、截图、代码、输出、错误。 */
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
  /** 打开右坞的浏览器那一格；store 里有对应标签时卡片自己再切一次。 */
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
