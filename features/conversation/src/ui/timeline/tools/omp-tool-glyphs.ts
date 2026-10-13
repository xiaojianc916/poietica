import type { ToolGlyph } from '../../agent/tool-call'

/*
 * 折叠行上那一枚字形认谁：**只认名字**（帧的 name）—— checkpoint 与 read 都碰文件，但一件事是回退、一件事是看，只有名字分得开。
 * 认不出的名字（MCP、扩展注册的工具、比我们新的 omp 长出来的工具）一律是 unplug：它们都从外面来。
 * 表里每个名字都与 omp-tool-view 的 HANDLERS 同一批来源。类别（ToolKind）不在这条路上：它管并组与兜底措辞，与画哪枚字形是两件事。
 */

const GLYPHS: Readonly<Record<string, ToolGlyph>> = {
  apply_patch: 'write',
  ask: 'question',
  ast_edit: 'write',
  ast_grep: 'search',
  bash: 'execute',
  browser: 'computer',
  checkpoint: 'github',
  computer: 'computer',
  context_notes: 'other',
  debug: 'bug',
  edit: 'write',
  eval: 'execute',
  fetch: 'read',
  find: 'search',
  generate_image: 'image',
  github: 'github',
  glob: 'search',
  goal: 'goal',
  grep: 'search',
  hub: 'delegate',
  ida: 'code',
  js: 'execute',
  learn: 'learning',
  lsp: 'code',
  manage_skill: 'skill',
  memory_edit: 'memory',
  new_context: 'other',
  notebook: 'execute',
  propose: 'device',
  puppeteer: 'computer',
  python: 'execute',
  read: 'read',
  recall: 'memory',
  reflect: 'memory',
  reject: 'device',
  report_issue: 'device',
  report_tool_issue: 'device',
  resolve: 'device',
  retain: 'memory',
  rewind: 'github',
  search: 'search',
  security_scan: 'bug',
  task: 'delegate',
  think: 'other',
  todo: 'todo',
  tts: 'speech',
  vibe_kill: 'delegate',
  vibe_list: 'delegate',
  vibe_send: 'delegate',
  vibe_spawn: 'delegate',
  vibe_wait: 'delegate',
  wait: 'clock',
  web_search: 'fetch',
  write: 'write',
  yield: 'yield',
}

/*
 * `read` 与 `write` 是**传输工具**（omp 的 XDEV_TRANSPORT_TOOLS）——它们自己不说话，说什么由地址决定：`read skill://ponytail` 与 `read src/a.ts` 是同一把 read。
 * 名单是 InternalUrlRouter 注册的那 16 个，闭集；不在这张表里的（http、盘符路径）不是内部资源。
 */
const SCHEME_GLYPHS: Readonly<Record<string, ToolGlyph>> = {
  agent: 'delegate',
  conflict: 'write',
  http: 'fetch',
  https: 'fetch',
  issue: 'github',
  mcp: 'plugin',
  memory: 'memory',
  pr: 'github',
  proc: 'execute',
  security: 'bug',
  skill: 'skill',
  xd: 'device',
}

/*
 * 它只说这次碰的是哪一类资源，没说在干什么 —— 干什么由动词说（`write local://PLAN.md` 画铅笔、`read ssh://h/a` 画书）。
 * 上面那张表相反：scheme 本身就是那件事（skill 是技能、xd 是设备），读还是写都一样。
 */
const RESOURCE_SCHEMES: ReadonlySet<string> = new Set(['artifact', 'history', 'local', 'omp', 'rule', 'ssh', 'vault'])

/* 传输工具：只有它们听地址的，别的工具名字已经说清楚了。 */
const TRANSPORT_TOOLS: ReadonlySet<string> = new Set(['read', 'write'])

/** 地址认得出（传输工具 + 内部 scheme）就听地址；否则听名字；都不认就是「从外面来的工具」。 */
export function toolGlyphOf(name: string, scheme = ''): ToolGlyph {
  const lower = name.toLowerCase()

  if (scheme === '' || !TRANSPORT_TOOLS.has(lower)) {
    return GLYPHS[lower] ?? 'plugin'
  }

  if (RESOURCE_SCHEMES.has(scheme)) {
    return GLYPHS[lower] ?? 'read'
  }

  // 表外的 scheme 退回名字，别把一次写入说成外来工具。
  return SCHEME_GLYPHS[scheme] ?? GLYPHS[lower] ?? 'plugin'
}
