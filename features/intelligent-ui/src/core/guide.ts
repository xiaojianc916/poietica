import {
  INTELLIGENT_UI_HTML_MAX,
  INTELLIGENT_UI_LIBRARY_ORIGINS,
  INTELLIGENT_UI_MODEL_STATE_MAX,
  INTELLIGENT_UI_TOKEN_NAMES,
  INTELLIGENT_UI_VIEW_STATE_MAX,
} from '../contract'

/*
 * intelligent_ui 的长篇指南：模型按需调 intelligent_ui_guide 取一次（同一对话里不必再取）。
 *
 * 为什么不放进工具描述：工具描述每一轮都进系统提示，按 token 计费；指南写得越细，不用界面的那些轮
 * 白付的钱越多。旧的 show_widget 把约 2.5 KB 塞在描述里，样式又只有元素级的那一套 —— 写短了模型
 * 做不好看，写长了每轮都贵。拆开以后描述只留「什么时候用、怎么取指南」，指南可以写到真正够用。
 *
 * 类名清单在契约里（INTELLIGENT_UI_CLASS_NAMES）：外壳的 BASE_CSS 与这份指南都照它写，两边的单测各钉一半。
 */
export const INTELLIGENT_UI_GUIDE = `# intelligent_ui guide

An intelligent_ui view is a live mini app rendered inline in your reply. Use it when seeing or touching something beats
reading about it: design variants side by side, interactive charts, explorable data, calculators, simulations,
parameter tweakers, diagrams with controls, or a small form that collects structured choices.
Do not use it for plain text, short lists or a single static table: write Markdown instead.

## Sources
- html (preferred): self-contained HTML, a full document or a fragment, up to ${INTELLIGENT_UI_HTML_MAX / 1024} KB. Scripts run.
- url: a page served by a dev server on this machine (http://localhost:<port>/... or http://127.0.0.1:<port>/...),
  to show the real running app. Start the dev server first (in the background); the tool checks that the page responds.

## Environment (html)
- Libraries load only from ${INTELLIGENT_UI_LIBRARY_ORIGINS.join(', ')} (script/link tags or ES module imports).
- Everything else on the network is blocked: fetch, XHR, WebSocket, remote images and fonts. Inline your data; use data:
  URLs or inline SVG for images.
- localStorage works but is in-memory for this view only. alert/confirm/prompt and popups do nothing.
- Width is the chat column (about 720px, may be narrower): make layouts responsive, never assume a fixed width.
- Height follows the content automatically. Do not use 100vh, height:100%, full-screen layouts or position:fixed
  overlays; the view has no viewport of its own to fill.

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

## Recipes
- Choosing between variants: render each variant in an iu-card inside an iu-grid; on click set aria-selected, call
  setState({ model: { selected: id } }) and offer a primary "Use this one" button that calls poietica.send(...).
- Parameter tweaker: iu-controls with sliders and selects; on every change update the preview and
  setState({ model: currentValues, view: currentValues }).
- Charts: Chart.js or D3 from ${INTELLIGENT_UI_LIBRARY_ORIGINS[0]}, colors from the CSS variables, axis labels in the
  user's language, a short legend.
- Diagrams: inline SVG with currentColor and the CSS variables; add controls (iu-tabs, buttons) to switch views.

The view appears as soon as intelligent_ui returns: do not repeat its content in your reply. Each call shows a new view;
it does not update an earlier one.
`
