import type {
  OmpToolDetails,
  OmpToolInput,
  OmpToolInputOf,
  OmpToolName,
  OmpToolOutput,
  OmpToolOutputOf,
} from '@poietica/omp-types'
import type { Handler, OmpToolView } from './view-kit'
import { NONE, outputDetails, outputImages, outputText, registerViewLookup } from './view-kit'
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
import { astEditView, bashView, editView, fetchView, readView, writeView } from './views/files'
import {
  debugView,
  deviceView,
  githubView,
  hubView,
  idaView,
  imageGenView,
  intelligentUiGuideView,
  learnView,
  manageSkillView,
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
 *
 * 表里每个名字都是 omp 真的会报出来的那一个：内建与隐藏工具（builtin-names.ts，search 是 grep 的历史别名）、
 * 官方视图表登记的别名（apply_patch / puppeteer / js / python / notebook，老会话存着的名字要认得）、
 * eval 的 prelude（browser / computer）、omp 注册的 CustomTool（generate_image / tts / vibe_*）、
 * 以及 xd:// 设备（report_issue / resolve / reject / propose，经 write 委派到达）。
 *
 * 每一格的值是按名字对齐的 `Handler<名字>`：处理器里的入参与 details 都是那个工具的类型，字段直接读。
 */
const HANDLERS: { readonly [N in OmpToolName]?: Handler<N> } = {
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
  fetch: fetchView,
  find: findView,
  generate_image: imageGenView,
  github: githubView,
  glob: globView,
  goal: goalView,
  ida: idaView,
  grep: grepView,
  hub: hubView,
  intelligent_ui_guide: intelligentUiGuideView,
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
 * 按名字取处理器：表在编译期按名字逐格对齐（见 HANDLERS），运行时只剩名字这一条线索。
 * 载荷的类型收窄也只有这一处 —— 形状由 omp 的 tool schema 保证，界面不再逐字段猜。
 */
function handlerOf(name: string): Handler | undefined {
  return HANDLERS[name as OmpToolName] as Handler | undefined
}

/*
 * 默认用 omp 自带的 intent（由模型写，比按参数猜得准）；两类压过它 —— 与 omp 官方优先级一致：命令与脚本那一行该是命令本身。
 * 没写 intent 的老会话退回按参数算的那句。
 */
const INTENT_OVERRIDDEN: Readonly<Record<string, true>> = {
  bash: true,
  eval: true,
  js: true,
  notebook: true,
  python: true,
}

/** 这次调用最终印在折叠行上的那一句话。 */
function headlineOf(name: string, derived: string, intent: string | undefined): string {
  if (intent === undefined || intent === '') {
    return derived
  }

  return INTENT_OVERRIDDEN[name.toLowerCase()] === true && derived !== '' ? derived : intent
}

export function ompToolView(
  name: string,
  input: OmpToolInputOf | undefined,
  output: OmpToolOutputOf | null | undefined,
  error?: string,
  intent?: string,
): OmpToolView {
  const seen = output ?? undefined
  const details = outputDetails(seen)
  const handler = handlerOf(name)
  const base =
    handler === undefined
      ? name.startsWith('mcp__')
        ? mcpView(name, input, details)
        : EMPTY
      : handler({
          input: input as OmpToolInput<OmpToolName> | undefined,
          details: details as OmpToolDetails<OmpToolName> | undefined,
          output: (typeof seen === 'string' ? {} : (seen ?? {})) as OmpToolOutput<OmpToolName>,
          said: outputText(seen),
          error,
        })

  if (!base.known) {
    /* 画不出来不等于不知道是谁在跑：委派过的设备名要留给字形那一格。 */
    return base.invokedTool === '' ? EMPTY : { ...EMPTY, invokedTool: base.invokedTool }
  }

  const shots = outputImages(seen)
  // background 由产出自己说（details.async），与处理器无关，在这里统一补。
  const background = details?.async !== undefined

  return {
    ...base,
    background,
    /* 委派过的那一次由 writeView 填了被调工具的名字，这里只给没填的那些补。 */
    invokedTool: base.invokedTool === '' ? name : base.invokedTool,
    headline: headlineOf(name, base.headline, intent),
    ...(shots.length === 0 ? {} : { response: [...base.response, ...shots] }),
  }
}

// 出口登记给 view-kit：writeView 的 xd:// 委派要经它回调进来。
registerViewLookup((tool, input, output) => ompToolView(tool, input, output))
