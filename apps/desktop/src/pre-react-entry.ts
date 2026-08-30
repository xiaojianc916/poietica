import { installFatalCollectors } from './failures/browser-collectors'
import { failureCoordinator } from './failures/coordinator'
import { isReactFatalHostMounted } from './failures/terminal-policy'
import type { TerminalFailureViewModel } from './failures/terminal-view-model'
import { createTerminalFailureViewModel } from './failures/terminal-view-model'

/* 骨架在 index.html 里；只有插图地址必须由构建期解析，所以它留在这里。 */
const illustrationUrl = new URL('./failures/assets/error-robot.svg', import.meta.url).href

installFatalCollectors()

failureCoordinator.subscribe(() => {
  if (isReactFatalHostMounted()) {
    return
  }

  const terminal = failureCoordinator.getSnapshot().terminal

  if (!terminal) {
    return
  }

  render(createTerminalFailureViewModel(terminal.incident, terminal.additionalIncidentCount))
})

function render(model: TerminalFailureViewModel): void {
  const root = document.getElementById('root')
  const screen = instantiate('fatal-screen')

  if (!root || !screen) {
    console.error('[Poietica] 致命屏模板缺失', model.summary)

    return
  }

  fill(screen, '.fatal-title', model.title)
  fill(screen, '.fatal-description', model.description)
  fill(screen, '.fatal-summary', model.summary)
  fill(screen, '.fatal-details summary', model.detailsLabel)
  fill(screen, '.fatal-diagnostic', model.diagnostic)

  const illustration = screen.querySelector('img')

  if (illustration) {
    illustration.src = illustrationUrl
  }

  const secondary = screen.querySelector<HTMLElement>('.fatal-secondary')

  if (secondary && model.additionalIncidentMessage) {
    secondary.textContent = model.additionalIncidentMessage
    secondary.hidden = false
  }

  const primaryAction = model.primaryAction
  const reload = action(screen, 'reload')

  if (reload && primaryAction) {
    label(reload, primaryAction.label, 'reload')

    reload.hidden = false

    reload.onclick = () => {
      window.location.reload()
    }
  }

  const copy = action(screen, 'copy')

  if (copy) {
    wireCopy(copy, screen.querySelector('details'), model)
  }

  root.replaceChildren(screen)

  /* 窗口以 visible: false 创建，正常路径由 React 首帧呈现 —— 这条路径上没有 React。 */
  void import('@poietica/native-bridge')
    .then(({ createMainWindowController }) => createMainWindowController().present())
    .catch(reportWindowFailure)
}

function wireCopy(
  copy: HTMLButtonElement,
  details: HTMLDetailsElement | null,
  model: TerminalFailureViewModel,
): void {
  let resetTimer: number | undefined

  label(copy, model.copyActionLabel, 'copy')

  copy.onclick = async () => {
    window.clearTimeout(resetTimer)

    try {
      await navigator.clipboard.writeText(model.diagnostic)

      label(copy, model.copySuccessLabel, 'copied')
    } catch {
      label(copy, model.copyFailureLabel, 'copy')

      /* 复制不成时诊断文本必须自己露出来，否则用户没有第二条路。 */
      if (details) {
        details.open = true
      }
    }

    resetTimer = window.setTimeout(() => {
      label(copy, model.copyActionLabel, 'copy')
    }, model.copyResetDelayMs)
  }
}

/** 克隆 index.html 里的骨架。 */
function instantiate(id: string): HTMLElement | null {
  const template = document.getElementById(id)

  if (!(template instanceof HTMLTemplateElement)) {
    return null
  }

  const fragment = template.content.cloneNode(true) as DocumentFragment

  return fragment.firstElementChild instanceof HTMLElement ? fragment.firstElementChild : null
}

function fill(screen: HTMLElement, selector: string, text: string): void {
  const target = screen.querySelector(selector)

  if (target) {
    target.textContent = text
  }
}

function action(screen: HTMLElement, name: string): HTMLButtonElement | null {
  return screen.querySelector<HTMLButtonElement>(`button[data-action="${name}"]`)
}

/** 文案来自 view model，图标来自模板：这个文件两样都不定义。 */
function label(target: HTMLButtonElement, text: string, icon: string): void {
  target.setAttribute('aria-label', text)

  const icons = document.getElementById('fatal-icons')

  if (!(icons instanceof HTMLTemplateElement)) {
    return
  }

  const glyph = icons.content.querySelector(`[data-icon="${icon}"]`)

  if (glyph) {
    target.replaceChildren(glyph.cloneNode(true))
  }
}

function reportWindowFailure(cause: unknown): void {
  console.error('[Poietica] 致命屏无法操作主窗口', cause)
}
