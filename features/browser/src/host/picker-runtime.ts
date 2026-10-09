/// <reference lib="dom" />

/*
 * 注入页面的拾取脚本（07 页 §12D「元素拾取」第 6 条）。**迁移自** legacy
 * `apps/desktop/src/browser/element-picker-runtime.ts`：面板结构、类名、CSS 与交互
 * （悬浮高亮、点击选中、Esc 取消、两张字段表、附加/发送）逐条保留。
 *
 * 两处必须重构（新架构的硬要求，见 07 页 §12D）：
 *   1. 整个脚本是**一个自包含函数**：函数体内不引用任何外部变量，宿主注入时用的是
 *      `pickerRuntime.toString()`（打包压缩不改变自包含函数的结果）。
 *      因此 legacy 引的 `react-grab/primitives`（取元素上下文）改成本文件内的最小实现：
 *      量外框、拼选择器、截 HTML。字段表、文案、样式一个不动。
 *   2. 回调地址与参数形状换成本架构的：`kind=submitted|cancelled`（07 页 §12D 第 3 条），
 *      token 是宿主给的 UUID。
 *
 * 文件长度按 P5 的逐字迁移先例接受（07/09 页的 400 行规则见 docs/refactor-log.md 的偏差记录）：
 * 自包含是这条脚本的硬约束，拆文件会让它引用外部变量、注入即失效。
 */

export interface PickerRuntimeArgs {
  /** 宿主发的租约 token（UUID）：页面猜不到，伪造的回调会被丢弃。 */
  readonly token: string
  readonly theme: 'light' | 'dark'
  /** 回调地址：拾取完成时 `location.assign` 到这个不存在的域名，由宿主在 will-navigate 里拦。 */
  readonly callbackUrl: string
}

export function pickerRuntime(args: PickerRuntimeArgs): void {
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
          options: ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'none'],
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
        { label: '横向溢出', property: 'overflow-x', options: ['visible', 'hidden', 'clip', 'scroll', 'auto'] },
        { label: '纵向溢出', property: 'overflow-y', options: ['visible', 'hidden', 'clip', 'scroll', 'auto'] },
        { label: '变换', property: 'transform' },
        { label: '变换原点', property: 'transform-origin' },
      ],
    },
  ]

  const gap = 8

  /* 面板长在外部页面里，带不进设计系统的样式表：下面的 --ui-* 值逐字抄自 legacy
     packages/design-system/src/tokens/light.css 与 dark.css 的同名令牌。 */
  const css = [
    ':host{all:initial;color-scheme:light;font:13px/1.4 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--ui-foreground:oklch(0.19 0.01 90);--ui-muted-foreground:oklch(0.47 0.012 90);--ui-placeholder:oklch(0.6 0.012 90);--ui-popover:#fff;--ui-popover-frame:#e2e4e4;--ui-divider:#e0e0e0;--ui-divider-subtle:#f8f8f8;--ui-input:oklch(0.84 0.006 90);--ui-ring:oklch(0.55 0.19 255);--ui-primary:oklch(0.55 0.19 255);--ui-primary-foreground:oklch(0.99 0 0);--ui-destructive:oklch(0.56 0.22 28);--ui-accent:#f2f2f3}',
    ':host([data-theme=dark]){color-scheme:dark;--ui-foreground:#c3c3c3;--ui-muted-foreground:rgb(255 255 255 / 65%);--ui-placeholder:rgb(255 255 255 / 40%);--ui-popover:#2a2a2a;--ui-popover-frame:#3d3d3d;--ui-divider:rgb(255 255 255 / 16%);--ui-divider-subtle:#1d1d1d;--ui-input:rgb(255 255 255 / 24%);--ui-ring:#6e9ecc;--ui-primary:#5e9fe8;--ui-primary-foreground:#111;--ui-destructive:#e97366;--ui-accent:#383836}',
    '*{box-sizing:border-box}',
    '.outline{position:fixed;z-index:2147483646;pointer-events:none;border:2px solid var(--ui-primary);background:color-mix(in srgb,var(--ui-primary) 8%,transparent);border-radius:3px}',
    '.badge{position:absolute;left:-2px;bottom:100%;max-width:280px;padding:3px 7px;border-radius:5px 5px 0 0;background:var(--ui-primary);color:var(--ui-primary-foreground);font:600 11px/1.3 ui-monospace,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.panel{position:fixed;z-index:2147483647;width:min(380px,calc(100vw - 16px));max-height:min(520px,calc(100vh - 16px));display:none;flex-direction:column;border:1px solid var(--ui-popover-frame);border-radius:14px;background:var(--ui-popover);box-shadow:0 20px 60px rgba(15,23,42,.24);color:var(--ui-foreground);overflow:hidden}',
    '.panel[data-open=true]{display:flex}',
    'button,input,select,textarea{font:inherit}',
    'button{border:0;background:transparent;color:inherit;cursor:pointer}',
    'textarea{width:calc(100% - 24px);min-height:74px;margin:12px 12px 8px;padding:10px 11px;resize:vertical;border:1px solid var(--ui-input);border-radius:9px;outline:none;color:var(--ui-foreground);background:var(--ui-popover)}',
    'textarea::placeholder{color:var(--ui-placeholder)}',
    'textarea:focus,input:focus,select:focus{border-color:var(--ui-ring);box-shadow:0 0 0 1px var(--ui-ring);outline:none}',
    '.tabs{display:grid;grid-template-columns:1fr 1fr;margin:0 12px;border-bottom:1px solid var(--ui-divider)}',
    '.tab{padding:9px;color:var(--ui-muted-foreground);font-weight:600;border-bottom:2px solid transparent}.tab[aria-selected=true]{border-color:var(--ui-primary);color:var(--ui-primary)}',
    '.body{max-height:232px;overflow:auto;padding:4px 12px 12px;scrollbar-width:none}',
    '.body::-webkit-scrollbar{width:0;height:0}',
    '.group{padding:10px 0;border-bottom:1px solid var(--ui-divider-subtle)}.group:last-child{border-bottom:0}',
    '.group h3{margin:0 0 8px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--ui-muted-foreground)}',
    '.field{display:grid;grid-template-columns:92px minmax(0,1fr);align-items:center;gap:8px;margin:6px 0}',
    '.field span{color:var(--ui-muted-foreground)}',
    '.field input,.field select{width:100%;height:30px;border:1px solid var(--ui-input);border-radius:7px;padding:0 8px;color:var(--ui-foreground);background:var(--ui-popover)}',
    '.status{min-height:18px;padding:0 12px;color:var(--ui-muted-foreground);font-size:12px}',
    '.status[data-tone=error]{color:var(--ui-destructive)}',
    '.foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:10px 12px;border-top:1px solid var(--ui-divider)}',
    '.action{display:inline-flex;align-items:center;justify-content:center;height:34px;padding:0 16px;border-radius:9px;font-weight:600;transition:background .15s,border-color .15s,box-shadow .15s,transform .06s}',
    '.action:active{transform:translateY(1px)}',
    '.action:focus-visible{outline:none;box-shadow:0 0 0 1px var(--ui-ring)}',
    '.action[disabled]{opacity:.55;cursor:default;transform:none}',
    '.attach{border:1px solid var(--ui-input);background:transparent;color:var(--ui-foreground)}.attach:hover:not([disabled]){background:var(--ui-accent)}',
    '.send{background:var(--ui-primary);color:var(--ui-primary-foreground);box-shadow:0 1px 2px rgba(16,24,40,.08)}.send:hover:not([disabled]){background:color-mix(in srgb,var(--ui-primary) 90%,transparent)}',
  ].join('\n')

  const markup =
    '<textarea aria-label="修改需求" placeholder="请描述你的修改需求"></textarea><div class="tabs" role="tablist" aria-label="编辑类别"><button class="tab" type="button" role="tab" data-tab="style" aria-selected="true">样式</button><button class="tab" type="button" role="tab" data-tab="layout" aria-selected="false">布局</button></div><div class="body"></div><div class="status" role="status"></div><div class="foot"><button class="action attach" type="button">附加</button><button class="action send" type="button">发送给 AI</button></div>'

  function clamp(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(value, Math.max(low, high)))
  }

  /*
   * legacy 引的 react-grab/primitives 在这里的最小替代：命中、外框、选择器、HTML 预览、组件栈。
   * 只保留这套面板真的会画出来的那几格；组件栈给不出（没有 React 树可读）时留空。
   */
  function boundsOf(element: Element | null): { x: number; y: number; width: number; height: number } | null {
    if (element === null || typeof element.getBoundingClientRect !== 'function') {
      return null
    }

    const rect = element.getBoundingClientRect()
    const width = rect.width
    const height = rect.height

    return Number.isFinite(width) && Number.isFinite(height) ? { x: rect.x, y: rect.y, width, height } : null
  }

  function grabbable(node: Element | null): node is Element {
    if (node === null) {
      return false
    }

    // 根元素与 document 不是「页面上的一个元素」；量不出外框的节点同样不要。
    return node !== document.documentElement && boundsOf(node) !== null
  }

  function selectorOf(element: Element): string {
    const parts: string[] = []
    let node: Element | null = element

    while (node !== null && node !== document.documentElement && parts.length < 6) {
      const tag = node.tagName.toLowerCase()
      const id = node.getAttribute('id')

      if (id !== null && id.length > 0) {
        parts.unshift(`${tag}#${id}`)
        break
      }

      const classes = (node.getAttribute('class') ?? '')
        .split(/\s+/u)
        .filter((name) => name.length > 0)
        .slice(0, 3)
      const siblings = node.parentElement
        ? [...node.parentElement.children].filter((child) => child.tagName === node?.tagName)
        : []
      const nth = siblings.length > 1 ? `:nth-of-type(${String(siblings.indexOf(node) + 1)})` : ''

      parts.unshift(`${tag}${classes.map((name) => `.${name}`).join('')}${nth}`)
      node = node.parentElement
    }

    return parts.join(' > ')
  }

  function htmlPreviewOf(element: Element): string {
    const html = element.outerHTML ?? ''

    return html.length > 4_000 ? `${html.slice(0, 4_000)}\n…（截断）` : html
  }

  class ElementPicker {
    private token: string | null = null
    private host: HTMLElement | null = null
    private outline: HTMLElement | null = null
    private badge: HTMLElement | null = null
    private panel: HTMLElement | null = null
    private body: HTMLElement | null = null
    private comment: HTMLTextAreaElement | null = null
    private status: HTMLElement | null = null
    private hovered: Element | null = null
    private selected: Element | null = null
    private tab: 'style' | 'layout' = 'style'
    private busy = false
    private readonly baseline = new Map<string, Baseline>()
    private readonly changes = new Map<string, Change>()

    start(token: string, theme: 'light' | 'dark'): void {
      this.cancel()
      this.token = token
      this.ensureUi(theme)
      document.addEventListener('pointermove', this.onPointerMove, true)
      document.addEventListener('click', this.onClick, true)
      document.addEventListener('keydown', this.onKeyDown, true)
      window.addEventListener('scroll', this.onReflow, { capture: true, passive: true })
      window.addEventListener('resize', this.onReflow)
    }

    cancel(): void {
      this.teardown()
      this.host = null
      this.outline = null
      this.badge = null
      this.panel = null
      this.body = null
      this.comment = null
      this.status = null
      this.hovered = null
      this.selected = null
      this.token = null
      this.busy = false
      this.baseline.clear()
      this.changes.clear()
    }

    /** 唯一的监听清单。cancel 与提交前的拆台都走它。 */
    private unbind(): void {
      document.removeEventListener('pointermove', this.onPointerMove, true)
      document.removeEventListener('click', this.onClick, true)
      document.removeEventListener('keydown', this.onKeyDown, true)
      window.removeEventListener('scroll', this.onReflow, true)
      window.removeEventListener('resize', this.onReflow)
    }

    private teardown(): void {
      this.unbind()
      this.restore()
      this.host?.remove()
    }

    private ensureUi(theme: 'light' | 'dark'): void {
      const host = document.createElement('div')
      host.dataset.poieticaElementPicker = 'true'
      host.dataset.theme = theme
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
      panel.dataset.open = 'false'
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-label', '编辑所选元素')
      panel.innerHTML = markup

      root.append(style, outline, panel)
      document.documentElement.append(host)
      this.host = host
      this.outline = outline
      this.badge = badge
      this.panel = panel
      this.body = panel.querySelector('.body')
      this.comment = panel.querySelector('textarea')
      this.status = panel.querySelector('.status')

      panel.querySelector('.attach')?.addEventListener('click', () => void this.submit('attach'))
      panel.querySelector('.send')?.addEventListener('click', () => void this.submit('send'))
      for (const button of panel.querySelectorAll<HTMLButtonElement>('[role=tab]')) {
        button.addEventListener('click', () => this.selectTab(button.dataset.tab === 'layout' ? 'layout' : 'style'))
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

      const hit = document.elementFromPoint(event.clientX, event.clientY)

      this.hovered = grabbable(hit) ? hit : null
      this.draw(this.hovered)
    }

    private readonly onClick = (event: MouseEvent): void => {
      if (this.isUiEvent(event)) {
        return
      }

      event.preventDefault()
      event.stopImmediatePropagation()

      const candidate = this.hovered ?? document.elementFromPoint(event.clientX, event.clientY)

      if (!grabbable(candidate) || candidate === this.host) {
        return
      }

      this.select(candidate)
    }

    private readonly onKeyDown = (event: KeyboardEvent): void => {
      if (this.isUiEvent(event) || event.key !== 'Escape') {
        return
      }

      event.preventDefault()

      if (this.selected === null) {
        this.sendCancel()
      } else {
        this.clearSelection()
      }
    }

    /** 页面滚动或窗口变形时，高亮与面板必须跟着元素走。 */
    private readonly onReflow = (): void => {
      if (this.selected === null) {
        return
      }

      this.draw(this.selected)
      this.position()
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

      const bounds = boundsOf(element)

      if (bounds === null) {
        this.outline.hidden = true

        return
      }

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
      this.baseline.clear()
      this.changes.clear()
      this.selected = element
      this.hovered = element
      this.draw(element)
      this.panel?.setAttribute('data-open', 'true')
      this.note('')
      this.selectTab('style')
      this.comment?.focus()
    }

    private clearSelection(): void {
      this.restore()
      this.selected = null
      this.changes.clear()
      this.baseline.clear()
      this.panel?.setAttribute('data-open', 'false')
      this.note('')
    }

    /** 先量真实尺寸再摆：下方放不下就翻上方，横向溢出就贴右缘，最后夹进视口。 */
    private position(): void {
      const panel = this.panel

      if (panel === null || this.selected === null) {
        return
      }

      const anchor = boundsOf(this.selected)

      if (anchor === null) {
        return
      }

      const rect = panel.getBoundingClientRect()
      const below = anchor.y + anchor.height + gap
      const room = window.innerHeight - below
      const top = room >= rect.height || room >= anchor.y - gap ? below : anchor.y - rect.height - gap
      const left = anchor.x + rect.width > window.innerWidth - gap ? anchor.x + anchor.width - rect.width : anchor.x

      panel.style.left = `${clamp(left, gap, window.innerWidth - rect.width - gap)}px`
      panel.style.top = `${clamp(top, gap, window.innerHeight - rect.height - gap)}px`
    }

    private selectTab(tab: 'style' | 'layout'): void {
      this.tab = tab

      for (const button of this.panel?.querySelectorAll<HTMLButtonElement>('[role=tab]') ?? []) {
        button.setAttribute('aria-selected', String(button.dataset.tab === tab))
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

      this.position()
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

    private createFieldControl(field: Field, computed: CSSStyleDeclaration): HTMLInputElement | HTMLSelectElement {
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
        this.fail(`无效的 CSS 值：${property}: ${value}`)

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

      this.note('')
      this.draw(this.selected)
      this.position()
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

    /** 面板上那两张表就是快照的定义：屏幕上看得见的每一项都进文件。 */
    private snapshot(): string {
      const selected = this.selected

      if (selected === null) {
        return ''
      }

      const computed = getComputedStyle(selected)
      const lines: string[] = []

      for (const group of [...styleGroups, ...layoutGroups]) {
        lines.push(`## ${group.title}`)

        for (const field of group.fields) {
          const value = computed.getPropertyValue(field.property).trim()
          lines.push(`${field.label} (${field.property}): ${value}`)
        }

        lines.push('')
      }

      return lines.join('\n')
    }

    private edits(): string {
      return Array.from(
        this.changes,
        ([property, change]) => `${property}: ${change.previous} -> ${change.value}`,
      ).join('\n')
    }

    private compose(selected: Element): string {
      return [
        '# 所选元素',
        `page: ${document.title}`,
        `url: ${location.href}`,
        `tag: ${selected.tagName.toLowerCase()}`,
        `selector: ${selectorOf(selected)}`,
        `role: ${selected.getAttribute('role') ?? ''}`,
        `aria-label: ${selected.getAttribute('aria-label') ?? ''}`,
        `text: ${(selected.textContent ?? '').trim().slice(0, 2_000)}`,
        '',
        '# HTML',
        htmlPreviewOf(selected),
        '',
        '# 样式与布局',
        this.snapshot(),
        '# 本次改动',
        this.edits(),
      ].join('\n')
    }

    /** 提交在途时按钮失效：一次拾取只该产生一条提示词。 */
    private arm(enabled: boolean): void {
      for (const button of this.panel?.querySelectorAll<HTMLButtonElement>('.action') ?? []) {
        button.disabled = !enabled
      }
    }

    private async submit(submission: 'attach' | 'send'): Promise<void> {
      const token = this.token
      const selected = this.selected

      if (this.busy || token === null || selected === null) {
        return
      }

      this.busy = true
      this.arm(false)
      this.note('正在收集元素上下文…')

      try {
        const target = new URL(args.callbackUrl)
        target.searchParams.set('token', token)
        target.searchParams.set('kind', 'submitted')
        target.searchParams.set('submission', submission)
        target.searchParams.set('elementType', selected.tagName.toLowerCase())
        target.searchParams.set('comment', this.comment?.value.trim() ?? '')
        target.searchParams.set('report', this.compose(selected))
        this.teardown()
        location.assign(target.toString())
      } catch (cause) {
        this.busy = false
        this.arm(true)
        this.fail(cause)
      }
    }

    private sendCancel(): void {
      if (this.token === null) {
        this.cancel()

        return
      }

      const target = new URL(args.callbackUrl)
      target.searchParams.set('token', this.token)
      target.searchParams.set('kind', 'cancelled')
      this.teardown()
      location.assign(target.toString())
    }

    private note(message: string): void {
      if (this.status !== null) {
        this.status.dataset.tone = 'info'
        this.status.textContent = message
      }
    }

    private fail(cause: unknown): void {
      if (this.status !== null) {
        this.status.dataset.tone = 'error'
        this.status.textContent = cause instanceof Error ? cause.message : String(cause)
      }
    }
  }

  const scope = window as unknown as { __poieticaElementPicker?: { cancel(): void } }

  scope.__poieticaElementPicker?.cancel()

  const picker = new ElementPicker()

  scope.__poieticaElementPicker = picker
  picker.start(args.token, args.theme)
}
