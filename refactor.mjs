#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

const root = process.cwd()
const snapshots = new Map()
let changed = 0

function count(source, needle) {
  let matches = 0
  let cursor = source.indexOf(needle)

  while (cursor !== -1) {
    matches += 1
    cursor = source.indexOf(needle, cursor + needle.length)
  }

  return matches
}

async function remember(path) {
  if (snapshots.has(path)) {
    return
  }

  try {
    snapshots.set(path, await readFile(resolve(root, path)))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
    snapshots.set(path, null)
  }
}

async function write(path, content) {
  const target = resolve(root, path)
  const temporary = resolve(dirname(target), `.${randomUUID()}.tmp`)
  await writeFile(temporary, content)
  await rename(temporary, target)
}

async function replace(path, marker, before, after) {
  await remember(path)
  const source = await readFile(resolve(root, path), 'utf8')

  if (source.includes(marker)) {
    console.log(`skip ${path}: ${marker.split('\n')[0]}`)
    return
  }

  const matches = count(source, before)
  if (matches !== 1) {
    throw new Error(`${path}: expected one anchor, found ${matches}`)
  }

  await write(path, source.replace(before, after))
  changed += 1
  console.log(`apply ${path}: ${marker.split('\n')[0]}`)
}

async function create(path, content) {
  await remember(path)

  try {
    const current = await readFile(resolve(root, path), 'utf8')
    if (current === content) {
      console.log(`skip ${path}`)
      return
    }
    throw new Error(`${path}: existing file differs from the migration payload`)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }

  await write(path, content)
  changed += 1
  console.log(`create ${path}`)
}

async function command(program, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`${program} ${args.join(' ')} failed (${signal ?? String(code)})`))
    })
  })
}

async function rollback() {
  for (const [path, content] of [...snapshots].reverse()) {
    if (content === null) {
      await rm(resolve(root, path), { force: true })
    } else {
      await write(path, content)
    }
  }
}

async function main() {
  const manifest = await readFile(resolve(root, 'package.json'), 'utf8')
  if (!manifest.includes('"name": "poietica"')) {
    throw new Error('run refactor.mjs from the poietica repository root')
  }

  const chip = 'packages/agent-ui/src/composer/prompt-chip.tsx'
  await replace(
    chip,
    "import { SkillIcon } from '../primitives/icons'",
    `import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getNodeByKey, DecoratorNode, type NodeKey, type SerializedLexicalNode } from 'lexical'
import type { ReactNode } from 'react'
import { CloseIcon, SkillIcon, ToolIcon } from '../primitives/icons'`,
    `import { DecoratorNode, type NodeKey, type SerializedLexicalNode } from 'lexical'
import type { ReactNode } from 'react'
import { SkillIcon } from '../primitives/icons'`,
  )
  await replace(
    chip,
    'function PromptChipView({ value }: { readonly value: PromptChipValue })',
    `  override decorate(): ReactNode {
    return <PromptChipView nodeKey={this.getKey()} value={this.#value} />
  }
}

function PromptChipView({
  nodeKey,
  value,
}: {
  readonly nodeKey: NodeKey
  readonly value: PromptChipValue
}) {
  const [editor] = useLexicalComposerContext()
  const Icon = value.kind === 'skill' ? SkillIcon : ToolIcon
  const label = value.kind === 'skill' ? value.name : \`@\${value.name}\`

  return (
    <span className="assistant-prompt-chip__body" contentEditable={false}>
      <Icon aria-hidden="true" />
      <span>{label}</span>
      <button
        aria-label={\`移除 \${label}\`}
        className="assistant-prompt-chip__remove"
        onMouseDown={(event) => {
          event.preventDefault()
          editor.update(() => {
            const node = $getNodeByKey(nodeKey)
            if (node instanceof ChipNode) {
              node.remove()
            }
          })
        }}
        type="button"
      >
        <CloseIcon aria-hidden="true" />
      </button>
    </span>
  )
}`,
    `  override decorate(): ReactNode {
    return <PromptChipView value={this.#value} />
  }
}

function PromptChipView({ value }: { readonly value: PromptChipValue }) {
  const label = value.kind === 'skill' ? value.name : \`@\${value.name}\`

  return (
    <span className="assistant-prompt-chip__body" contentEditable={false}>
      {value.kind === 'skill' ? <SkillIcon aria-hidden="true" /> : null}
      <span>{label}</span>
    </span>
  )
}`,
  )

  await replace(
    'packages/agent-ui/src/composer/prompt-chip.css',
    '  color: #2563eb;',
    `.assistant-prompt-chip {
  display: inline-flex;
  vertical-align: middle;
}

.assistant-prompt-chip__body {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 9999px;
  padding: 1px 3px 1px 6px;
  background: color-mix(in oklab, var(--assistant-chip-accent, #2563eb) 14%, transparent);
  color: var(--assistant-chip-accent, #2563eb);
  white-space: nowrap;
}

.assistant-prompt-chip__body > svg,
.assistant-prompt-chip__remove > svg {
  block-size: 12px;
  inline-size: 12px;
}

.assistant-prompt-chip__remove {
  display: inline-grid;
  place-items: center;
  border: 0;
  border-radius: 9999px;
  padding: 2px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.assistant-prompt-chip__remove:hover {
  background: color-mix(in oklab, currentColor 14%, transparent);
}
`,
    `.assistant-prompt-chip {
  display: inline-flex;
  vertical-align: baseline;
}

.assistant-prompt-chip__body {
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  gap: 0.25em;
  padding: 0;
  font: inherit;
  line-height: inherit;
  color: #2563eb;
  white-space: nowrap;
  background: transparent;
  border: 0;
}

.assistant-prompt-chip__body > svg {
  block-size: 1em;
  inline-size: 1em;
}
`,
  )

  const actions = 'packages/agent-ui/src/composer/composer-actions.tsx'
  await replace(
    actions,
    `import type {
  AgentMcpServer,
  PromptConfiguration,
  SessionConfigControl,`,
    `import type {
  AgentMcpServer,
  AgentSkill,
  PromptConfiguration,
  SessionConfigControl,`,
    `import type {
  AgentMcpServer,
  PromptConfiguration,
  SessionConfigControl,`,
  )
  await replace(
    actions,
    'export interface ComposerSkill',
    `export interface ComposerPaletteSource {
  readonly controls: readonly SessionConfigControl[]`,
    `/** 输入面板只需要技能的调用名、显示名与说明，不接触它来自哪条协议。 */
export interface ComposerSkill {
  readonly name: string
  readonly label?: string | undefined
  readonly description: string
}

export interface ComposerPaletteSource {
  readonly controls: readonly SessionConfigControl[]`,
  )
  await replace(
    actions,
    '  readonly skills: readonly ComposerSkill[]',
    '  readonly skills: readonly AgentSkill[]',
    '  readonly skills: readonly ComposerSkill[]',
  )
  await replace(
    actions,
    '          skill.label ?? skill.name,',
    `          \`skill:\${skill.name}\`,
          skill.name,
          skill.description,`,
    `          \`skill:\${skill.name}\`,
          skill.label ?? skill.name,
          skill.description,`,
  )
  await replace(
    actions,
    'function mcpStatus(server: AgentMcpServer)',
    'export function composerPaletteGroups({',
    `function mcpStatus(server: AgentMcpServer): string | undefined {
  switch (server.status) {
    case 'connected':
      return undefined
    case 'connecting':
      return '连接中'
    case 'disconnected':
      return '未连接'
    case 'error':
      return '连接失败'
  }
}

export function composerPaletteGroups({`,
  )
  await replace(
    actions,
    "      heading: 'MCP',",
    `  const connected = mcpServers.filter((server) => server.status === 'connected')
  if (connected.length > 0) {
    groups.push({
      id: 'mcp',
      heading: '检测到可用的 MCP',
      rows: connected.map((server) =>
        insertRow(
          \`mcp:\${server.id}\`,
          server.name,
          \`\${server.transport} \${String(server.toolCount)} 个工具\`,
          <ToolIcon aria-hidden="true" />,
          { kind: 'mcp', id: server.id, name: server.name },
        ),
      ),
    })
  }`,
    `  if (mcpServers.length > 0) {
    groups.push({
      id: 'mcp',
      heading: 'MCP',
      rows: mcpServers.map((server) =>
        insertRow(
          \`mcp:\${server.id}\`,
          server.name,
          mcpStatus(server),
          <ToolIcon aria-hidden="true" />,
          { kind: 'mcp', id: server.id, name: server.name },
        ),
      ),
    })
  }`,
  )

  await replace(
    'packages/agent-ui/src/index.ts',
    "export type { ComposerSkill } from './composer/composer-actions'",
    `export { AttachmentIntakeContext, useAttachmentIntake } from './composer/attachment-intake'
export type { PromptChipValue }`,
    `export { AttachmentIntakeContext, useAttachmentIntake } from './composer/attachment-intake'
export type { ComposerSkill } from './composer/composer-actions'
export type { PromptChipValue }`,
  )

  const composer = 'packages/agent-ui/src/composer/assistant-composer.tsx'
  await replace(
    composer,
    `  AgentMcpServer,
  ChatStatus,`,
    `  AgentMcpServer,
  AgentSkill,
  ChatStatus,`,
    `  AgentMcpServer,
  ChatStatus,`,
  )
  await replace(
    composer,
    '  type ComposerSkill,',
    `  ComposerActions,
  ComposerChips,
  composerPaletteGroups,`,
    `  ComposerActions,
  ComposerChips,
  type ComposerSkill,
  composerPaletteGroups,`,
  )
  await replace(
    composer,
    'readonly skills?: readonly ComposerSkill[]',
    'readonly skills?: readonly AgentSkill[]',
    'readonly skills?: readonly ComposerSkill[]',
  )

  const wiring = 'apps/desktop/src/workbench/assistant-wiring.tsx'
  await replace(
    wiring,
    "import { PluginsSurface, type PluginStore } from '@poietica/plugins'",
    `import { PluginsSurface } from '@poietica/plugins'
import type { SurfaceRenderers } from '@poietica/workspace'
import type { ReactNode } from 'react'`,
    `import type { ComposerSkill } from '@poietica/agent-ui'
import { PluginsSurface, type PluginStore } from '@poietica/plugins'
import type { SurfaceRenderers } from '@poietica/workspace'
import { type ReactNode, useCallback, useMemo, useSyncExternalStore } from 'react'`,
  )
  await replace(
    wiring,
    'function useInstalledSkills(store: PluginStore)',
    'export function createAssistantWiring({',
    `function useInstalledSkills(store: PluginStore): readonly ComposerSkill[] {
  const read = useCallback(() => store.getSnapshot().skills, [store])
  const installed = useSyncExternalStore(store.subscribe, read, read)

  return useMemo(
    () =>
      installed.map((skill) => ({
        name: skill.dirName,
        ...(skill.manifest.name === skill.dirName ? {} : { label: skill.manifest.name }),
        description: skill.manifest.description ?? '',
      })),
    [installed],
  )
}

function AssistantEntry({
  onConversationStarted,
  session,
  store,
}: {
  readonly onConversationStarted: (threadId: string, title: string) => void
  readonly session: AgentSessionPort
  readonly store: PluginStore
}) {
  const skills = useInstalledSkills(store)
  return (
    <AssistantPane
      entrySkills={skills}
      onConversationStarted={onConversationStarted}
      session={session}
    />
  )
}

function AssistantConversation({
  onConversationForked,
  onConversationStarted,
  session,
  store,
  threadId,
}: {
  readonly onConversationForked: (threadId: string, title: string) => void
  readonly onConversationStarted: (threadId: string, title: string) => void
  readonly session: AgentSessionPort
  readonly store: PluginStore
  readonly threadId: string
}) {
  const skills = useInstalledSkills(store)
  return (
    <ConversationSurface
      entrySkills={skills}
      onForked={onConversationForked}
      onStarted={onConversationStarted}
      session={session}
      threadId={threadId}
    />
  )
}

export function createAssistantWiring({`,
  )
  await replace(
    wiring,
    '<AssistantEntry',
    '      ai: () => <AssistantPane onConversationStarted={onConversationStarted} session={session} />,',
    `      ai: () => (
        <AssistantEntry
          onConversationStarted={onConversationStarted}
          session={session}
          store={pluginStore}
        />
      ),`,
  )
  await replace(
    wiring,
    '<AssistantConversation',
    `      <ConversationSurface
        onForked={onConversationForked}
        onStarted={onConversationStarted}
        session={session}
        threadId={threadId}
      />`,
    `      <AssistantConversation
        onConversationForked={onConversationForked}
        onConversationStarted={onConversationStarted}
        session={session}
        store={pluginStore}
        threadId={threadId}
      />`,
  )

  const pane = 'apps/desktop/src/workbench/assistant-pane.tsx'
  await replace(
    pane,
    'type { ComposerSkill, WorkspacePickerProps }',
    "import type { WorkspacePickerProps } from '@poietica/agent-ui'",
    "import type { ComposerSkill, WorkspacePickerProps } from '@poietica/agent-ui'",
  )
  await replace(
    pane,
    'readonly entrySkills: readonly ComposerSkill[]',
    `export interface AssistantPaneProps {
  readonly onConversationStarted:`,
    `export interface AssistantPaneProps {
  readonly entrySkills: readonly ComposerSkill[]
  readonly onConversationStarted:`,
  )
  await replace(
    pane,
    'export function AssistantPane({ entrySkills,',
    'export function AssistantPane({ onConversationStarted, session }: AssistantPaneProps)',
    'export function AssistantPane({ entrySkills, onConversationStarted, session }: AssistantPaneProps)',
  )
  await replace(
    pane,
    '      entrySkills={entrySkills}',
    `    <ConversationSurface
      git={git}`,
    `    <ConversationSurface
      entrySkills={entrySkills}
      git={git}`,
  )

  const conversation = 'apps/desktop/src/workbench/conversation-surface.tsx'
  await replace(
    conversation,
    '  type ComposerSkill,',
    `  AssistantSurface,
  type GitBranchPickerProps,`,
    `  AssistantSurface,
  type ComposerSkill,
  type GitBranchPickerProps,`,
  )
  await replace(
    conversation,
    'readonly entrySkills: readonly ComposerSkill[]',
    `export interface ConversationSurfaceProps {
  /** 取得这一格`,
    `export interface ConversationSurfaceProps {
  readonly entrySkills: readonly ComposerSkill[]
  /** 取得这一格`,
  )
  await replace(
    conversation,
    `export function ConversationSurface({
  entrySkills,`,
    `export function ConversationSurface({
  git,`,
    `export function ConversationSurface({
  entrySkills,
  git,`,
  )
  await replace(
    conversation,
    '[controls, onIdentify, selectControl, sessionControls, threadId]',
    '[selectControl, sessionControls, threadId]',
    '[controls, onIdentify, selectControl, sessionControls, threadId]',
  )
  await replace(
    conversation,
    `      endpoint={threadId}
      entrySkills={entrySkills}`,
    `      endpoint={threadId}
      git={git}`,
    `      endpoint={threadId}
      entrySkills={entrySkills}
      git={git}`,
  )

  const surface = 'packages/agent-ui/src/surface/assistant-surface.tsx'
  await replace(
    surface,
    "import type { ComposerSkill } from '../composer/composer-actions'",
    `import { AssistantComposer } from '../composer/assistant-composer'
import { useDockClearance }`,
    `import { AssistantComposer } from '../composer/assistant-composer'
import type { ComposerSkill } from '../composer/composer-actions'
import { useDockClearance }`,
  )
  await replace(
    surface,
    `  useAssistantQuestion,
  useAssistantSession,
} from '../session/use-assistant-session'`,
    `  useAssistantQuestion,
  useAssistantSession,
  useAssistantSwarm,
} from '../session/use-assistant-session'`,
    `  useAssistantQuestion,
  useAssistantSession,
} from '../session/use-assistant-session'`,
  )
  await replace(
    surface,
    'readonly entrySkills: readonly ComposerSkill[]',
    `export interface AssistantSurfaceProps {
  /** 这一格代表的对话。`,
    `export interface AssistantSurfaceProps {
  readonly entrySkills: readonly ComposerSkill[]
  /** 这一格代表的对话。`,
  )
  await replace(
    surface,
    `  endpoint,
  entrySkills,`,
    `  endpoint,
  git,`,
    `  endpoint,
  entrySkills,
  git,`,
  )
  await replace(
    surface,
    '  const threadSkills = useThreadSkills(endpoint)',
    `  const skills = useThreadSkills(endpoint)
  const mcpServers = useMcpServers()`,
    `  const threadSkills = useThreadSkills(endpoint)
  const skills = endpoint === null ? entrySkills : threadSkills
  const mcpServers = useMcpServers()`,
  )
  await replace(
    surface,
    `  const question = useAssistantQuestion(assistant.key)

  const approval = useMemo`,
    `  const question = useAssistantQuestion(assistant.key)

  /* 这一段的处境：目标与在跑的子代理数，都从帧日志派生（kap 的 goal_start 与 agent_call / task）。 */
  const swarm = useAssistantSwarm(assistant.key)

  /*
   * 待答的那一次审批。
   *
   * 交出去的是那一格自己的整副入参，不是三个各走各的 prop：这一层不摆它，只是
   * 把它交给持有那张卡的人。引用只随「换了一个请求」或「分母变了」而变，所以流式
   * 追加动不了被 memo 过的 composer。
   */
  const approval = useMemo`,
    `  const question = useAssistantQuestion(assistant.key)

  const approval = useMemo`,
  )

  const test = `import type { AgentMcpServer } from '@poietica/agent-contract'
import { describe, expect, it } from 'vitest'
import { composerPaletteGroups } from '../composer/composer-actions'

const server = (
  id: string,
  status: AgentMcpServer['status'],
  transport: AgentMcpServer['transport'],
  toolCount: number,
): AgentMcpServer => ({ id, name: id, status, transport, toolCount })

const source = {
  controls: [],
  onSelectControl: () => undefined,
}

describe('composer capability palette', () => {
  it('lists every MCP server as one row without protocol or tool-count jargon', () => {
    const groups = composerPaletteGroups({
      ...source,
      skills: [],
      mcpServers: [
        server('connected', 'connected', 'http', 2),
        server('starting', 'connecting', 'sse', 4),
        server('offline', 'disconnected', 'stdio', 7),
        server('broken', 'error', 'http', 1),
      ],
    })
    const mcp = groups.find((group) => group.id === 'mcp')

    expect(mcp?.heading).toBe('MCP')
    expect(mcp?.rows.map(({ label, detail }) => ({ label, detail }))).toEqual([
      { label: 'connected', detail: undefined },
      { label: 'starting', detail: '连接中' },
      { label: 'offline', detail: '未连接' },
      { label: 'broken', detail: '连接失败' },
    ])
  })

  it('keeps a skill display label separate from its invocation name', () => {
    const groups = composerPaletteGroups({
      ...source,
      mcpServers: [],
      skills: [{ name: 'research', label: '深度研究', description: '调查并形成报告' }],
    })
    const [row] = groups.find((group) => group.id === 'skills')?.rows ?? []

    expect(row?.label).toBe('深度研究')
    expect(row?.action).toEqual({ kind: 'insert', chip: { kind: 'skill', name: 'research' } })
  })
})
`
  await create('packages/agent-ui/src/__tests__/composer-palette.test.tsx', test)

  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  await command(pnpm, ['check'])
  console.log(changed === 0 ? 'refactor already applied' : `refactor applied (${changed} edits)`)
}

main().catch(async (error) => {
  try {
    await rollback()
  } catch (rollbackError) {
    console.error('rollback failed', rollbackError)
  }
  console.error(error)
  process.exitCode = 1
})
