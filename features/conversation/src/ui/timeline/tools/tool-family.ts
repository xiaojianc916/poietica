import type { ToolGlyph } from '../../agent/tool-call'
import type { ToolCallTimelineItem } from '../timeline-contract'
import { toolGlyphOf } from './omp-tool-glyphs'

/*
 * 一条工具调用归哪一族：并组、组头账目、折叠行那枚字形必须是同一个答案，否则就会出现「脑子图标 + 阅读文案 + 并进文件组」。
 * 所以族从字形推（字形已经同时听了名字与地址），不从 kind 推 —— kind 是 view 自报的兜底措辞，`read memory://` 也报 read。
 *
 * - 阅读 / 搜索（代码搜索，不含网络）/ 运行命令（含 eval、python、js）三种字形并成一条「过程」。
 * - 相关性强的工具同族：网页（web_search + fetch + read https://）、记忆（read memory:// + recall/retain/reflect/memory_edit）、
 *   编辑（edit/apply_patch/ast_edit + write）、子代理、浏览器与电脑、技能、GitHub、回退点、同一个 MCP 服务。
 * - 其余只与同一个工具（同一地址前缀）成组。
 */

export type ToolFacet =
  | 'read'
  | 'search'
  | 'execute'
  | 'web_search'
  | 'fetch'
  | 'memory_read'
  | 'recall'
  | 'retain'
  | 'reflect'
  | 'memory_edit'
  | 'edit'
  | 'write'
  | 'delegate'
  | 'agent_read'
  | 'browser'
  | 'computer'
  | 'skill_read'
  | 'learn'
  | 'skill'
  | 'github'
  | 'checkpoint'
  | 'lsp'
  | 'mcp'
  | 'mcp_resource'
  /* 认不出更细的说法时退回 kind 的计数句。 */
  | 'kind'

export interface ToolFamily {
  /** 相邻两条同 key 才并组；`process` 是阅读 / 搜索 / 运行命令合成的那一条。 */
  readonly key: string
  /** 组头账目里它记在哪一笔下。 */
  readonly facet: ToolFacet
}

type FamilySource = Pick<ToolCallTimelineItem, 'invokedTool' | 'kind' | 'scheme'>

export const PROCESS_FAMILY = 'process'

function family(key: string, facet: ToolFacet): ToolFamily {
  return { key, facet }
}

function ownKey(name: string, scheme: string): string {
  return scheme === '' ? `tool:${name}` : `tool:${name}@${scheme}`
}

/* mcp__<server>__<tool>：同一个服务的工具同族。 */
function mcpServerKey(name: string): string | undefined {
  if (!name.startsWith('mcp__')) {
    return undefined
  }

  const server = name.slice('mcp__'.length).split('__')[0] ?? ''

  return server === '' ? undefined : `mcp:${server}`
}

const MEMORY_FACETS: Readonly<Record<string, ToolFacet>> = {
  memory_edit: 'memory_edit',
  read: 'memory_read',
  recall: 'recall',
  reflect: 'reflect',
  retain: 'retain',
  write: 'memory_edit',
}

interface Ask {
  readonly kind: FamilySource['kind']
  readonly name: string
  readonly scheme: string
}

function pluginFamily({ name, scheme }: Ask): ToolFamily {
  const server = mcpServerKey(name)

  if (server !== undefined) {
    return family(server, 'mcp')
  }

  return scheme === 'mcp' ? family('mcp-resource', 'mcp_resource') : family(ownKey(name, scheme), 'kind')
}

function editFacet({ kind, name }: Ask): ToolFacet {
  if (kind === 'edit') {
    return 'edit'
  }

  return name === 'write' ? 'write' : 'kind'
}

function skillFacet({ name }: Ask): ToolFacet {
  if (name === 'read') {
    return 'skill_read'
  }

  return name === 'learn' ? 'learn' : 'skill'
}

/* 字形 → 族。表里没有的字形只与同一个工具成组。 */
const BY_GLYPH: Partial<Readonly<Record<ToolGlyph, (ask: Ask) => ToolFamily>>> = {
  code: ({ name, scheme }) => (name === 'lsp' ? family('lsp', 'lsp') : family(ownKey(name, scheme), 'kind')),
  computer: ({ name }) => family('computer', name === 'computer' ? 'computer' : 'browser'),
  delegate: ({ name }) => family('delegate', name === 'read' ? 'agent_read' : 'delegate'),
  execute: () => family(PROCESS_FAMILY, 'execute'),
  fetch: ({ name }) => family('web', name === 'web_search' ? 'web_search' : 'fetch'),
  github: ({ name }) =>
    name === 'checkpoint' || name === 'rewind' ? family('checkpoint', 'checkpoint') : family('github', 'github'),
  learning: (ask) => family('skill', skillFacet(ask)),
  memory: ({ name }) => family('memory', MEMORY_FACETS[name] ?? 'kind'),
  plugin: pluginFamily,
  read: () => family(PROCESS_FAMILY, 'read'),
  search: () => family(PROCESS_FAMILY, 'search'),
  skill: (ask) => family('skill', skillFacet(ask)),
  write: (ask) => family('edit', editFacet(ask)),
}

export function toolFamilyOf(item: FamilySource): ToolFamily {
  const ask: Ask = { kind: item.kind, name: item.invokedTool.toLowerCase(), scheme: item.scheme }
  const of = BY_GLYPH[toolGlyphOf(item.invokedTool, item.scheme)]

  return of === undefined ? family(ownKey(ask.name, ask.scheme), 'kind') : of(ask)
}
