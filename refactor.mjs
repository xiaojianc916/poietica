#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

const root = process.cwd()
const snapshots = new Map()
let changed = 0

function countOccurrences(source, needle) {
  let count = 0
  let cursor = source.indexOf(needle)

  while (cursor !== -1) {
    count += 1
    cursor = source.indexOf(needle, cursor + needle.length)
  }

  return count
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

async function atomicWrite(path, content) {
  const target = resolve(root, path)
  const temporary = resolve(dirname(target), `.${randomUUID()}.tmp`)

  await writeFile(temporary, content)
  await rename(temporary, target)
}

async function replaceOnce({ after, before, label, marker = after, path }) {
  await remember(path)
  const source = await readFile(resolve(root, path), 'utf8')

  if (source.includes(marker)) {
    console.log(`skip ${label}`)
    return
  }

  const count = countOccurrences(source, before)
  if (count !== 1) {
    throw new Error(`${label}: expected one source anchor in ${path}, found ${count}`)
  }

  await atomicWrite(path, source.replace(before, after))
  changed += 1
  console.log(`apply ${label}`)
}

async function createOnce(path, label, content) {
  await remember(path)

  try {
    const source = await readFile(resolve(root, path), 'utf8')
    if (source === content) {
      console.log(`skip ${label}`)
      return
    }

    throw new Error(`${label}: ${path} already exists with different content`)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }

  await atomicWrite(path, content)
  changed += 1
  console.log(`apply ${label}`)
}

async function run(command, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
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

      reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? String(code)})`))
    })
  })
}

async function rollback() {
  for (const [path, bytes] of [...snapshots].reverse()) {
    if (bytes === null) {
      await rm(resolve(root, path), { force: true })
    } else {
      await atomicWrite(path, bytes)
    }
  }
}

async function main() {
  const manifest = await readFile(resolve(root, 'package.json'), 'utf8')
  if (!manifest.includes('"name": "poietica"')) {
    throw new Error('run refactor.mjs from the poietica repository root')
  }

  await replaceOnce({
    path: 'packages/agent-ui/src/composer/prompt-chip.tsx',
    label: 'remove interactive chip chrome imports',
    marker: "import { SkillIcon } from '../primitives/icons'",
    before: `import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getNodeByKey, DecoratorNode, type NodeKey, type SerializedLexicalNode } from 'lexical'
import type { ReactNode } from 'react'
import { CloseIcon, SkillIcon, ToolIcon } from '../primitives/icons'`,
    after: `import { DecoratorNode, type NodeKey, type SerializedLexicalNode } from 'lexical'
import type { ReactNode } from 'react'
import { SkillIcon } from '../primitives/icons'`,
  })

  await replaceOnce({
    path: 'packages/agent-ui/src/composer/prompt-chip.tsx',
    label: 'render flat prompt chips',
    marker: 'function PromptChipView({ value }: { readonly value: PromptChipValue })',
    before: `  override decorate(): ReactNode {
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
    after: `  override decorate(): ReactNode {
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
  })

  await replaceOnce({
    path: 'packages/agent-ui/src/composer/prompt-chip.css',
    label: 'flatten prompt chip styling',
    marker: '  color: #2563eb;',
    before: `.assistant-prompt-chip {
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
    after: `.assistant-prompt-chip {
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
  })

  await replaceOnce({
    path: 'packages/agent-ui/src/composer/composer-actions.tsx',
    label: 'remove the session-only skill shape',
    marker: `import type {
  AgentMcpServer,
  PromptConfiguration,
  SessionConfigControl,
} from '@poietica/agent-contract'`,
    before: `import type {
  AgentMcpServer,
  AgentSkill,
  PromptConfiguration,
  SessionConfigControl,
} from '@poietica/agent-contract'`,
    after: `import type {
  AgentMcpServer,
  PromptConfiguration,
  SessionConfigControl,
} from '@poietica/agent-contract'`,
  })

  await replaceOnce({
    path: 'packages/agent-ui/src/composer/composer-actions.tsx',
    label: 'declare the composer skill projection',
    marker: 'export interface ComposerSkill',
    before: `export interface ComposerPaletteSource {
  readonly controls: readonly SessionConfigControl[]`,
    after: `/** 输入面板只需要技能的调用名、显示名与说明，不接触它来自哪条协议。 */
export interface ComposerSkill {
  readonly name: string
  readonly label?: string | undefined
  readonly description: string
}

export interface ComposerPaletteSource {
  readonly controls: readonly SessionConfigControl[]`,
  })

  await replaceOnce({
    path: 'packages/agent-ui/src/composer/composer-actions.tsx',
    label: 'use the composer skill projection',
    marker: '  readonly skills: readonly ComposerSkill[]',
    before: '  readonly skills: readonly AgentSkill[]',
    after: '  readonly skills: readonly ComposerSkill[]',
  })

  await replaceOnce({
    path: 'packages/agent-ui/src/composer/composer-actions.tsx',
    label: 'separate skill display and invocation names',
    marker: '          skill.label ?? skill.name,',
    before: `          \`skill:\${skill.name}\`,
          skill.name,
          skill.description,`,
    after: `          \`skill:\${skill.name}\`,
          skill.label ?? skill.name,
          skill.description,`,
  })

  await replaceOnce({
    path: 'packages/agent-ui/src/composer/composer-actions.tsx',
    label: 'describe MCP runtime status',
    marker: 'function mcpStatus(server: AgentMcpServer)',
    before: 'export function composerPaletteGroups({',
    after: `function mcpStatus(server: AgentMcpServer): string | undefined {
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
  })

  await replaceOnce({
    path: 'packages/agent-ui/src/composer/composer-actions.tsx',
    label: 'show every MCP server without transport jargon',
    marker: "      heading: 'MCP',",
    before: `  const connected = mcpServers.filter((server) => server.status === 'connected')
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
    after: `  if (mcpServers.length > 0) {
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
  })

  await replaceOnce({
    path: 'packages/agent-ui/src/index.ts',
    label: 'export the composer skill projection',
    marker: "export type { ComposerSkill } from './composer/composer-actions'",
    before: `export { AttachmentIntakeContext, useAttachmentIntake } from './composer/attachment-intake'
export type { PromptChipValue }`,
    after: `export { AttachmentIntakeContext, useAttachmentIntake } from './composer/attachment-intake'
export type { ComposerSkill } from './composer/composer-actions'
export type { PromptChipValue }`,
  })

  await replaceOnce({
    path: 'packages/agent-ui/src/composer/assistant-composer.tsx',
    label: 'remove the session-only composer import',
    marker: `  AgentMcpServer,
  ChatStatus,`,
    before: `  AgentMcpServer,
  AgentSkill,
  ChatStatus,`,
    after: `  AgentMcpServer,
  ChatStatus,`,
  })

  await replaceOnce({
    path: 'packages/agent-ui/src/composer/assistant-composer.tsx',
    label: 'import the composer skill projection',
    marker: '  type ComposerSkill,',
    before: `  ComposerActions,
  ComposerChips,
  composerPaletteGroups,`,
    after: `  ComposerActions,
  ComposerChips,
  type ComposerSkill,
  composerPaletteGroups,`,
  })

  await replaceOnce({
    path: 'packages/agent-ui/src/composer/assistant-composer.tsx',
    label: 'accept entry or session skills',
    marker: 'readonly skills?: readonly ComposerSkill[]',
    before: 'readonly skills?: readonly AgentSkill[]',
    after: 'readonly skills?: readonly ComposerSkill[]',
  })

  await replaceOnce({
    path: 'apps/desktop/src/workbench/assistant-wiring.tsx',
    label: 'subscribe to installed skills at the composition seam',
    marker: "import { PluginsSurface, type PluginStore } from '@poietica/plugins'",
    before: `import { PluginsSurface } from '@poietica/plugins'
import type { SurfaceRenderers } from '@poietica/workspace'
import type { ReactNode } from 'react'`,
    after: `import type { ComposerSkill } from '@poietica/agent-ui'
import { PluginsSurface, type PluginStore } from '@poietica/plugins'
import type { SurfaceRenderers } from '@poietica/workspace'
import { type ReactNode, useCallback, useMemo, useSyncExternalStore } from 'react'`,
  })

  await replaceOnce({
    path: 'apps/desktop/src/workbench/assistant-wiring.tsx',
    label: 'project installed skills once',
    marker: 'function useInstalledSkills(store: PluginStore)',
    before: 'export function createAssistantWiring({',
    after: `function useInstalledSkills(store: PluginStore): readonly ComposerSkill[] {
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
  })

  await replaceOnce({
    path: 'apps/desktop/src/workbench/assistant-wiring.tsx',
    label: 'wire installed skills into the entry surface',
    marker: '<AssistantEntry',
    before: '      ai: () => <AssistantPane onConversationStarted={onConversationStarted} session={session} />,',
    after: `      ai: () => (
        <AssistantEntry
          onConversationStarted={onConversationStarted}
          session={session}
          store={pluginStore}
        />
      ),`,
  })

  await replaceOnce({
    path: 'apps/desktop/src/workbench/assistant-wiring.tsx',
    label: 'wire installed skills into conversation surfaces',
    marker: '<AssistantConversation',
    before: `      <ConversationSurface
        onForked={onConversationForked}
        onStarted={onConversationStarted}
        session={session}
        threadId={threadId}
      />`,
    after: `      <AssistantConversation
        onConversationForked={onConversationForked}
        onConversationStarted={onConversationStarted}
        session={session}
        store={pluginStore}
        threadId={threadId}
      />`,
  })

  await replaceOnce({
    path: 'apps/desktop/src/workbench/assistant-pane.tsx',
    label: 'type entry skills',
    marker: 'type { ComposerSkill, WorkspacePickerProps }',
    before: "import type { WorkspacePickerProps } from '@poietica/agent-ui'",
    after: "import type { ComposerSkill, WorkspacePickerProps } from '@poietica/agent-ui'",
  })

  await replaceOnce({
    path: 'apps/desktop/src/workbench/assistant-pane.tsx',
    label: 'accept entry skills',
    marker: 'readonly entrySkills: readonly ComposerSkill[]',
    before: `export interface AssistantPaneProps {
  readonly onConversationStarted:`,
    after: `export interface AssistantPaneProps {
  readonly entrySkills: readonly ComposerSkill[]
  readonly onConversationStarted:`,
  })

  await replaceOnce({
    path: 'apps/desktop/src/workbench/assistant-pane.tsx',
    label: 'read entry skills',
    marker: 'export function AssistantPane({ entrySkills,',
    before: 'export function AssistantPane({ onConversationStarted, session }: AssistantPaneProps)',
    after: 'export function AssistantPane({ entrySkills, onConversationStarted, session }: AssistantPaneProps)',
  })

  await replaceOnce({
    path: 'apps/desktop/src/workbench/assistant-pane.tsx',
    label: 'send entry skills to the conversation surface',
    marker: '      entrySkills={entrySkills}',
    before: `    <ConversationSurface
      git={git}`,
    after: `    <ConversationSurface
      entrySkills={entrySkills}
      git={git}`,
  })

  await replaceOnce({
    path: 'apps/desktop/src/workbench/conversation-surface.tsx',
    label: 'type conversation entry skills',
    marker: '  type ComposerSkill,',
    before: `  AssistantSurface,
  type GitBranchPickerProps,`,
    after: `  AssistantSurface,
  type ComposerSkill,
  type GitBranchPickerProps,`,
  })

  await replaceOnce({
    path: 'apps/desktop/src/workbench/conversation-surface.tsx',
    label: 'accept conversation entry skills',
    marker: 'readonly entrySkills: readonly ComposerSkill[]',
    before: `export interface ConversationSurfaceProps {
  /** 取得这一格`,
    after: `export interface ConversationSurfaceProps {
  readonly entrySkills: readonly ComposerSkill[]
  /** 取得这一格`,
  })

  await replaceOnce({
    path: 'apps/desktop/src/workbench/conversation-surface.tsx',
    label: 'read conversation entry skills',
    marker: `export function ConversationSurface({
  entrySkills,`,
    before: `export function ConversationSurface({
  git,`,
    after: `export function ConversationSurface({
  entrySkills,
  git,`,
  })

  await replaceOnce({
    path: 'apps/desktop/src/workbench/conversation-surface.tsx',
    label: 'repair control callback dependencies',
    marker: '[controls, onIdentify, selectControl, sessionControls, threadId]',
    before: '[selectControl, sessionControls, threadId]',
    after: '[controls, onIdentify, selectControl, sessionControls, threadId]',
  })

  await replaceOnce({
    path: 'apps/desktop/src/workbench/conversation-surface.tsx',
    label: 'send entry skills to the assistant surface',
    marker: `      endpoint={threadId}
      entrySkills={entrySkills}`,
    before: `      endpoint={threadId}
      git={git}`,
    after: `      endpoint={threadId}
      entrySkills={entrySkills}
      git={git}`,
  })

  await replaceOnce({
    path: 'packages/agent-ui/src/surface/assistant-surface.tsx',
    label: 'type assistant entry skills',
    marker: "import type { ComposerSkill } from '../composer/composer-actions'",
    before: `import { AssistantComposer } from '../composer/assistant-composer'
import { useDockClearance }`,
    after: `import { AssistantComposer } from '../composer/assistant-composer'
import type { ComposerSkill } from '../composer/composer-actions'
import { useDockClearance }`,
  })

  await replaceOnce({
    path: 'packages/agent-ui/src/surface/assistant-surface.tsx',
    label: 'remove unused swarm subscription',
    marker: `  useAssistantQuestion,
  useAssistantSession,
} from '../session/use-assistant-session'`,
    before: `  useAssistantQuestion,
  useAssistantSession,
  useAssistantSwarm,
} from '../session/use-assistant-session'`,
    after: `  useAssistantQuestion,
  useAssistantSession,
} from '../session/use-assistant-session'`,
  })

  await replaceOnce({
    path: 'packages/agent-ui/src/surface/assistant-surface.tsx',
    label: 'accept assistant entry skills',
    marker: 'readonly entrySkills: readonly ComposerSkill[]',
    before: `export interface AssistantSurfaceProps {
  /** 这一格代表的对话。`,
    after: `export interface AssistantSurfaceProps {
  readonly entrySkills: readonly ComposerSkill[]
  /** 这一格代表的对话。`,
  })

  await replaceOnce({
    path: 'packages/agent-ui/src/surface/assistant-surface.tsx',
    label: 'read assistant entry skills',
    marker: `  endpoint,
  entrySkills,`,
    before: `  endpoint,
  git,`,
    after: `  endpoint,
  entrySkills,
  git,`,
  })

  await replaceOnce({
    path: 'packages/agent-ui/src/surface/assistant-surface.tsx',
    label: 'select the authoritative skill scope',
    marker: '  const threadSkills = useThreadSkills(endpoint)',
    before: `  const skills = useThreadSkills(endpoint)
  const mcpServers = useMcpServers()`,
    after: `  const threadSkills = useThreadSkills(endpoint)
  const skills = endpoint === null ? entrySkills : threadSkills
  const mcpServers = useMcpServers()`,
  })

  await replaceOnce({
    path: 'packages/agent-ui/src/surface/assistant-surface.tsx',
    label: 'remove the stale swarm read',
    marker: `  const question = useAssistantQuestion(assistant.key)

  const approval = useMemo`,
    before: `  /* 这一段的处境：目标与在跑的子代理数，都从帧日志派生（kap 的 goal_start 与 agent_call / task）。 */
  const swarm = useAssistantSwarm(assistant.key)

`,
    after: '',
  })

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

  await createOnce(
    'packages/agent-ui/src/__tests__/composer-palette.test.tsx',
    'add composer capability regression coverage',
    test,
  )

  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  await run(pnpm, ['check'])
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
