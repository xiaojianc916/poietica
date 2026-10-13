/// <reference lib="dom" />

/* 注入页面的拾取脚本：悬浮高亮、点击选中、Esc 取消、两张字段表。整个脚本**必须自包含** —— 宿主用
 * pickerRuntime.toString() 注入，引用外部变量则 new Function 出来的副本当场抛 ReferenceError；面板长在外部页面里
 * 带不进设计系统样式表，所以下拉菜单与盒模型行都自绘。 */

export interface PickerRuntimeArgs {
  readonly token: string
  readonly theme: 'light' | 'dark'
  readonly callbackUrl: string
}

export function pickerRuntime(args: PickerRuntimeArgs): void {
  type Option = { readonly label: string; readonly value: string }
  type SubField = { readonly label: string; readonly property: string; readonly unit: string }
  type Field =
    | { readonly kind: 'text'; readonly label: string; readonly property: string; readonly placeholder?: string }
    | { readonly kind: 'number'; readonly label: string; readonly property: string; readonly unit: string }
    | {
        readonly kind: 'select'
        readonly label: string
        readonly property: string
        readonly options: readonly Option[]
      }
    | { readonly kind: 'color'; readonly label: string; readonly property: string }
    | {
        readonly kind: 'cells'
        readonly label: string
        readonly properties: readonly string[]
        readonly subs: readonly SubField[]
      }
  type Group = { readonly fields: readonly Field[] }
  type Baseline = { readonly value: string; readonly priority: string; readonly computed: string }
  type Change = { readonly previous: string; readonly value: string }

  const length = (label: string, property: string): SubField => ({ label, property, unit: 'px' })

  const weightOptions: readonly Option[] = [
    { label: '100', value: '100' },
    { label: '200', value: '200' },
    { label: '300', value: '300' },
    { label: '400', value: '400' },
    { label: '500', value: '500' },
    { label: '600', value: '600' },
    { label: '700', value: '700' },
    { label: '800', value: '800' },
    { label: '900', value: '900' },
  ]

  const fontOptions: readonly Option[] = [
    { label: '系统默认', value: 'system-ui, sans-serif' },
    { label: '苹方', value: '"PingFang SC", "Microsoft YaHei", sans-serif' },
    { label: '微软雅黑', value: '"Microsoft YaHei", sans-serif' },
    { label: '黑体', value: '"SimHei", sans-serif' },
    { label: '宋体', value: '"SimSun", serif' },
    { label: 'Arial', value: 'Arial, sans-serif' },
    { label: 'Georgia', value: 'Georgia, serif' },
    { label: '等宽', value: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
  ]

  /* 行序与基准图一致：颜色 → 文字 → 效果 → 边框 → 盒模型 → 布局 → 尺寸 → Flex → Grid。 */
  const groups: readonly Group[] = [
    {
      fields: [
        { kind: 'color', label: '文本颜色', property: 'color' },
        { kind: 'color', label: '背景', property: 'background-color' },
        { kind: 'number', label: 'Opacity', property: 'opacity', unit: '' },
      ],
    },
    {
      fields: [
        { kind: 'select', label: '字体', property: 'font-family', options: fontOptions },
        { kind: 'number', label: '字号', property: 'font-size', unit: 'px' },
        { kind: 'select', label: '字重', property: 'font-weight', options: weightOptions },
        { kind: 'number', label: '行高', property: 'line-height', unit: '' },
        { kind: 'number', label: '字距', property: 'letter-spacing', unit: 'px' },
        {
          kind: 'select',
          label: '文本对齐',
          property: 'text-align',
          options: [
            { label: '左', value: 'start' },
            { label: '居中', value: 'center' },
            { label: '右', value: 'end' },
            { label: '两端对齐', value: 'justify' },
          ],
        },
        {
          kind: 'select',
          label: '转换',
          property: 'text-transform',
          options: [
            { label: '无', value: 'none' },
            { label: '大写', value: 'uppercase' },
            { label: '小写', value: 'lowercase' },
            { label: '首字母大写', value: 'capitalize' },
          ],
        },
        { kind: 'text', label: '装饰', property: 'text-decoration' },
      ],
    },
    {
      fields: [
        { kind: 'text', label: '阴影', property: 'box-shadow' },
        { kind: 'text', label: '滤镜', property: 'filter' },
        { kind: 'text', label: '混合模式', property: 'mix-blend-mode' },
      ],
    },
    {
      fields: [
        { kind: 'number', label: '边框宽度', property: 'border-width', unit: 'px' },
        {
          kind: 'select',
          label: '边框样式',
          property: 'border-style',
          options: [
            { label: '无', value: 'none' },
            { label: '实线', value: 'solid' },
            { label: '虚线', value: 'dashed' },
            { label: '点线', value: 'dotted' },
            { label: '双线', value: 'double' },
          ],
        },
        { kind: 'color', label: '边框颜色', property: 'border-color' },
        { kind: 'number', label: '圆角', property: 'border-radius', unit: 'px' },
        { kind: 'text', label: '轮廓', property: 'outline' },
      ],
    },
    {
      fields: [
        {
          kind: 'cells',
          label: '内边距',
          properties: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
          subs: [
            length('上', 'padding-top'),
            length('右', 'padding-right'),
            length('下', 'padding-bottom'),
            length('左', 'padding-left'),
          ],
        },
        {
          kind: 'cells',
          label: '外边距',
          properties: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
          subs: [
            length('上', 'margin-top'),
            length('右', 'margin-right'),
            length('下', 'margin-bottom'),
            length('左', 'margin-left'),
          ],
        },
        {
          kind: 'cells',
          label: '间距',
          properties: ['column-gap', 'row-gap'],
          subs: [length('水平', 'column-gap'), length('垂直', 'row-gap')],
        },
      ],
    },
    {
      fields: [
        {
          kind: 'select',
          label: '布局方向',
          property: 'flex-direction',
          options: [
            { label: '水平', value: 'row' },
            { label: '水平反向', value: 'row-reverse' },
            { label: '垂直', value: 'column' },
            { label: '垂直反向', value: 'column-reverse' },
          ],
        },
        {
          kind: 'select',
          label: '分布',
          property: 'justify-content',
          options: [
            { label: '开始', value: 'flex-start' },
            { label: '居中', value: 'center' },
            { label: '结束', value: 'flex-end' },
            { label: '两端对齐', value: 'space-between' },
            { label: '环绕', value: 'space-around' },
            { label: '均分', value: 'space-evenly' },
          ],
        },
        {
          kind: 'select',
          label: '对齐',
          property: 'align-items',
          options: [
            { label: '拉伸', value: 'stretch' },
            { label: '开始', value: 'flex-start' },
            { label: '居中', value: 'center' },
            { label: '结束', value: 'flex-end' },
            { label: '基线', value: 'baseline' },
          ],
        },
        {
          kind: 'select',
          label: '显示',
          property: 'display',
          options: [
            { label: '块级', value: 'block' },
            { label: '行内', value: 'inline' },
            { label: '行内块', value: 'inline-block' },
            { label: '弹性', value: 'flex' },
            { label: '行内弹性', value: 'inline-flex' },
            { label: '网格', value: 'grid' },
            { label: '行内网格', value: 'inline-grid' },
            { label: '无', value: 'none' },
          ],
        },
        {
          kind: 'select',
          label: '定位',
          property: 'position',
          options: [
            { label: '静态', value: 'static' },
            { label: '相对', value: 'relative' },
            { label: '绝对', value: 'absolute' },
            { label: '固定', value: 'fixed' },
            { label: '粘性', value: 'sticky' },
          ],
        },
        { kind: 'number', label: '上', property: 'top', unit: 'px' },
        { kind: 'number', label: '右', property: 'right', unit: 'px' },
        { kind: 'number', label: '下', property: 'bottom', unit: 'px' },
        { kind: 'number', label: '左', property: 'left', unit: 'px' },
        { kind: 'number', label: '层级', property: 'z-index', unit: '' },
      ],
    },
    {
      fields: [
        { kind: 'number', label: '宽度', property: 'width', unit: 'px' },
        { kind: 'number', label: '最小宽', property: 'min-width', unit: 'px' },
        { kind: 'number', label: '最大宽', property: 'max-width', unit: 'px' },
        { kind: 'number', label: '高度', property: 'height', unit: 'px' },
        { kind: 'number', label: '最小高', property: 'min-height', unit: 'px' },
        { kind: 'number', label: '最大高', property: 'max-height', unit: 'px' },
        { kind: 'text', label: '纵横比', property: 'aspect-ratio' },
      ],
    },
    {
      fields: [
        {
          kind: 'select',
          label: '换行',
          property: 'flex-wrap',
          options: [
            { label: '不换行', value: 'nowrap' },
            { label: '换行', value: 'wrap' },
            { label: '反向换行', value: 'wrap-reverse' },
          ],
        },
        {
          kind: 'select',
          label: '自身对齐',
          property: 'align-self',
          options: [
            { label: '自动', value: 'auto' },
            { label: '拉伸', value: 'stretch' },
            { label: '开始', value: 'flex-start' },
            { label: '居中', value: 'center' },
            { label: '结束', value: 'flex-end' },
            { label: '基线', value: 'baseline' },
          ],
        },
        { kind: 'number', label: '伸展', property: 'flex-grow', unit: '' },
        { kind: 'number', label: '收缩', property: 'flex-shrink', unit: '' },
        { kind: 'text', label: '基准', property: 'flex-basis' },
        { kind: 'number', label: '顺序', property: 'order', unit: '' },
      ],
    },
    {
      fields: [
        { kind: 'text', label: '列模板', property: 'grid-template-columns' },
        { kind: 'text', label: '行模板', property: 'grid-template-rows' },
        {
          kind: 'select',
          label: '自动流',
          property: 'grid-auto-flow',
          options: [
            { label: '按行', value: 'row' },
            { label: '按列', value: 'column' },
            { label: '紧凑', value: 'dense' },
            { label: '按行紧凑', value: 'row dense' },
            { label: '按列紧凑', value: 'column dense' },
          ],
        },
        { kind: 'text', label: '整体对齐', property: 'place-items' },
        {
          kind: 'select',
          label: '横向溢出',
          property: 'overflow-x',
          options: [
            { label: '可见', value: 'visible' },
            { label: '隐藏', value: 'hidden' },
            { label: '裁剪', value: 'clip' },
            { label: '滚动', value: 'scroll' },
            { label: '自动', value: 'auto' },
          ],
        },
        {
          kind: 'select',
          label: '纵向溢出',
          property: 'overflow-y',
          options: [
            { label: '可见', value: 'visible' },
            { label: '隐藏', value: 'hidden' },
            { label: '裁剪', value: 'clip' },
            { label: '滚动', value: 'scroll' },
            { label: '自动', value: 'auto' },
          ],
        },
        { kind: 'text', label: '变换', property: 'transform' },
        { kind: 'text', label: '变换原点', property: 'transform-origin' },
      ],
    },
  ]

  const gap = 8

  /* 面板长在外部页面里带不进设计系统的样式表：下面的取值逐像素取自基准图。 */
  const css = [
    ':host{all:initial;color-scheme:light;font:13px/1.4 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;--pk-bg:#fff;--pk-band:#f2f2f3;--pk-menu:#fff;--pk-menu-line:rgba(0,0,0,.14);--pk-text:rgba(0,0,0,.9);--pk-muted:rgba(0,0,0,.56);--pk-value:rgba(0,0,0,.5);--pk-faint:rgba(0,0,0,.38);--pk-placeholder:rgba(0,0,0,.26);--pk-line:rgba(0,0,0,.06);--pk-border:rgba(0,0,0,.14);--pk-hover:rgba(0,0,0,.05);--pk-glyph-hover:rgba(0,0,0,.1);--pk-glyph-active:rgba(0,0,0,.16);--pk-pill:#f2f2f3;--pk-pill-hover:#e8e8ea;--pk-circle:#bcbcbc;--pk-circle-fg:#555;--pk-accent:#3c82f7;--pk-danger:#dc2626}',
    ':host([data-theme=dark]){color-scheme:dark;--pk-bg:#2d2d2d;--pk-band:#363636;--pk-menu:#2d2d2d;--pk-menu-line:#454545;--pk-text:rgba(255,255,255,.85);--pk-muted:rgba(255,255,255,.56);--pk-value:rgba(255,255,255,.5);--pk-faint:rgba(255,255,255,.38);--pk-placeholder:rgba(255,255,255,.26);--pk-line:rgba(255,255,255,.06);--pk-border:rgba(255,255,255,.16);--pk-hover:rgba(255,255,255,.08);--pk-glyph-hover:rgba(255,255,255,.12);--pk-glyph-active:rgba(255,255,255,.2);--pk-pill:#343434;--pk-pill-hover:#3d3d3d;--pk-circle:#747474;--pk-circle-fg:#2d2d2d;--pk-accent:#3c82f7;--pk-danger:#e97366}',
    '*{box-sizing:border-box}',
    'button,input,textarea{font:inherit;color:inherit;margin:0}',
    'button{border:0;background:transparent;cursor:pointer;padding:0;text-align:left}',
    '.outline{position:fixed;z-index:2147483646;pointer-events:none;border:2px solid var(--pk-accent);background:color-mix(in srgb,var(--pk-accent) 10%,transparent);border-radius:4px}',
    '.badge{position:absolute;left:-2px;bottom:100%;max-width:280px;padding:2px 7px;border-radius:6px 6px 0 0;background:var(--pk-accent);color:#fff;font:600 11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    /* 浮条是面板的收起态：位置按选中元素算，居中会在切换时跳一下。 */
    '.bar{position:fixed;z-index:2147483647;width:min(294px,calc(100vw - 24px));height:44px;display:flex;align-items:center;gap:14px;padding:0 8px 0 14px;border-radius:22px;background:var(--pk-bg);color:var(--pk-text);box-shadow:0 10px 28px rgba(0,0,0,.35),0 0 0 1px rgba(0,0,0,.08)}',
    '.bar[hidden]{display:none}',
    '.barGlyph{flex:0 0 28px;width:28px;height:28px;display:flex;align-items:center;justify-content:center;border:0;border-radius:50%;background:transparent;color:rgba(255,255,255,.7);cursor:pointer;transition:background .12s ease}',
    '.barGlyph:hover{background:var(--pk-glyph-hover)}',
    '.barGlyph:active{background:var(--pk-glyph-active)}',
    '.barNote{flex:1;min-width:0;height:20px;padding:0;border:0;background:transparent;line-height:20px;resize:none;outline:none;overflow:hidden}',
    '.barNote::placeholder{color:var(--pk-placeholder)}',
    '.panel{position:fixed;z-index:2147483647;width:min(344px,calc(100vw - 16px));max-height:min(344px,calc(100vh - 16px));display:none;flex-direction:column;border-radius:22px;background:var(--pk-bg);color:var(--pk-text);box-shadow:0 16px 44px rgba(0,0,0,.42),0 0 0 1px rgba(0,0,0,.1);overflow:hidden}',
    '.panel[data-open=true]{display:flex}',
    /* 三块固定带必须禁掉 flex 收缩：面板到顶后 body 会长，默认收缩会把标签带压回 12px。 */
    '.head{flex:0 0 auto;display:flex;align-items:flex-start;gap:8px;padding:8px 14px 8px 12px}',
    '.glyph{flex:0 0 28px;width:28px;height:28px;display:flex;align-items:center;justify-content:center;border:0;border-radius:50%;background:var(--pk-band);color:var(--pk-text);cursor:pointer;transition:background .12s ease}',
    '.glyph:hover{background:var(--pk-glyph-hover)}',
    '.glyph:active{background:var(--pk-glyph-active)}',
    '.note{flex:1;min-width:0;height:28px;max-height:76px;padding:6px 0;border:0;background:transparent;line-height:1.35;resize:none;outline:none;overflow:auto;scrollbar-width:none}',
    '.note::-webkit-scrollbar{width:0;height:0}',
    '.note::placeholder{color:var(--pk-placeholder)}',
    '.band{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px;height:34px;padding:0 16px;background:var(--pk-band);color:var(--pk-muted)}',
    '.tag{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:11px/1 ui-monospace,SFMono-Regular,Consolas,monospace}',
    '.grip{display:flex;flex:0 0 auto;color:var(--pk-faint)}',
    /* 右侧留 12px 给浏览器原生滚动条：基准图里它是系统样式，内容右边缘落在 317。 */
    '.body{flex:1;min-height:0;overflow:auto;padding:6px 16px 4px;scrollbar-width:thin;scrollbar-color:#6e6e6e transparent}',
    '.body::-webkit-scrollbar{width:8px;height:8px}',
    '.body::-webkit-scrollbar-track{background:transparent}',
    '.body::-webkit-scrollbar-thumb{background:#6e6e6e;border-radius:4px}',
    '.group+.group{margin-top:5px;padding-top:5px;border-top:1px solid var(--pk-line)}',
    '.row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;min-height:35px;padding:0}',
    '.row[data-expanded=true]>.control{display:none}',
    '.label{display:flex;align-items:center;gap:4px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--pk-muted)}',
    '.label[data-action=true]{cursor:pointer}',
    '.chev{flex:0 0 auto;display:flex;color:var(--pk-faint);transition:transform .16s ease}',
    '.row[data-expanded=true] .chev{transform:rotate(90deg)}',
    '.control{position:relative;display:flex;min-width:0}',
    '.control[data-width=sm]{width:112px}',
    '.control[data-width=md]{width:146px}',
    '.control[data-width=lg]{width:194px}',
    '.control[data-width=xl]{width:170px}',
    '.box{display:flex;align-items:center;width:100%;height:30px;border:1px solid var(--pk-border);border-radius:10px;background:transparent;color:var(--pk-value);overflow:hidden}',
    '.box:focus-within{border-color:var(--pk-muted)}',
    '.box input{flex:1;min-width:0;height:100%;padding:0 12px;border:0;background:transparent;color:var(--pk-value);outline:none}',
    '.box input::placeholder{color:var(--pk-placeholder)}',
    '.unit{flex:0 0 auto;padding-right:12px;color:var(--pk-faint)}',
    '.swatch{flex:0 0 auto;width:20px;height:20px;margin-left:5px;border:1px solid var(--pk-border);border-radius:7px}',
    '.box[data-kind=color] input{padding-left:8px}',
    '.select{justify-content:space-between;padding:0 12px;cursor:pointer}',
    '.select .value{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
    '.caret{flex:0 0 auto;margin-left:6px;color:var(--pk-faint)}',
    '.cells{display:flex;width:100%;height:30px;border:1px solid var(--pk-border);border-radius:10px;overflow:hidden}',
    '.cells:focus-within{border-color:var(--pk-muted)}',
    '.cells input{flex:1;min-width:0;height:100%;padding:0 2px;border:0;border-left:1px solid var(--pk-border);border-radius:0;background:transparent;color:var(--pk-value);text-align:center;outline:none}',
    '.cells input:first-child{border-left:0}',
    /* 菜单挂在独立图层：属性表可滚动，画在行里的菜单会被裁掉一半。 */
    '.menus{position:fixed;z-index:2147483647;left:0;top:0;width:0;height:0}',
    '.menu{position:fixed;display:flex;flex-direction:column;min-width:196px;max-height:min(264px,calc(100vh - 16px));padding:5px 4px;border:1px solid var(--pk-menu-line);border-radius:12px;background:var(--pk-menu);box-shadow:0 12px 30px rgba(0,0,0,.45);overflow:auto}',
    '.menu::-webkit-scrollbar{width:8px;height:8px}',
    '.menu::-webkit-scrollbar-thumb{background:#6e6e6e;border-radius:4px}',
    '.menu button{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;height:32px;padding:0 14px;border-radius:8px;font-size:14px;white-space:nowrap;color:var(--pk-text)}',
    '.menu button:hover{background:var(--pk-hover)}',
    '.tick{flex:0 0 auto;display:flex;opacity:0}',
    '.menu button[data-selected=true] .tick{opacity:1}',
    '.status{padding:0 16px 2px;color:var(--pk-faint);font-size:12px}',
    '.status:empty{display:none}',
    '.status[data-tone=error]{color:var(--pk-danger)}',
    '.foot{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:10px 8px;border-top:1px solid var(--pk-line)}',
    '.cancel{height:28px;padding:0 10px;border-radius:14px;background:var(--pk-pill);color:var(--pk-text);transition:background .12s ease}',
    '.cancel:hover{background:var(--pk-pill-hover)}',
    '.cancel:active{transform:scale(.96)}',
    '.send{flex:0 0 28px;width:28px;height:28px;margin-left:auto;display:flex;align-items:center;justify-content:center;border-radius:50%;background:var(--pk-circle);color:var(--pk-circle-fg);transition:filter .12s ease}',
    '.send:hover{filter:brightness(1.08)}',
    '.send:active{transform:scale(.94)}',
    '.cancel:focus-visible,.send:focus-visible,.box:focus-visible{outline:2px solid var(--pk-accent);outline-offset:2px}',
  ].join('\n')

  const sliders =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.6 5.4h3.6M10.6 5.4h2.8M2.6 10.6h2.8M9.4 10.6h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="5.4" r="1.7" stroke="currentColor" stroke-width="1.5"/><circle cx="7.8" cy="10.6" r="1.7" stroke="currentColor" stroke-width="1.5"/></svg>'
  const grip =
    '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><circle cx="2.4" cy="4.2" r="1.05"/><circle cx="6" cy="4.2" r="1.05"/><circle cx="9.6" cy="4.2" r="1.05"/><circle cx="2.4" cy="7.8" r="1.05"/><circle cx="6" cy="7.8" r="1.05"/><circle cx="9.6" cy="7.8" r="1.05"/></svg>'
  const check =
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.6 8.5l2.9 2.9 5.9-6.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  const caret =
    '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 3.8l3 3 3-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  const chevron =
    '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4.6 3l3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'

  const markup =
    `<div class="bar" hidden><button class="barGlyph" type="button" aria-label="打开元素样式面板">${sliders}</button><textarea class="barNote" rows="1" aria-label="评论" placeholder="添加评论..."></textarea><button class="send barSend" type="button" aria-label="发送">${check}</button></div>` +
    '<section class="panel" data-open="false" role="dialog" aria-label="编辑所选元素">' +
    `<div class="head"><span class="glyph">${sliders}</span><textarea class="note" rows="1" aria-label="修改需求" placeholder="描述这些更改..."></textarea></div>` +
    `<div class="band"><span class="tag">&lt;a&gt;</span><span class="grip">${grip}</span></div>` +
    '<div class="body" role="group" aria-label="元素属性"></div>' +
    '<div class="status" role="status"></div>' +
    `<div class="foot"><button class="cancel" type="button">取消</button><button class="send" type="button" aria-label="发送给 AI">${check}</button></div>` +
    '</section>' +
    '<div class="menus"></div>'

  function clamp(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(value, Math.max(low, high)))
  }

  /** 只留数字：基准图的盒模型格子写的是 `0`，不是 `0px`。 */
  function bare(value: string): string {
    return value.endsWith('px') ? value.slice(0, -2).trim() : value
  }

  /** 纯数字才补单位；用户自己写了 % / em / vw 就别动。 */
  function sized(value: string, unit: string): string {
    if (value === '' || unit === '') {
      return value
    }

    return /^[+-]?[\d.]+$/u.test(value) ? `${value}${unit}` : value
  }

  function labelOf(field: Extract<Field, { kind: 'select' }>, current: string): string {
    return field.options.find((option) => option.value === current)?.label ?? current
  }

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

  function cellName(field: Extract<Field, { kind: 'cells' }>, index: number): string {
    const names = field.properties.length === 2 ? ['水平', '垂直'] : ['上', '右', '下', '左']

    return names[index] ?? ''
  }

  class ElementPicker {
    private token: string | null = null
    private host: HTMLElement | null = null
    private outline: HTMLElement | null = null
    private badge: HTMLElement | null = null
    private bar: HTMLElement | null = null
    private barNote: HTMLTextAreaElement | null = null
    private panel: HTMLElement | null = null
    private menus: HTMLElement | null = null
    private body: HTMLElement | null = null
    private tag: HTMLElement | null = null
    private comment: HTMLTextAreaElement | null = null
    private status: HTMLElement | null = null
    private hovered: Element | null = null
    /** 光标最后落点：浮条按钮长在宿主里，点它时取不到「刚才看着的那个元素」。 */
    private lastPoint: { readonly x: number; readonly y: number } | null = null
    private selected: Element | null = null
    private busy = false
    private openMenu: { readonly control: HTMLElement; readonly menu: HTMLElement } | null = null
    private readonly expanded = new Set<string>()
    private readonly baseline = new Map<string, Baseline>()
    private readonly changes = new Map<string, Change>()

    start(token: string, theme: 'light' | 'dark'): void {
      this.cancel()
      this.token = token
      this.ensureUi(theme)
      this.setBarVisible(false)
      document.addEventListener('pointerdown', this.onPointerDown, true)
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
      this.bar = null
      this.barNote = null
      this.panel = null
      this.menus = null
      this.body = null
      this.tag = null
      this.comment = null
      this.status = null
      this.hovered = null
      this.selected = null
      this.openMenu = null
      this.token = null
      this.busy = false
      this.expanded.clear()
      this.baseline.clear()
      this.changes.clear()
    }

    private unbind(): void {
      document.removeEventListener('pointerdown', this.onPointerDown, true)
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
      const shell = document.createElement('div')
      shell.innerHTML = markup

      root.append(style, outline, shell)
      document.documentElement.append(host)

      this.host = host
      this.outline = outline
      this.badge = badge
      this.bar = shell.querySelector<HTMLElement>('.bar')
      this.barNote = shell.querySelector<HTMLTextAreaElement>('.barNote')
      this.panel = shell.querySelector<HTMLElement>('.panel')
      this.menus = shell.querySelector<HTMLElement>('.menus')
      this.body = shell.querySelector<HTMLElement>('.body')
      this.tag = shell.querySelector<HTMLElement>('.tag')
      this.comment = shell.querySelector<HTMLTextAreaElement>('.note')
      this.status = shell.querySelector<HTMLElement>('.status')

      this.comment?.addEventListener('input', () => this.autosize())
      // 浮条与面板共用同一句需求：在哪边写的都一样，切换时不能丢。
      this.barNote?.addEventListener('input', () => {
        if (this.comment !== null && this.barNote !== null) {
          this.comment.value = this.barNote.value
        }
      })
      shell.querySelector('.cancel')?.addEventListener('click', () => this.sendCancel())
      shell.querySelector('.foot .send')?.addEventListener('click', () => void this.submit('send'))
      shell.querySelector('.barGlyph')?.addEventListener('click', () => this.togglePanel())
      shell.querySelector('.barSend')?.addEventListener('click', () => {
        if (this.selected === null) {
          this.sendCancel()
        } else {
          void this.submit('send')
        }
      })
      shell.querySelector('.glyph')?.addEventListener('click', () => this.togglePanel())
    }

    private togglePanel(): void {
      const panel = this.panel

      if (this.selected !== null && panel !== null) {
        if (panel.getAttribute('data-open') === 'true') {
          panel.setAttribute('data-open', 'false')
          this.setBarVisible(true)
        } else {
          panel.setAttribute('data-open', 'true')
          this.setBarVisible(false)
          this.position()
          this.comment?.focus()
        }

        return
      }

      const point = this.lastPoint
      const candidate =
        this.hovered ??
        (point === null ? null : document.elementFromPoint(point.x, point.y)) ??
        document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)

      if (grabbable(candidate) && candidate !== this.host) {
        this.select(candidate)
      }
    }

    private setBarVisible(visible: boolean): void {
      if (this.bar !== null) {
        this.bar.hidden = !visible
      }
    }

    /** 点到菜单与它的控件之外就收起：挂在独立图层上收不到 blur。 */
    private readonly onPointerDown = (event: PointerEvent): void => {
      const open = this.openMenu

      if (open !== null && !event.composedPath().includes(open.control) && !event.composedPath().includes(open.menu)) {
        this.closeMenu()
      }
    }

    private readonly onPointerMove = (event: PointerEvent): void => {
      if (this.isUiEvent(event) || this.selected !== null) {
        return
      }

      this.lastPoint = { x: event.clientX, y: event.clientY }

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
      if (event.key !== 'Escape') {
        return
      }

      if (this.isUiEvent(event)) {
        return
      }

      event.preventDefault()

      if (this.selected === null) {
        this.sendCancel()
      } else {
        this.clearSelection()
      }
    }

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
      this.closeMenu()
      this.selected = element
      this.hovered = element
      this.draw(element)
      /* 选中之后默认收成浮条：面板要用户点左侧图标才展开。 */
      this.setBarVisible(true)
      this.panel?.setAttribute('data-open', 'false')
      this.position()
      this.note('')

      // 浮条里先写的需求跟着进面板：选中元素不该把它丢掉。
      if (this.comment !== null && this.barNote !== null) {
        this.comment.value = this.barNote.value
      }

      if (this.tag !== null) {
        this.tag.textContent = `<${element.tagName.toLowerCase()}>`
      }

      this.renderGroups()
    }

    private clearSelection(): void {
      this.restore()
      this.selected = null
      this.changes.clear()
      this.baseline.clear()
      this.closeMenu()
      this.panel?.setAttribute('data-open', 'false')
      this.note('')
      this.setBarVisible(false)
    }

    private position(): void {
      const panel = this.panel
      const bar = this.bar

      if (panel === null || bar === null || this.selected === null) {
        return
      }

      const anchor = boundsOf(this.selected)

      if (anchor === null) {
        return
      }

      const open = panel.getAttribute('data-open') === 'true'
      const target = open ? panel : bar
      const rect = target.getBoundingClientRect()
      const below = anchor.y + anchor.height + gap
      const room = window.innerHeight - below
      const top = room >= rect.height || room >= anchor.y - gap ? below : anchor.y - rect.height - gap
      const left = anchor.x + rect.width > window.innerWidth - gap ? anchor.x + anchor.width - rect.width : anchor.x
      const x = clamp(left, gap, window.innerWidth - rect.width - gap)
      const y = clamp(top, gap, window.innerHeight - rect.height - gap)

      for (const node of [bar, panel]) {
        node.style.left = `${x}px`
        node.style.top = `${y}px`
      }
    }

    private autosize(): void {
      const note = this.comment

      if (note === null) {
        return
      }

      note.style.height = 'auto'
      note.style.height = `${String(Math.min(note.scrollHeight, 76))}px`
    }

    private renderGroups(): void {
      const body = this.body

      if (body === null || this.selected === null) {
        return
      }

      const top = body.scrollTop

      this.closeMenu()
      body.replaceChildren()

      const computed = getComputedStyle(this.selected)

      for (const group of groups) {
        const section = document.createElement('section')
        section.className = 'group'

        for (const field of group.fields) {
          section.append(this.renderRow(field, computed))

          if (field.kind === 'cells' && this.expanded.has(field.label)) {
            for (const sub of field.subs) {
              section.append(this.renderSubRow(sub, computed))
            }
          }
        }

        body.append(section)
      }

      // 展开/收起时留在原来的位置：重新渲染不该把人弹回表头。
      body.scrollTop = top
    }

    private renderRow(field: Field, computed: CSSStyleDeclaration): HTMLElement {
      const row = document.createElement('div')
      row.className = 'row'
      row.dataset.kind = field.kind

      const caption = document.createElement('span')
      caption.className = 'label'
      caption.textContent = field.label
      caption.title = field.label
      row.append(caption, this.createControl(field, computed))

      if (field.kind === 'cells' && field.subs.length > 0) {
        const chev = document.createElement('span')
        chev.className = 'chev'
        chev.innerHTML = chevron
        caption.dataset.action = 'true'
        caption.append(chev)
        row.dataset.expanded = this.expanded.has(field.label) ? 'true' : 'false'
        caption.addEventListener('click', () => {
          if (this.expanded.has(field.label)) {
            this.expanded.delete(field.label)
          } else {
            this.expanded.add(field.label)
          }

          this.renderGroups()
        })
      }

      return row
    }

    private renderSubRow(sub: SubField, computed: CSSStyleDeclaration): HTMLElement {
      const row = document.createElement('div')
      row.className = 'row'
      row.dataset.kind = 'number'
      const caption = document.createElement('span')
      caption.className = 'label'
      caption.textContent = sub.label
      row.append(caption, this.numberControl(sub.label, sub.property, sub.unit, computed))

      return row
    }

    private createControl(field: Field, computed: CSSStyleDeclaration): HTMLElement {
      if (field.kind === 'cells') {
        return this.cellsControl(field, computed)
      }

      if (field.kind === 'select') {
        return this.selectControl(field, computed)
      }

      if (field.kind === 'number') {
        return this.numberControl(field.label, field.property, field.unit, computed)
      }

      if (field.kind === 'color') {
        return this.colorControl(field, computed)
      }

      const control = this.box(field.label, 'md', computed.getPropertyValue(field.property).trim(), false)
      const input = control.querySelector<HTMLInputElement>('input')

      if (input !== null) {
        input.placeholder = field.placeholder ?? 'CSS 值'
        input.addEventListener('change', () => this.apply(field.property, input.value.trim()))
      }

      return control
    }

    private box(label: string, width: 'sm' | 'md' | 'lg', value: string, numeric: boolean): HTMLElement {
      const control = document.createElement('span')
      control.className = 'control'
      control.dataset.width = width
      const shell = document.createElement('span')
      shell.className = 'box'
      const input = document.createElement('input')
      input.setAttribute('aria-label', label)
      input.value = numeric ? bare(value) : value
      shell.append(input)
      control.append(shell)

      return control
    }

    private numberControl(label: string, property: string, unit: string, computed: CSSStyleDeclaration): HTMLElement {
      const control = this.box(label, 'sm', computed.getPropertyValue(property).trim(), true)
      const input = control.querySelector<HTMLInputElement>('input')

      if (input !== null) {
        input.placeholder = '0'
        input.addEventListener('change', () => this.apply(property, sized(input.value.trim(), unit)))
      }

      if (unit !== '') {
        const suffix = document.createElement('span')
        suffix.className = 'unit'
        suffix.textContent = unit
        control.querySelector('.box')?.append(suffix)
      }

      return control
    }

    private colorControl(field: Extract<Field, { kind: 'color' }>, computed: CSSStyleDeclaration): HTMLElement {
      const control = this.box(field.label, 'md', computed.getPropertyValue(field.property).trim(), false)
      const shell = control.querySelector<HTMLElement>('.box')
      const input = control.querySelector<HTMLInputElement>('input')

      if (shell === null || input === null) {
        return control
      }

      shell.dataset.kind = 'color'
      const swatch = document.createElement('span')
      swatch.className = 'swatch'
      swatch.dataset.property = field.property
      swatch.style.background = computed.getPropertyValue(field.property).trim()
      shell.prepend(swatch)
      input.addEventListener('change', () => this.apply(field.property, input.value.trim()))

      return control
    }

    private cellsControl(field: Extract<Field, { kind: 'cells' }>, computed: CSSStyleDeclaration): HTMLElement {
      const control = document.createElement('span')
      control.className = 'control'
      control.dataset.width = 'lg'
      const cells = document.createElement('span')
      cells.className = 'cells'

      for (const [index, property] of field.properties.entries()) {
        const input = document.createElement('input')
        input.setAttribute('aria-label', `${field.label}-${cellName(field, index)}`)
        input.value = bare(computed.getPropertyValue(property).trim())
        input.addEventListener('change', () => this.apply(property, sized(input.value.trim(), 'px')))
        cells.append(input)
      }

      control.append(cells)

      return control
    }

    private selectControl(field: Extract<Field, { kind: 'select' }>, computed: CSSStyleDeclaration): HTMLElement {
      const control = document.createElement('span')
      control.className = 'control'
      control.dataset.width = 'md'
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'box select'
      button.setAttribute('aria-label', field.label)
      const value = document.createElement('span')
      value.className = 'value'
      value.textContent = labelOf(field, computed.getPropertyValue(field.property).trim())
      const icon = document.createElement('span')
      icon.className = 'caret'
      icon.innerHTML = caret
      button.append(value, icon)
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.toggleMenu(field, control, value)
      })
      control.append(button)

      return control
    }

    /** 自绘的下拉：原生 select 画不出基准图这张菜单。 */
    private toggleMenu(field: Extract<Field, { kind: 'select' }>, control: HTMLElement, value: HTMLElement): void {
      if (this.openMenu !== null && this.openMenu.control === control) {
        this.closeMenu()

        return
      }

      this.closeMenu()

      if (this.selected === null) {
        return
      }

      const current = getComputedStyle(this.selected).getPropertyValue(field.property).trim()
      const menu = document.createElement('div')
      menu.className = 'menu'
      menu.setAttribute('role', 'listbox')

      for (const option of field.options) {
        const item = document.createElement('button')
        item.type = 'button'
        item.setAttribute('role', 'option')
        item.dataset.selected = option.value === current ? 'true' : 'false'
        const text = document.createElement('span')
        text.textContent = option.label
        const tick = document.createElement('span')
        tick.className = 'tick'
        tick.innerHTML = check
        item.append(text, tick)
        item.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          value.textContent = option.label
          this.closeMenu()
          this.apply(field.property, option.value)
        })
        menu.append(item)
      }

      this.menus?.append(menu)
      this.openMenu = { control, menu }
      this.revealMenu(control, menu)
    }

    private revealMenu(control: HTMLElement, menu: HTMLElement): void {
      const rect = control.getBoundingClientRect()
      const size = menu.getBoundingClientRect()
      const below = rect.bottom + 4
      const above = rect.top - size.height - 4
      const top = below + size.height <= window.innerHeight - 4 || above < 4 ? below : above
      const left = clamp(rect.right - size.width, 4, window.innerWidth - size.width - 4)

      menu.style.left = `${left}px`
      menu.style.top = `${clamp(top, 4, window.innerHeight - size.height - 4)}px`
      menu.style.minWidth = `${rect.width}px`
    }

    private closeMenu(): void {
      this.openMenu?.menu.remove()
      this.openMenu = null
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
      this.syncSwatches()
      this.position()
    }

    private syncSwatches(): void {
      if (this.selected === null) {
        return
      }

      const computed = getComputedStyle(this.selected)

      for (const swatch of this.panel?.querySelectorAll<HTMLElement>('.swatch') ?? []) {
        const property = swatch.dataset.property

        if (property !== undefined) {
          swatch.style.background = computed.getPropertyValue(property).trim()
        }
      }
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

    /** 快照就是面板上那条属性表：屏幕上看得见的每一项都进文件。 */
    private snapshot(): string {
      const selected = this.selected

      if (selected === null) {
        return ''
      }

      const computed = getComputedStyle(selected)
      const lines: string[] = []

      for (const group of groups) {
        for (const field of group.fields) {
          lines.push(...this.fieldLines(field, computed))
        }

        lines.push('')
      }

      return lines.join('\n')
    }

    private fieldLines(field: Field, computed: CSSStyleDeclaration): string[] {
      if (field.kind === 'cells') {
        return field.properties.map((property, index) => {
          const value = computed.getPropertyValue(property).trim()

          return `${field.label}-${cellName(field, index)} (${property}): ${value}`
        })
      }

      const value = computed.getPropertyValue(field.property).trim()

      return [`${field.label} (${field.property}): ${value}`]
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
      for (const button of this.panel?.querySelectorAll<HTMLButtonElement>('button') ?? []) {
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
