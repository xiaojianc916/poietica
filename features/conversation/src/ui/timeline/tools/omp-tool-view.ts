import type { Handler, OmpToolView } from './view-kit'
import { bag, detailsOf, get, imagesOf, NONE, pick, registerViewLookup, textOf } from './view-kit'
import {
  askView,
  checkpointView,
  contextNotesView,
  goalView,
  newContextView,
  rewindView,
  taskView,
  thinkView,
  todoView,
  waitView,
  yieldView,
} from './views/agent'
import { browserView, computerView, evalAlias, evalView } from './views/eval'
import { astEditView, bashView, editView, readView, writeView } from './views/files'
import {
  debugView,
  deviceView,
  githubView,
  hubView,
  idaView,
  imageGenView,
  learnView,
  manageSkillView,
  mcpServerOf,
  mcpToolOf,
  mcpView,
  memoryEditView,
  recallView,
  reflectView,
  retainView,
  searchView,
  securityScanView,
  ttsView,
  vibeKillView,
  vibeListView,
  vibeSendView,
  vibeSpawnView,
  vibeWaitView,
} from './views/integrations'
import { astGrepView, findView, globView, grepView, lspView } from './views/search'

/*
 * omp 工具调用的因地制宜视图：按工具名查标准答案，认不出的交回空视图由调用方兜底。产出优先于入参（edit/read 的真实内容在产出 details 里）。
 * 小工具在 view-kit，各工具族的视图按 files / search / eval / agent / integrations 分家，这里只留注册表与出口。
 */
const HANDLERS: Readonly<Record<string, Handler>> = {
  apply_patch: editView,
  ask: askView,
  ast_edit: astEditView,
  ast_grep: astGrepView,
  bash: bashView,
  browser: browserView,
  checkpoint: checkpointView,
  computer: computerView,
  context_notes: contextNotesView,
  debug: debugView,
  edit: editView,
  eval: evalView,
  fetch: readView,
  find: findView,
  generate_image: imageGenView,
  github: githubView,
  glob: globView,
  goal: goalView,
  ida: idaView,
  grep: grepView,
  hub: hubView,
  js: evalAlias('js'),
  learn: learnView,
  lsp: lspView,
  manage_skill: manageSkillView,
  memory_edit: memoryEditView,
  new_context: newContextView,
  notebook: evalAlias('js'),
  propose: deviceView('提交提案'),
  puppeteer: browserView,
  python: evalAlias('py'),
  read: readView,
  recall: recallView,
  reflect: reflectView,
  reject: deviceView('驳回待决事项'),
  report_issue: deviceView('报告工具问题'),
  report_tool_issue: deviceView('报告工具问题'),
  resolve: deviceView('处理待决事项'),
  retain: retainView,
  rewind: rewindView,
  search: grepView,
  security_scan: securityScanView,
  task: taskView,
  think: thinkView,
  todo: todoView,
  tts: ttsView,
  vibe_kill: vibeKillView,
  vibe_list: vibeListView,
  vibe_send: vibeSendView,
  vibe_spawn: vibeSpawnView,
  vibe_wait: vibeWaitView,
  wait: waitView,
  web_search: searchView,
  write: writeView,
  yield: yieldView,
}

const EMPTY: OmpToolView = {
  known: false,
  kind: 'other',
  invokedTool: '',
  scheme: '',
  headline: '',
  subject: '',
  shape: 'tabs',
  background: false,
  request: NONE,
  response: NONE,
}

/*
 * 默认用 omp 自带的 intent（由模型写，比按参数猜得准）；两类压过它 —— 与 omp 官方优先级一致：命令与脚本那一行该是命令本身。
 * 没写 intent 的老会话退回按参数算的那句。
 */
const INTENT_OVERRIDDEN: ReadonlySet<string> = new Set(['bash', 'eval', 'js', 'python', 'notebook'])

/*
 * 首选 omp 自己盖的章（details.meta.source.type === 'internal'），它是跑完之后的事实；调用还在飞的时候没有产出，退回入参 path 上的 scheme。
 * 只看传输工具：别的工具名字已经说清楚了，不该被地址改写。
 */
function schemeOf(tool: string, input: unknown, output: unknown): string {
  const lower = tool.toLowerCase()

  if (lower !== 'read' && lower !== 'write') {
    return ''
  }

  const source = bag(get(detailsOf(output), 'meta'))?.source

  if (get(source, 'type') === 'internal') {
    return schemeFrom(pick(source, 'value'))
  }

  return schemeFrom(pick(input, 'path'))
}

/** 不是内部 URL（http、盘符路径）就是空串。 */
function schemeFrom(value: string | undefined): string {
  if (value === undefined) {
    return ''
  }

  const cut = value.indexOf('://')

  return cut <= 0 ? '' : value.slice(0, cut).toLowerCase()
}

/** 这次调用最终印在折叠行上的那一句话。 */
function headlineOf(name: string, derived: string, intent: string | undefined): string {
  if (intent === undefined || intent === '') {
    return derived
  }

  return INTENT_OVERRIDDEN.has(name.toLowerCase()) && derived !== '' ? derived : intent
}

export function ompToolView(
  name: string,
  input: unknown,
  output: unknown,
  error?: string,
  intent?: string,
): OmpToolView {
  const handler = HANDLERS[name.toLowerCase()]
  const base =
    handler === undefined
      ? name.startsWith('mcp__')
        ? mcpView(name, input, mcpServerOf(output), mcpToolOf(output))
        : EMPTY
      : handler({ details: detailsOf(output), error, input, output, said: textOf(output) })

  if (!base.known) {
    /* 画不出来不等于不知道是谁在跑：委派过的设备名要留给字形那一格。 */
    return base.invokedTool === '' ? EMPTY : { ...EMPTY, invokedTool: base.invokedTool }
  }

  const shots = imagesOf(output)
  // background 由产出自己说（details.async），与处理器无关，在这里统一补。
  const background = bag(get(detailsOf(output), 'async')) !== undefined

  return {
    ...base,
    background,
    /* 委派过的那一次由 writeView 填了被调工具的名字，这里只给没填的那些补。 */
    invokedTool: base.invokedTool === '' ? name : base.invokedTool,
    scheme: schemeOf(base.invokedTool === '' ? name : base.invokedTool, input, output),
    headline: headlineOf(name, base.headline, intent),
    ...(shots.length === 0 ? {} : { response: [...base.response, ...shots] }),
  }
}

// 出口登记给 view-kit：writeView 的 xd:// 委派要经它回调进来。
registerViewLookup((tool, input, output) => ompToolView(tool, input, output))
