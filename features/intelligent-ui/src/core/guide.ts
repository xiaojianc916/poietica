import {
  INTELLIGENT_UI_HTML_MAX,
  INTELLIGENT_UI_LIBRARIES,
  INTELLIGENT_UI_LIBRARY_ORIGINS,
  INTELLIGENT_UI_MODEL_STATE_MAX,
  INTELLIGENT_UI_TOKEN_NAMES,
  INTELLIGENT_UI_TWEAK_CONTROLS_MAX,
  INTELLIGENT_UI_TWEAK_GROUPS_MAX,
  INTELLIGENT_UI_TWEAK_OPTIONS_MAX,
  INTELLIGENT_UI_VIEW_STATE_MAX,
  INTELLIGENT_UI_WIDE_WIDTH,
  intelligentUiLibraryUrls,
} from '../contract'

/*
 * intelligent_ui 的长篇指南：模型按需调 intelligent_ui_guide 取一次（同一对话里不必再取）。
 *
 * 为什么不放进工具描述：工具描述每一轮都进系统提示，按 token 计费；指南写得越细，不用界面的那些轮
 * 白付的钱越多。旧的 show_widget 把约 2.5 KB 塞在描述里，样式又只有元素级的那一套 —— 写短了模型
 * 做不好看，写长了每轮都贵。拆开以后描述只留「什么时候用、怎么取指南」，指南可以写到真正够用。
 *
 * 类名清单在契约里（INTELLIGENT_UI_CLASS_NAMES）：外壳的 BASE_CSS 与这份指南都照它写，两边的单测各钉一半。
 * 随包库的清单也在契约里（INTELLIGENT_UI_LIBRARIES）：指南列出的地址就是外壳认的那几个，一个字都不能差。
 */

const BUNDLED = INTELLIGENT_UI_LIBRARIES.map(
  (library) =>
    `- ${library.name} ${library.version} (global ${library.global}): <script src="${intelligentUiLibraryUrls(library)[0]}"></script>`,
).join('\n')

export const INTELLIGENT_UI_GUIDE = `# intelligent_ui guide

An intelligent_ui view is a live mini app rendered inline in your reply. Use it when seeing or touching something beats
reading about it: design variants side by side, interactive charts, explorable data, calculators, simulations,
parameter tweakers, diagrams with controls, or a small form that collects structured choices.
Do not use it for plain text, short lists or a single static table: write Markdown instead.
To show a real running web page (a dev server, a deployed site), use the built-in browser (browser.open in eval).

## Writing the html
- Self-contained HTML, a full document or a fragment, up to ${INTELLIGENT_UI_HTML_MAX / 1024} KB. Scripts run.
- The user watches the view appear while you write it: until the call completes they see a static preview of the
  markup written so far (scripts do not run yet). Put <style> first, then the markup, and <script> last, so the preview
  already looks right.
- Each call shows a new view; it does not update an earlier one.

## Libraries
These are bundled with the app and load instantly, even offline. Use exactly these URLs with a classic script tag
(no type="module", no integrity or crossorigin attributes), and use the global they define:
${BUNDLED}
Other libraries load from ${INTELLIGENT_UI_LIBRARY_ORIGINS.join(', ')} (script/link tags or ES module imports).

## Environment
- Everything else on the network is blocked: fetch, XHR, WebSocket, remote images and fonts. Inline your data; use data:
  URLs or inline SVG for images.
- localStorage works but is in-memory for this view only. alert/confirm/prompt and popups do nothing.
- Width is the chat column (about 720px, may be narrower): make layouts responsive, never assume a fixed width.
  Exception: wide: true lays the view out at ${INTELLIGENT_UI_WIDE_WIDTH}px and scales it down to fit (the user can expand it
  to full size). Use it only for full-screen desktop app mockups.
- Height follows the content automatically. Do not use 100vh, height:100%, full-screen layouts or position:fixed
  overlays; the view has no viewport of its own to fill.
- The user can expand the view, copy it as an image and export it as a standalone HTML file; it is rebuilt from its
  state each time, so keep everything that matters in poietica.state (see below).

## Look and feel
The view sits directly on the chat background with no frame. Do not wrap everything in an outer card or add a big title:
your reply already introduces it. The theme follows the app (<html data-theme="light|dark">).
Body text, headings, buttons, inputs, selects, tables, code, fieldsets and progress bars are pre-styled to match the app.
Use these CSS variables instead of hard-coded colors so both themes work:
${INTELLIGENT_UI_TOKEN_NAMES.join(', ')}.
For charts drawn by a library, read them at runtime:
  const css = getComputedStyle(document.documentElement); const accent = css.getPropertyValue('--color-accent').trim()
and redraw on the "poietica:theme" event.

Layout and component classes (all optional, zero specificity, so your own CSS always wins):
- iu-stack: vertical flow with a 12px gap. iu-row: horizontal, wrapping, centered, 8px gap.
- iu-grid: responsive grid of equal columns (set --iu-min on it to change the 180px minimum column width).
- iu-card: a raised surface with border and padding; add aria-selected="true" to highlight the chosen one.
- iu-muted: secondary text. iu-stat > iu-stat-label + iu-stat-value: a big number with a caption.
- iu-badge: a small pill; combine with iu-success / iu-warning / iu-danger.
- iu-tabs: a row of buttons acting as tabs; mark the active one with aria-selected="true".
- iu-controls: a two-column grid of <label> + control rows for parameter panels.
- Buttons: class "primary" for the main action, "iu-ghost" for a quiet one, "iu-danger" for destructive ones.
- data-tooltip="text" on any element shows a tooltip on hover and focus.
Keep it calm: one accent color, generous spacing, tabular numbers for data, real labels for every control.

## Bridge (window.poietica)
- poietica.send(text): sends text to you as the user's next message. Call it directly from a click, key or submit handler
  (for example a "Use variant B" button). Calls that do not follow a real user action are turned into a confirmation the
  user has to accept, so never call it from timers, load handlers or loops.
- poietica.draft(text): puts text into the user's input box without sending (same rule as send).
- poietica.open(url): opens an http(s) or mailto link in the browser (same rule as send). Plain <a href> links work too.
- poietica.theme is "light" or "dark"; window fires a "poietica:theme" event when it changes.
- poietica.state and poietica.setState({ model, view }): see below.
- poietica.tweak({ label, controls, onChange }): see "Tweak panel".

## State: let the view tell you what the user did
- poietica.setState({ model }) records a small JSON value meant for you, for example
  { selected: "B", density: "compact" }. You receive the latest value together with the user's next message, inside a
  <poietica-context source="intelligent-ui"> block, so a view does not need to send a message just to report choices.
  Keep it short and self-explanatory (at most ${INTELLIGENT_UI_MODEL_STATE_MAX} characters of JSON).
- poietica.setState({ view }) records data only the view itself reads back (scroll position, input values, open tab;
  at most ${INTELLIGENT_UI_VIEW_STATE_MAX} characters of JSON). You never see it.
- Pass only the half you want to change; the other half is kept. Pass null to clear a half.
- poietica.state is { model, view } as last saved. Read it on startup and restore the UI from it: the view can be
  unloaded when it scrolls far away or when the conversation is reopened, and is rebuilt from this state.

## Tweak panel
For views whose point is adjusting a few parameters (colors, sizes, density, a toggle), register them instead of drawing
your own sliders. The app shows them as native controls in a panel next to the view and keeps the values:
  const t = poietica.tweak({ label: 'Card', controls: [
    { key: 'radius', label: 'Corner radius', type: 'range', min: 0, max: 24, step: 1, value: 8, unit: 'px' },
    { key: 'accent', label: 'Accent', type: 'color', value: '#3b82f6' },
    { key: 'shadow', label: 'Shadow', type: 'toggle', value: true },
    { key: 'density', label: 'Density', type: 'select', value: 'cozy',
      options: [{ value: 'compact', label: 'Compact' }, { value: 'cozy', label: 'Cozy' }] },
  ], onChange: (values) => render(values) })
  render(t.values)
- onChange receives all values of the group, on every change and once on startup if the user changed them earlier.
  t.values is the current values; t.dispose() removes the group.
- Up to ${INTELLIGENT_UI_TWEAK_GROUPS_MAX} groups per view, ${INTELLIGENT_UI_TWEAK_CONTROLS_MAX} controls per group, ${INTELLIGENT_UI_TWEAK_OPTIONS_MAX} options per select.
  Labels must be unique per view.
- Values the user changed reach you with their next message (as "tweaks"; {} means they were all reset to the
  defaults), so do not mirror them into model state.

## Recipes
- Choosing between variants: render each variant in an iu-card inside an iu-grid; on click set aria-selected, call
  setState({ model: { selected: id } }) and offer a primary "Use this one" button that calls poietica.send(...).
- Parameter tweaker: poietica.tweak for the parameters, the view itself is the live preview.
- Charts: the bundled Chart.js or D3, colors from the CSS variables, axis labels in the user's language, a short legend.
- Icons: the bundled lucide (lucide.createIcons() after inserting <i data-lucide="name"></i>), or inline SVG.
- Diagrams: inline SVG with currentColor and the CSS variables; add controls (iu-tabs, buttons) to switch views.

The view appears as soon as intelligent_ui returns: do not repeat its content in your reply.
`
