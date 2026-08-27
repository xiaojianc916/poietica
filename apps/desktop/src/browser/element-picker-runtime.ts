import {
  getElementAtPoint,
  getElementBounds,
  getElementContext,
  isElementGrabbable,
} from 'react-grab/primitives'

interface PickerController {
  start(token: number): void
  cancel(): void
}

declare global {
  interface Window {
    __poieticaElementPicker?: PickerController
  }
}

type Field = {
  readonly label: string
  readonly property: string
  readonly options?: readonly string[]
  readonly placeholder?: string
}

type Group = {
  readonly title: string
  readonly fields: readonly Field[]
}

type Baseline = { readonly value: string; readonly priority: string; readonly computed: string }
type Change = { readonly previous: string; readonly value: string }

const callbackUrl = 'https://pick.poietica.invalid/'
const styleGroups: readonly Group[] = [
  {
    title: '文字',
    fields: [
      { label: '字体', property: 'font-family' },
      { label: '字号', property: 'font-size', placeholder: '16px' },
      {
        label: '字重',
        property: 'font-weight',
        options: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
      },
      { label: '行高', property: 'line-height' },
      { label: '字距', property: 'letter-spacing' },
      { label: '对齐', property: 'text-align', options: ['start', 'center', 'end', 'justify'] },
      {
        label: '转换',
        property: 'text-transform',
        options: ['none', 'uppercase', 'lowercase', 'capitalize'],
      },
      { label: '装饰', property: 'text-decoration' },
    ],
  },
  {
    title: '颜色与效果',
    fields: [
      { label: '文字颜色', property: 'color' },
      { label: '背景', property: 'background-color' },
      { label: '透明度', property: 'opacity' },
      { label: '阴影', property: 'box-shadow' },
      { label: '滤镜', property: 'filter' },
      { label: '混合模式', property: 'mix-blend-mode' },
    ],
  },
  {
    title: '边框',
    fields: [
      { label: '宽度', property: 'border-width' },
      {
        label: '样式',
        property: 'border-style',
        options: ['none', 'solid', 'dashed', 'dotted', 'double'],
      },
      { label: '颜色', property: 'border-color' },
      { label: '圆角', property: 'border-radius' },
      { label: '轮廓', property: 'outline' },
    ],
  },
]

const layoutGroups: readonly Group[] = [
  {
    title: '显示与定位',
    fields: [
      {
        label: '显示',
        property: 'display',
        options: [
          'block',
          'inline',
          'inline-block',
          'flex',
          'inline-flex',
          'grid',
          'inline-grid',
          'none',
        ],
      },
      {
        label: '定位',
        property: 'position',
        options: ['static', 'relative', 'absolute', 'fixed', 'sticky'],
      },
      { label: '上', property: 'top' },
      { label: '右', property: 'right' },
      { label: '下', property: 'bottom' },
      { label: '左', property: 'left' },
      { label: '层级', property: 'z-index' },
    ],
  },
  {
    title: '尺寸',
    fields: [
      { label: '宽度', property: 'width' },
      { label: '最小宽', property: 'min-width' },
      { label: '最大宽', property: 'max-width' },
      { label: '高度', property: 'height' },
      { label: '最小高', property: 'min-height' },
      { label: '最大高', property: 'max-height' },
      { label: '纵横比', property: 'aspect-ratio' },
    ],
  },
  {
    title: '间距',
    fields: [
      { label: '外边距', property: 'margin' },
      { label: '内边距', property: 'padding' },
      { label: '间隙', property: 'gap' },
      { label: '行间隙', property: 'row-gap' },
      { label: '列间隙', property: 'column-gap' },
    ],
  },
  {
    title: 'Flex',
    fields: [
      {
        label: '方向',
        property: 'flex-direction',
        options: ['row', 'row-reverse', 'column', 'column-reverse'],
      },
      { label: '换行', property: 'flex-wrap', options: ['nowrap', 'wrap', 'wrap-reverse'] },
      {
        label: '主轴',
        property: 'justify-content',
        options: ['start', 'center', 'end', 'space-between', 'space-around', 'space-evenly'],
      },
      {
        label: '交叉轴',
        property: 'align-items',
        options: ['stretch', 'start', 'center', 'end', 'baseline'],
      },
      {
        label: '自身对齐',
        property: 'align-self',
        options: ['auto', 'stretch', 'start', 'center', 'end', 'baseline'],
      },
      { label: '伸展', property: 'flex-grow' },
      { label: '收缩', property: 'flex-shrink' },
      { label: '基准', property: 'flex-basis' },
      { label: '顺序', property: 'order' },
    ],
  },
  {
    title: 'Grid 与溢出',
    fields: [
      { label: '列模板', property: 'grid-template-columns' },
      { label: '行模板', property: 'grid-template-rows' },
      {
        label: '自动流',
        property: 'grid-auto-flow',
        options: ['row', 'column', 'dense', 'row dense', 'column dense'],
      },
      { label: '整体对齐', property: 'place-items' },
      {
        label: '横向溢出',
        property: 'overflow-x',
        options: ['visible', 'hidden', 'clip', 'scroll', 'auto'],
      },
      {
        label: '纵向溢出',
        property: 'overflow-y',
        options: ['visible', 'hidden', 'clip', 'scroll', 'auto'],
      },
      { label: '变换', property: 'transform' },
      { label: '变换原点', property: 'transform-origin' },
    ],
  },
]

const css = [
  ':host{all:initial;color-scheme:light;--ink:#111827;--muted:#667085;--line:#e5e7eb;--accent:#2563eb;--surface:#fff;font:13px/1.4 Inter,ui-sans-serif,system-ui,sans-serif}',
  '*{box-sizing:border-box}',
  '.outline{position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #2563eb;background:rgba(37,99,235,.08);border-radius:3px}',
  '.badge{position:absolute;left:-2px;bottom:100%;max-width:280px;padding:3px 7px;border-radius:5px 5px 0 0;background:#2563eb;color:white;font:600 11px/1.3 ui-monospace,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.panel{position:fixed;z-index:2147483647;width:min(380px,calc(100vw - 16px));max-height:min(680px,calc(100vh - 16px));display:none;flex-direction:column;border:1px solid rgba(17,24,39,.12);border-radius:14px;background:var(--surface);box-shadow:0 20px 60px rgba(15,23,42,.24);color:var(--ink);overflow:hidden}',
  '.panel[data-open=true]{display:flex}',
  '.head{display:flex;align-items:center;gap:8px;padding:12px;border-bottom:1px solid var(--line)}',
  '.title{min-width:0;flex:1;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  'button,input,select,textarea{font:inherit}',
  'button{border:0;background:transparent;color:inherit;cursor:pointer}',
  '.icon{width:28px;height:28px;border-radius:7px;color:var(--muted)}.icon:hover{background:#f3f4f6;color:var(--ink)}',
  'textarea{width:calc(100% - 24px);min-height:74px;margin:12px 12px 8px;padding:10px 11px;resize:vertical;border:1px solid var(--line);border-radius:9px;outline:none;color:var(--ink);background:#fff}',
  'textarea:focus,input:focus,select:focus{border-color:#93b4ff;box-shadow:0 0 0 3px rgba(37,99,235,.12);outline:none}',
  '.tabs{display:grid;grid-template-columns:1fr 1fr;margin:0 12px;border-bottom:1px solid var(--line)}',
  '.tab{padding:9px;color:var(--muted);font-weight:600;border-bottom:2px solid transparent}.tab[aria-selected=true]{border-color:var(--accent);color:var(--accent)}',
  '.body{overflow:auto;padding:4px 12px 12px}',
  '.group{padding:10px 0;border-bottom:1px solid #f0f2f5}.group:last-child{border-bottom:0}',
  '.group h3{margin:0 0 8px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}',
  '.field{display:grid;grid-template-columns:92px minmax(0,1fr);align-items:center;gap:8px;margin:6px 0}',
  '.field span{color:#475467}',
  '.field input,.field select{width:100%;height:30px;border:1px solid var(--line);border-radius:7px;padding:0 8px;color:var(--ink);background:#fff}',
  '.error{min-height:18px;padding:0 12px;color:#b42318;font-size:12px}',
  '.code{display:none;margin:0 12px 10px;max-height:160px;overflow:auto;padding:9px;border-radius:8px;background:#111827;color:#e5e7eb;font:11px/1.45 ui-monospace,monospace;white-space:pre-wrap}.code[data-open=true]{display:block}',
  '.foot{display:flex;align-items:center;gap:6px;padding:10px 12px;border-top:1px solid var(--line)}',
  '.danger{color:#b42318}.spacer{flex:1}',
  '.action{height:32px;padding:0 12px;border-radius:8px;font-weight:600}.action:hover{background:#f3f4f6}.primary{background:var(--accent);color:#fff}.primary:hover{background:#1d4ed8}',
].join('\n')

class ElementPicker implements PickerController {
  private token: number | null = null
  private host: HTMLElement | null = null
  private outline: HTMLElement | null = null
  private badge: HTMLElement | null = null
  private panel: HTMLElement | null = null
  private body: HTMLElement | null = null
  private comment: HTMLTextAreaElement | null = null
  private error: HTMLElement | null = null
  private code: HTMLElement | null = null
  private hovered: Element | null = null
  private selected: Element | null = null
  private tab: 'style' | 'layout' = 'style'
  private context: ReturnType<typeof getElementContext> | null = null
  private readonly baseline = new Map<string, Baseline>()
  private readonly changes = new Map<string, Change>()
  private removed = false

  start(token: number): void {
    this.cancel()
    this.token = token
    this.ensureUi()
    document.addEventListener('pointermove', this.onPointerMove, true)
    document.addEventListener('click', this.onClick, true)
    document.addEventListener('keydown', this.onKeyDown, true)
  }

  cancel(): void {
    document.removeEventListener('pointermove', this.onPointerMove, true)
    document.removeEventListener('click', this.onClick, true)
    document.removeEventListener('keydown', this.onKeyDown, true)
    this.restore()
    this.host?.remove()
    this.host = null
    this.outline = null
    this.panel = null
    this.body = null
    this.comment = null
    this.error = null
    this.code = null
    this.hovered = null
    this.selected = null
    this.context = null
    this.token = null
  }

  private ensureUi(): void {
    const host = document.createElement('div')
    host.dataset['poieticaElementPicker'] = 'true'
    const root = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = css
    const outline = document.createElement('div')
    outline.className = 'outline'
    outline.hidden = true
    const badge = document.createElement('span')
    badge.className = 'badge'
    outline.append(badge)

    const panel = document.createElement('section')
    panel.className = 'panel'
    panel.dataset['open'] = 'false'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'false')
    panel.setAttribute('aria-label', '编辑所选元素')
    panel.innerHTML =
      '<div class="head"><strong class="title">所选元素</strong><button class="icon code-toggle" type="button" aria-label="查看代码">&lt;/&gt;</button><button class="icon close" type="button" aria-label="关闭">×</button></div><textarea aria-label="修改需求" placeholder="请描述你的修改需求"></textarea><div class="tabs" role="tablist" aria-label="编辑类别"><button class="tab" type="button" role="tab" data-tab="style" aria-selected="true">样式</button><button class="tab" type="button" role="tab" data-tab="layout" aria-selected="false">布局</button></div><div class="body"></div><div class="error" role="status"></div><pre class="code"></pre><div class="foot"><button class="action danger remove" type="button">删除元素</button><button class="action reset" type="button">重置</button><span class="spacer"></span><button class="action attach" type="button">附加</button><button class="action primary send" type="button">发送给 AI</button></div>'

    root.append(style, outline, panel)
    document.documentElement.append(host)
    this.host = host
    this.outline = outline
    this.badge = badge
    this.panel = panel
    this.body = panel.querySelector('.body')
    this.comment = panel.querySelector('textarea')
    this.error = panel.querySelector('.error')
    this.code = panel.querySelector('.code')

    panel.querySelector('.close')?.addEventListener('click', () => this.sendCancel())
    panel.querySelector('.code-toggle')?.addEventListener('click', () => this.toggleCode())
    panel.querySelector('.remove')?.addEventListener('click', () => this.removeSelected())
    panel.querySelector('.reset')?.addEventListener('click', () => this.resetChanges())
    panel.querySelector('.attach')?.addEventListener('click', () => void this.submit('attach'))
    panel.querySelector('.send')?.addEventListener('click', () => void this.submit('send'))
    for (const button of panel.querySelectorAll<HTMLButtonElement>('[role=tab]')) {
      button.addEventListener('click', () =>
        this.selectTab(button.dataset['tab'] === 'layout' ? 'layout' : 'style'),
      )
      button.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
          return
        }
        event.preventDefault()
        this.selectTab(this.tab === 'style' ? 'layout' : 'style')
        panel.querySelector<HTMLButtonElement>(`[data-tab=${this.tab}]`)?.focus()
      })
    }
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.isUiEvent(event) || this.selected !== null) {
      return
    }
    this.hovered = getElementAtPoint(event.clientX, event.clientY, {
      filter: (candidate) => candidate !== this.host && isElementGrabbable(candidate),
    })
    this.draw(this.hovered)
  }

  private readonly onClick = (event: MouseEvent): void => {
    if (this.isUiEvent(event)) {
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    const candidate = this.hovered ?? getElementAtPoint(event.clientX, event.clientY)
    if (candidate === null || candidate === this.host || !isElementGrabbable(candidate)) {
      return
    }
    this.select(candidate)
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.isUiEvent(event)) {
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      if (this.selected === null) {
        this.sendCancel()
      } else {
        this.clearSelection()
      }
    }
  }

  private isUiEvent(event: Event): boolean {
    return this.host !== null && event.composedPath().includes(this.host)
  }

  private draw(element: Element | null): void {
    if (this.outline === null || this.badge === null || element === null) {
      if (this.outline !== null) {
        this.outline.hidden = true
      }
      return
    }
    const bounds = getElementBounds(element)
    Object.assign(this.outline.style, {
      left: `${bounds.x}px`,
      top: `${bounds.y}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
    })
    this.badge.textContent = element.tagName.toLowerCase()
    this.outline.hidden = false
  }

  private select(element: Element): void {
    this.restore()
    this.selected = element
    this.hovered = element
    this.context = getElementContext(element)
    this.draw(element)
    this.panel?.setAttribute('data-open', 'true')
    this.positionPanel()
    this.selectTab('style')
    this.comment?.focus()
    void this.context.then(
      (context) => {
        if (this.selected !== element) {
          return
        }
        const title = this.panel?.querySelector<HTMLElement>('.title')
        if (title !== null && title !== undefined) {
          title.textContent = context.componentName ?? element.tagName.toLowerCase()
        }
        if (this.badge !== null) {
          this.badge.textContent = context.componentName ?? element.tagName.toLowerCase()
        }
      },
      (cause: unknown) => this.showError(cause),
    )
  }

  private clearSelection(): void {
    this.restore()
    this.selected = null
    this.context = null
    this.changes.clear()
    this.baseline.clear()
    this.removed = false
    this.panel?.setAttribute('data-open', 'false')
    if (this.code !== null) {
      this.code.dataset['open'] = 'false'
    }
  }

  private positionPanel(): void {
    if (this.panel === null || this.selected === null) {
      return
    }
    const bounds = getElementBounds(this.selected)
    const width = Math.min(380, window.innerWidth - 16)
    const left = Math.max(8, Math.min(bounds.x, window.innerWidth - width - 8))
    const below = bounds.y + bounds.height + 8
    const top = below + 500 <= window.innerHeight ? below : Math.max(8, bounds.y - 508)
    this.panel.style.left = `${left}px`
    this.panel.style.top = `${top}px`
  }

  private selectTab(tab: 'style' | 'layout'): void {
    this.tab = tab
    for (const button of this.panel?.querySelectorAll<HTMLButtonElement>('[role=tab]') ?? []) {
      button.setAttribute('aria-selected', String(button.dataset['tab'] === tab))
    }
    this.renderFields(tab === 'style' ? styleGroups : layoutGroups)
  }

  private renderFields(groups: readonly Group[]): void {
    if (this.body === null || this.selected === null) {
      return
    }
    this.body.replaceChildren()
    const computed = getComputedStyle(this.selected)
    for (const group of groups) {
      this.body.append(this.renderGroup(group, computed))
    }
  }

  private renderGroup(group: Group, computed: CSSStyleDeclaration): HTMLElement {
    const section = document.createElement('section')
    section.className = 'group'
    const heading = document.createElement('h3')
    heading.textContent = group.title
    section.append(heading)
    for (const field of group.fields) {
      section.append(this.renderField(field, computed))
    }
    return section
  }

  private renderField(field: Field, computed: CSSStyleDeclaration): HTMLLabelElement {
    const label = document.createElement('label')
    label.className = 'field'
    const caption = document.createElement('span')
    caption.textContent = field.label
    const control = this.createFieldControl(field, computed)
    control.addEventListener('change', () => this.apply(field.property, control.value.trim()))
    label.append(caption, control)
    return label
  }

  private createFieldControl(
    field: Field,
    computed: CSSStyleDeclaration,
  ): HTMLInputElement | HTMLSelectElement {
    if (field.options === undefined) {
      const input = document.createElement('input')
      input.setAttribute('aria-label', field.label)
      input.value = computed.getPropertyValue(field.property).trim()
      input.placeholder = field.placeholder ?? 'CSS 值'
      return input
    }
    const select = document.createElement('select')
    select.setAttribute('aria-label', field.label)
    const current = computed.getPropertyValue(field.property).trim()
    for (const value of ['', ...field.options]) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = value === '' ? '—' : value
      option.selected = value === current
      select.append(option)
    }
    return select
  }

  private styleDeclaration(): CSSStyleDeclaration | null {
    const selected = this.selected
    return selected instanceof HTMLElement || selected instanceof SVGElement ? selected.style : null
  }

  private apply(property: string, value: string): void {
    const declaration = this.styleDeclaration()
    if (declaration === null || this.selected === null) {
      return
    }
    if (value !== '' && !CSS.supports(property, value)) {
      this.showError(`无效的 CSS 值：${property}: ${value}`)
      return
    }
    if (!this.baseline.has(property)) {
      this.baseline.set(property, {
        value: declaration.getPropertyValue(property),
        priority: declaration.getPropertyPriority(property),
        computed: getComputedStyle(this.selected).getPropertyValue(property).trim(),
      })
    }
    const baseline = this.baseline.get(property)
    if (baseline === undefined) {
      return
    }
    if (value === '') {
      if (baseline.value === '') {
        declaration.removeProperty(property)
      } else {
        declaration.setProperty(property, baseline.value, baseline.priority)
      }
      this.changes.delete(property)
    } else {
      declaration.setProperty(property, value)
      this.changes.set(property, { previous: baseline.computed, value })
    }
    this.showError('')
    this.draw(this.selected)
    this.positionPanel()
  }

  private removeSelected(): void {
    if (this.selected === null) {
      return
    }
    this.removed = true
    this.apply('display', 'none')
    if (this.badge !== null) {
      this.badge.textContent = '将删除所选元素'
    }
  }

  private resetChanges(): void {
    this.restore()
    this.changes.clear()
    this.baseline.clear()
    this.removed = false
    this.draw(this.selected)
    this.positionPanel()
    this.renderFields(this.tab === 'style' ? styleGroups : layoutGroups)
  }

  private restore(): void {
    const declaration = this.styleDeclaration()
    if (declaration !== null) {
      for (const [property, baseline] of this.baseline) {
        if (baseline.value === '') {
          declaration.removeProperty(property)
        } else {
          declaration.setProperty(property, baseline.value, baseline.priority)
        }
      }
    }
  }

  private styleChanges(): string {
    const rows = Array.from(
      this.changes,
      ([property, change]) => `${property}: ${change.previous} -> ${change.value}`,
    )
    if (this.removed) {
      rows.unshift('intent: remove selected element')
    }
    return rows.join('\n')
  }

  private async toggleCode(): Promise<void> {
    if (this.code === null || this.context === null) {
      return
    }
    const opening = this.code.dataset['open'] !== 'true'
    this.code.dataset['open'] = String(opening)
    if (!opening) {
      return
    }
    try {
      const context = await this.context
      const source =
        context.filePath === null ? '' : `${context.filePath}:${String(context.lineNumber ?? 1)}`
      this.code.textContent = [source, context.selector ?? '', context.htmlPreview]
        .filter(Boolean)
        .join('\n')
    } catch (cause) {
      this.showError(cause)
    }
  }

  private async submit(submission: 'attach' | 'send'): Promise<void> {
    if (this.selected === null || this.context === null || this.token === null) {
      return
    }
    this.showError('正在收集组件上下文…')
    try {
      const selected = this.selected
      const context = await this.context
      const target = new URL(callbackUrl)
      const put = (key: string, value: string | number | null): void => {
        if (value !== null && value !== '') {
          target.searchParams.set(key, String(value))
        }
      }
      put('token', this.token)
      put('submission', submission)
      put('url', location.href)
      put('title', document.title)
      put('tag', selected.tagName.toLowerCase())
      put('selector', context.selector)
      put('role', selected.getAttribute('role'))
      put('ariaLabel', selected.getAttribute('aria-label'))
      put('text', (selected.textContent ?? '').trim().slice(0, 2_000))
      put('html', context.htmlPreview)
      put('styles', context.styles)
      put('component', context.componentName)
      put('sourceFile', context.filePath)
      put('sourceLine', context.lineNumber)
      put('sourceColumn', context.columnNumber)
      put('stack', context.stackString)
      put('styleChanges', this.styleChanges())
      put('comment', this.comment?.value.trim() ?? '')
      put('pickedAt', new Date().toISOString())
      this.teardownForSubmission()
      location.assign(target.toString())
    } catch (cause) {
      this.showError(cause)
    }
  }

  private sendCancel(): void {
    if (this.token === null) {
      this.cancel()
      return
    }
    const target = new URL(callbackUrl)
    target.searchParams.set('token', String(this.token))
    target.searchParams.set('submission', 'cancel')
    this.teardownForSubmission()
    location.assign(target.toString())
  }

  private teardownForSubmission(): void {
    document.removeEventListener('pointermove', this.onPointerMove, true)
    document.removeEventListener('click', this.onClick, true)
    document.removeEventListener('keydown', this.onKeyDown, true)
    this.restore()
    this.host?.remove()
  }

  private showError(cause: unknown): void {
    if (this.error !== null) {
      this.error.textContent = cause instanceof Error ? cause.message : String(cause)
    }
  }
}

window.__poieticaElementPicker?.cancel()
window.__poieticaElementPicker = new ElementPicker()
