/* Managed by root refactor.mjs. */

import automationIcon from '../assets/integration-icons/automation.svg'
import chromeDevToolsIcon from '../assets/integration-icons/chrome-devtools.svg'
import context7Icon from '../assets/integration-icons/context7.svg'
import deepWikiIcon from '../assets/integration-icons/deepwiki.svg'
import docxIcon from '../assets/integration-icons/docx.svg'
import filesystemIcon from '../assets/integration-icons/filesystem.svg'
import githubIcon from '../assets/integration-icons/github.svg'
import mcpIcon from '../assets/integration-icons/mcp.svg'
import memoryIcon from '../assets/integration-icons/memory.svg'
import pdfIcon from '../assets/integration-icons/pdf.svg'
import playwrightIcon from '../assets/integration-icons/playwright.svg'
import pptxIcon from '../assets/integration-icons/pptx.svg'
import sequentialThinkingIcon from '../assets/integration-icons/sequential-thinking.svg'
import skillCreatorIcon from '../assets/integration-icons/skill-creator.svg'
import xlsxIcon from '../assets/integration-icons/xlsx.svg'

/*
 * 图标是界面投影，不进入插件清单、安装账本或 MCP 配置。
 *
 * 上游 marketplace 与 agent 命令表都没有统一的 icon 字段；把这张映射留在 surface，
 * 可以在不制造第二份领域事实的前提下，为已知能力提供稳定的本地图形。未知条目交回
 * PluginGlyph 的首字母兜底。
 */

export interface PluginIconAsset {
  readonly src: string
  readonly background: string
}

const ICONS = {
  automation: {
    src: automationIcon,
    background: '#FFF0E8',
  },
  chromeDevTools: {
    src: chromeDevToolsIcon,
    background: '#E8F1FE',
  },
  context7: {
    src: context7Icon,
    background: '#F1F1F1',
  },
  deepWiki: {
    src: deepWikiIcon,
    background: '#F1ECFF',
  },
  docx: {
    src: docxIcon,
    background: '#EAF2FF',
  },
  filesystem: {
    src: filesystemIcon,
    background: '#FFF4DD',
  },
  github: {
    src: githubIcon,
    background: '#EEF0F2',
  },
  mcp: {
    src: mcpIcon,
    background: '#F1F2F4',
  },
  memory: {
    src: memoryIcon,
    background: '#F1ECFF',
  },
  pdf: {
    src: pdfIcon,
    background: '#FDEBEC',
  },
  playwright: {
    src: playwrightIcon,
    background: '#ECF8EE',
  },
  pptx: {
    src: pptxIcon,
    background: '#FFF0E8',
  },
  sequentialThinking: {
    src: sequentialThinkingIcon,
    background: '#E7F3FF',
  },
  skillCreator: {
    src: skillCreatorIcon,
    background: '#FFF4DD',
  },
  xlsx: {
    src: xlsxIcon,
    background: '#EAF7EE',
  },
} as const satisfies Record<string, PluginIconAsset>

type PluginIconKey = keyof typeof ICONS

interface AliasRule {
  readonly icon: PluginIconKey
  readonly names: readonly string[]
}

/*
 * 规则按具体程度排列：mcp-builder 必须先于通用 mcp，Chrome DevTools 与
 * Playwright 必须先于 automation。这样名字里同时出现多个能力词时，仍能得到
 * 最具体的品牌或功能图形。
 */
const ALIASES = [
  {
    icon: 'context7',
    names: ['context7'],
  },
  {
    icon: 'deepWiki',
    names: ['deepwiki', 'deep-wiki'],
  },
  {
    icon: 'chromeDevTools',
    names: ['chrome-devtools', 'chrome-devtools-mcp'],
  },
  {
    icon: 'playwright',
    names: ['playwright', 'playwright-mcp'],
  },
  {
    icon: 'github',
    names: ['github', 'github-mcp'],
  },
  {
    icon: 'sequentialThinking',
    names: ['sequential-thinking', 'sequentialthinking'],
  },
  {
    icon: 'filesystem',
    names: ['filesystem', 'file-system'],
  },
  {
    icon: 'memory',
    names: ['memory', 'server-memory'],
  },
  {
    icon: 'docx',
    names: ['docx', 'word-document', 'microsoft-word'],
  },
  {
    icon: 'pdf',
    names: ['pdf'],
  },
  {
    icon: 'pptx',
    names: ['pptx', 'powerpoint'],
  },
  {
    icon: 'xlsx',
    names: ['xlsx', 'excel', 'spreadsheet'],
  },
  {
    icon: 'skillCreator',
    names: ['skill-creator', 'skill-builder'],
  },
  {
    icon: 'mcp',
    names: ['mcp-builder'],
  },
  {
    icon: 'automation',
    names: ['poietica-automations', 'poietica-automation', 'automations', 'automation', 'workflow'],
  },
  {
    icon: 'mcp',
    names: ['model-context-protocol', 'mcp'],
  },
] as const satisfies readonly AliasRule[]

function normalise(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
}

function containsAlias(value: string, alias: string): boolean {
  return (
    value === alias ||
    value.startsWith(alias + '-') ||
    value.endsWith('-' + alias) ||
    value.includes('-' + alias + '-')
  )
}

export function pluginIconFor(id: string, displayName: string): PluginIconAsset | undefined {
  const candidates = [normalise(id), normalise(displayName)].filter((candidate) => candidate !== '')

  for (const rule of ALIASES) {
    if (
      candidates.some((candidate) => rule.names.some((alias) => containsAlias(candidate, alias)))
    ) {
      return ICONS[rule.icon]
    }
  }

  return undefined
}
