import { installFatalCollectors } from './failures/browser-collectors'
import { failureCoordinator } from './failures/coordinator'
import { isReactFatalHostMounted } from './failures/terminal-policy'
import type { TerminalFailureViewModel } from './failures/terminal-view-model'
import { createTerminalFailureViewModel } from './failures/terminal-view-model'

const errorRobotIllustrationUrl = new URL('./failures/assets/error-robot.svg', import.meta.url).href

installFatalCollectors()

failureCoordinator.subscribe(() => {
  if (isReactFatalHostMounted()) {
    return
  }

  const terminal = failureCoordinator.getSnapshot().terminal

  if (!terminal) {
    return
  }

  const model = createTerminalFailureViewModel(terminal.incident, terminal.additionalIncidentCount)

  renderPreReactFatalScreen(model)
})

function renderPreReactFatalScreen(model: TerminalFailureViewModel): void {
  const root = document.getElementById('root')

  if (!root) {
    try {
      console.error('[Poietica] Root element unavailable', model.summary)
    } catch {
      // No further safe fallback.
    }

    return
  }

  root.replaceChildren(createFatalSurface(model))

  presentWindow()
}

/*
 * 窗口以 visible: false 创建，正常路径由 React 首帧之后呈现。这条路径上 React
 * 永远不会挂载，所以崩溃屏必须自己把窗口叫出来。
 */
function presentWindow(): void {
  void import('@poietica/desktop-adapters')
    .then(({ createMainWindowController }) => createMainWindowController().present())
    .catch(() => {
      // 窗口无法呈现时没有可用的补救界面；原生日志里仍然留有记录。
    })
}

function createFatalSurface(model: TerminalFailureViewModel): HTMLElement {
  const main = createElement('main', 'fatal-surface')

  main.setAttribute('role', 'alert')
  main.setAttribute('aria-live', 'assertive')

  const content = createElement('section', 'fatal-content')

  const illustration = createElement('img', 'fatal-illustration')

  illustration.src = errorRobotIllustrationUrl
  illustration.alt = ''
  illustration.setAttribute('aria-hidden', 'true')

  const title = createTextElement('h1', 'fatal-title', model.title)
  const description = createTextElement('p', 'fatal-description', model.description)
  const summary = createTextElement('p', 'fatal-summary', model.summary)

  const details = createElement('details', 'fatal-details')
  const detailsSummary = createTextElement('summary', undefined, model.detailsLabel)
  const diagnostic = createTextElement('pre', 'fatal-diagnostic', model.diagnostic)

  details.append(detailsSummary, diagnostic)

  const actions = createElement('div', 'fatal-actions')

  actions.setAttribute('aria-label', '错误处理操作')
  actions.setAttribute('role', 'group')

  const primaryAction = model.primaryAction

  if (primaryAction) {
    const reloadButton = createIconButton(
      'fatal-icon-button',
      primaryAction.label,
      createReloadIcon(),
    )

    reloadButton.onclick = () => {
      executePrimaryAction(primaryAction)
    }

    actions.append(reloadButton)
  }

  const copyButton = createIconButton('fatal-icon-button', model.copyActionLabel, createCopyIcon())

  let copyResetTimer: number | undefined

  copyButton.onclick = async () => {
    try {
      await navigator.clipboard.writeText(model.diagnostic)

      setCopyButtonState(copyButton, model.copySuccessLabel, createCheckIcon())

      if (copyResetTimer !== undefined) {
        window.clearTimeout(copyResetTimer)
      }

      copyResetTimer = window.setTimeout(() => {
        setCopyButtonState(copyButton, model.copyActionLabel, createCopyIcon())

        copyResetTimer = undefined
      }, 2200)
    } catch {
      setCopyButtonState(copyButton, model.copyActionLabel, createCopyIcon())

      details.open = true
    }
  }

  actions.append(copyButton)

  content.append(illustration, title, description, summary)

  if (model.additionalIncidentMessage) {
    content.append(createTextElement('p', 'fatal-secondary', model.additionalIncidentMessage))
  }

  content.append(actions, details)

  main.append(content)

  return main
}

function executePrimaryAction(action: { readonly kind: 'reload' }): void {
  switch (action.kind) {
    case 'reload':
      window.location.reload()
  }
}

function createElement<TagName extends keyof HTMLElementTagNameMap>(
  tagName: TagName,
  className?: string,
): HTMLElementTagNameMap[TagName] {
  const element = document.createElement(tagName)

  if (className) {
    element.className = className
  }

  return element
}

function createTextElement<TagName extends keyof HTMLElementTagNameMap>(
  tagName: TagName,
  className: string | undefined,
  text: string,
): HTMLElementTagNameMap[TagName] {
  const element = createElement(tagName, className)

  element.textContent = text

  return element
}

function createIconButton(className: string, label: string, icon: string): HTMLButtonElement {
  const button = createElement('button', className)

  button.setAttribute('type', 'button')
  button.setAttribute('aria-label', label)
  button.setAttribute('title', label)

  button.innerHTML = icon

  return button
}

function setCopyButtonState(button: HTMLButtonElement, label: string, icon: string): void {
  button.setAttribute('aria-label', label)
  button.setAttribute('title', label)

  button.innerHTML = icon
}

function createReloadIcon(): string {
  return '<svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></svg>'
}

function createCopyIcon(): string {
  return '<svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>'
}

function createCheckIcon(): string {
  return '<svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></svg>'
}
