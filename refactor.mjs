#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

const root = process.cwd()
const snapshots = new Map()
let changed = 0

function occurrences(source, needle) {
  let count = 0
  let cursor = 0

  while ((cursor = source.indexOf(needle, cursor)) !== -1) {
    count += 1
    cursor += needle.length
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

async function replaceOnce(path, label, before, after) {
  await remember(path)
  const source = await readFile(resolve(root, path), 'utf8')

  if (source.includes(after)) {
    console.log(`skip ${label}`)
    return
  }

  const count = occurrences(source, before)

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
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: 'inherit' })

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

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-chip.tsx',
    'remove interactive chip chrome imports',
    `import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getNodeByKey, DecoratorNode, type NodeKey, type SerializedLexicalNode } from 'lexical'
import type { ReactNode } from 'react'
import { CloseIcon, SkillIcon, ToolIcon } from '../primitives/icons'`,
    `import { DecoratorNode, type NodeKey, type SerializedLexicalNode } from 'lexical'
import type { ReactNode } from 'react'
import { SkillIcon } from '../primitives/icons'`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-chip.tsx',
    'render flat prompt chips',
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

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-chip.css',
    'flatten prompt chip styling',
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

  await replaceOnce(
    'packages/agent-ui/src/composer/composer-actions.tsx',
    'declare composer skill projection',
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

  await replaceOnce(
    'packages/agent-ui/src/composer/composer-actions.tsx',
    'use composer skill projection',
    `  readonly skills: readonly AgentSkill[]`,
    `  readonly skills: readonly ComposerSkill[]`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/composer-actions.tsx',
    'separate skill display and invocation names',
    `          \`skill:\${skill.name}\`,
          skill.name,
          skill.description,`,
    `          \`skill:\${skill.name}\`,
          skill.label ?? skill.name,
          skill.description,`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/composer-actions.tsx',
    'describe MCP runtime status',
    `export function composerPaletteGroups({`,
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

  await replaceOnce(
    'packages/agent-ui/src/composer/composer-actions.tsx',
    'show every MCP server without transport jargon',
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

  await replaceOnce(
    'packages/agent-ui/src/index.ts',
    'export composer skill projection',
    `export { AttachmentIntakeContext, useAttachmentIntake } from './composer/attachment-intake'
export type { PromptChipValue }`,
    `export { AttachmentIntakeContext, useAttachmentIntake } from './composer/attachment-intake'
export type { ComposerSkill } from './composer/composer-actions'
export type { PromptChipValue }`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    'use composer skill projection in the composer',
    `  AgentMcpServer,
  AgentSkill,
  ChatStatus,`,
    `  AgentMcpServer,
  ChatStatus,`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    'import composer skill projection',
    `  ComposerActions,
  ComposerChips,
  composerPaletteGroups,`,
    `  ComposerActions,
  ComposerChips,
  type ComposerSkill,
  composerPaletteGroups,`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    'accept entry or session skills',
    `  readonly skills?: readonly AgentSkill[] | undefined`,
    `  readonly skills?: readonly ComposerSkill[] | undefined`,
  )

  await replaceOnce(
    'apps/desktop/src/workbench/assistant-wiring.tsx',
    'subscribe to installed skills at the composition seam',
    `import { PluginsSurface } from '@poietica/plugins'
import type { SurfaceRenderers } from '@poietica/workspace'
import type { ReactNode } from 'react'`,
    `import type { ComposerSkill } from '@poietica/agent-ui'
import { PluginsSurface, type PluginStore } from '@poietica/plugins'
import type { SurfaceRenderers } from '@poietica/workspace'
import { type ReactNode, useCallback, useMemo, useSyncExternalStore } from 'react'`,
  )

  await replaceOnce(
    'apps/desktop/src/workbench/assistant-wiring.tsx',
    'project installed skills once',
    `export function createAssistantWiring({`,
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

function AssistantEntry({ onConversationStarted, session, store }) {
  const skills = useInstalledSkills(store)
  return (
    <AssistantPane
      entrySkills={skills}
      onConversationStarted={onConversationStarted}
      session={session}
    />
  )
}

function AssistantConversation({ onConversationForked, onConversationStarted, session, store, threadId }) {
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

  await replaceOnce(
    'apps/desktop/src/workbench/assistant-wiring.tsx',
    'wire installed skills into the entry surface',
    `      ai: () => <AssistantPane onConversationStarted={onConversationStarted} session={session} />,`,
    `      ai: () => (
        <AssistantEntry
          onConversationStarted={onConversationStarted}
          session={session}
          store={pluginStore}
        />
      ),`,
  )

  await replaceOnce(
    'apps/desktop/src/workbench/assistant-wiring.tsx',
    'wire installed skills into conversation surfaces',
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

  await replaceOnce(
    'apps/desktop/src/workbench/assistant-pane.tsx',
    'type entry skills',
    `import type { WorkspacePickerProps } from '@poietica/agent-ui'`,
    `import type { ComposerSkill, WorkspacePickerProps } from '@poietica/agent-ui'`,
  )

  await replaceOnce(
    'apps/desktop/src/workbench/assistant-pane.tsx',
    'accept entry skills',
    `export interface AssistantPaneProps {
  readonly onConversationStarted:`,
    `export interface AssistantPaneProps {
  readonly entrySkills: readonly ComposerSkill[]
  readonly onConversationStarted:`,
  )

  await replaceOnce(
    'apps/desktop/src/workbench/assistant-pane.tsx',
    'carry entry skills through the entry pane',
    `export function AssistantPane({ onConversationStarted, session }: AssistantPaneProps)`,
    `export function AssistantPane({ entrySkills, onConversationStarted, session }: AssistantPaneProps)`,
  )

  await replaceOnce(
    'apps/desktop/src/workbench/assistant-pane.tsx',
    'send entry skills to the conversation surface',
    `    <ConversationSurface
      git={git}`,
    `    <ConversationSurface
      entrySkills={entrySkills}
      git={git}`,
  )

  await replaceOnce(
    'apps/desktop/src/workbench/conversation-surface.tsx',
    'type conversation entry skills',
    `  AssistantSurface,
  type GitBranchPickerProps,`,
    `  AssistantSurface,
  type ComposerSkill,
  type GitBranchPickerProps,`,
  )

  await replaceOnce(
    'apps/desktop/src/workbench/conversation-surface.tsx',
    'accept conversation entry skills',
    `export interface ConversationSurfaceProps {
  /** 取得这一格`,
    `export interface ConversationSurfaceProps {
  readonly entrySkills: readonly ComposerSkill[]
  /** 取得这一格`,
  )

  await replaceOnce(
    'apps/desktop/src/workbench/conversation-surface.tsx',
    'read conversation entry skills',
    `export function ConversationSurface({
  git,`,
    `export function ConversationSurface({
  entrySkills,
  git,`,
  )

  await replaceOnce(
    'apps/desktop/src/workbench/conversation-surface.tsx',
    'repair control callback dependencies',
    `    [selectControl, sessionControls, threadId],`,
    `    [controls, onIdentify, selectControl, sessionControls, threadId],`,
  )

  await replaceOnce(
    'apps/desktop/src/workbench/conversation-surface.tsx',
    'send entry skills to assistant surface',
    `      endpoint={threadId}
      git={git}`,
    `      endpoint={threadId}
      entrySkills={entrySkills}
      git={git}`,
  )

  await replaceOnce(
    'packages/agent-ui/src/surface/assistant-surface.tsx',
    'type assistant entry skills',
    `import { AssistantComposer } from '../composer/assistant-composer'
import { useDockClearance }`,
    `import { AssistantComposer } from '../composer/assistant-composer'
import type { ComposerSkill } from '../composer/composer-actions'
import { useDockClearance }`,
  )

  await replaceOnce(
    'packages/agent-ui/src/surface/assistant-surface.tsx',
    'accept assistant entry skills',
    `export interface AssistantSurfaceProps {
  /** 这一格代表的对话。`,
    `export interface AssistantSurfaceProps {
  readonly entrySkills: readonly ComposerSkill[]
  /** 这一格代表的对话。`,
  )

  await replaceOnce(
    'packages/agent-ui/src/surface/assistant-surface.tsx',
    'read assistant entry skills',
    `  endpoint,
  git,`,
    `  endpoint,
  entrySkills,
  git,`,
  )

  await replaceOnce(
    'packages/agent-ui/src/surface/assistant-surface.tsx',
    'select the authoritative skill scope',
    `  const skills = useThreadSkills(endpoint)
  const mcpServers = useMcpServers()`,
    `  const threadSkills = useThreadSkills(endpoint)
  const skills = endpoint === null ? entrySkills : threadSkills
  const mcpServers = useMcpServers()`,
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
