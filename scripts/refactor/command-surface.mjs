function edit(m, path, pattern, replacement, doneMarker) {
  const source = m.read(path)
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))]
  if (matches.length === 0) {
    if (doneMarker !== undefined && source.includes(doneMarker)) return
    m.fail(`pattern not found in ${path}: ${pattern.source.slice(0, 100)}`)
  }
  if (matches.length !== 1) m.fail(`pattern is not unique in ${path}: ${pattern.source.slice(0, 100)}`)
  m.staged.set(path, source.replace(pattern, replacement))
}

export function migrateCommandSurface(m) {
  m.remove('packages/agent-contract/src/commands.ts', 'export interface SessionCommandsPort')
  m.replace(
    'packages/agent-contract/src/index.ts',
    `export type { SessionCommand, SessionCommandReport, SessionCommandsPort } from './commands'\n`,
    ``,
  )

  const ipc = 'packages/ipc/src/agent.ts'
  m.replace(ipc, `  SessionCommand,\n  SessionCommandsPort,\n`, ``)
  m.replace(ipc, `  | { readonly kind: 'commands'; readonly sessionId: string; readonly commands: unknown }\n`, ``)
  m.section(ipc, `/*\n * 命令表这一路。`, `/*\n * 技能这一路：`, `/*\n * 技能这一路：`, `技能这一路：列表与激活`)
  m.replace('packages/ipc/src/index.ts', `  createAgentSessionCommandsBridge,\n`, ``)

  const runtime = 'apps/desktop/src/assistant/agent-runtime.ts'
  m.replace(runtime, `  SessionCommandsPort,\n`, ``)
  m.replace(runtime, `  createAgentSessionCommandsBridge,\n`, ``)
  m.replace(runtime, `  readonly sessionCommands: SessionCommandsPort\n`, ``)
  m.replace(runtime, `  const sessionCommands = createAgentSessionCommandsBridge({ onListenFailure: noteListenFailure })\n\n`, ``)
  m.replace(runtime, `    sessionCommands,\n`, ``)

  const provider = 'apps/desktop/src/assistant/threads-provider.tsx'
  m.replace(provider, `    | 'sessionCommands'\n`, ``)
  m.replace(provider, `        commands: agent.sessionCommands,\n`, ``)

  const context = 'packages/agent-ui/src/session/session-controls-context.ts'
  m.replace(context, `  SessionCommand,\n`, ``)
  m.section(
    context,
    `/** 这条对话敲得出来的命令表；`,
    `/** 这条对话背后那个会话最近报的上下文用量；`,
    `/** 这条对话背后那个会话最近报的上下文用量；`,
    `这条对话背后那个会话最近报的上下文用量`,
  )
  m.replace('packages/agent-ui/src/index.ts', `  useThreadCommands,\n`, ``)

  const store = 'packages/agent/src/session/session-controls-store.ts'
  m.replace(store, `  SessionCommand,\n  SessionCommandReport,\n  SessionCommandsPort,\n`, ``)
  m.replace(store, `  readonly commands: ReadonlyMap<string, readonly SessionCommand[]>\n`, ``)
  m.replace(store, `  commands: new Map(),\n`, ``)
  m.replace(store, `  readonly commands?: SessionCommandsPort | undefined\n`, ``)
  m.replace(store, `  readonly #commands: SessionCommandsPort | undefined\n\n`, ``)
  m.replace(store, `    commands,\n`, ``)
  m.replace(store, `    this.#commands = commands\n`, ``)
  m.replace(store, `    const stopCommands = this.#commands?.subscribe((report) => {\n      this.#commandsReported(report)\n    })\n\n`, ``)
  m.replace(store, `      stopCommands?.()\n`, ``)
  m.section(
    store,
    `  /** 这条对话背后那个会话敲得出来的命令；`,
    `  /**\n   * 激活一条技能。`,
    `  /**\n   * 激活一条技能。`,
    `激活一条技能。`,
  )
  m.replace(store, `      commands: withoutEntry(this.#held.commands, threadId),\n`, ``)
  m.section(store, `  /*\n   * agent 报来了一张命令表。`, `  /* 这条对话的先后。`, `  /* 这条对话的先后。`, `这条对话的先后。`)
  m.replace(store, `      next.commands === this.#held.commands &&\n`, ``)

  const surface = 'packages/agent-ui/src/surface/assistant-surface.tsx'
  m.replace(surface, `  SessionCommand,\n`, ``)
  m.replace(surface, `  useThreadCommands,\n`, ``)
  m.section(surface, `  /**\n   * 全局命令面板`, `  /**\n   * 往输入框草稿里写字`, `  /**\n   * 往输入框草稿里写字`, `往输入框草稿里写字`)
  m.replace(surface, `  globalPalette,\n`, ``)
  m.replace(surface, `  const sessionCommands = useThreadCommands(endpoint)\n`, ``)
  m.replace(surface, `\n  /* 会话命令为空时，用全局命令兜底（入口态、或会话还没报命令）。 */\n  const commands = sessionCommands?.length ? sessionCommands : (globalPalette ?? [])\n`, ``)
  m.replace(surface, `        commands={commands}\n`, ``)

  const conversation = 'apps/desktop/src/workbench/conversation-surface.tsx'
  m.replace(conversation, `import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'`, `import { useCallback, useEffect, useRef } from 'react'`)
  m.replace(conversation, `import { pluginStore } from '../plugins/plugin-runtime'\n`, ``)
  m.section(conversation, `  /*\n   * 斜杠菜单的候选表`, `  const sessionControls = useSessionControlsActions()`, `  const sessionControls = useSessionControlsActions()`, `const sessionControls = useSessionControlsActions()`)
  m.replace(conversation, `      globalPalette={globalPalette}\n`, ``)

  const composer = 'packages/agent-ui/src/composer/assistant-composer.tsx'
  m.replace(composer, `  SessionCommand,\n`, ``)
  m.replace(composer, `  readonly commands?: readonly SessionCommand[] | undefined\n`, ``)
  m.replace(composer, `  commands,\n`, ``)
  m.replace(composer, `        commands: commands ?? [],\n`, ``)
  m.replace(composer, `    [commands, onActivateSkill, skills, toolbar.controls, toolbar.onSelectControl],`, `    [onActivateSkill, skills, toolbar.controls, toolbar.onSelectControl],`)

  const actions = 'packages/agent-ui/src/composer/composer-actions.tsx'
  m.replace(actions, `  SessionCommand,\n`, ``)
  m.section(
    actions,
    `const INTENTS: readonly {`,
    `export interface ComposerPaletteSource`,
    `const PRODUCT_COMMANDS: readonly {\n  readonly id: 'goal' | 'swarm'\n  readonly label: string\n  readonly detail: string\n  readonly snippet: string\n}[] = [\n  { id: 'goal', label: '目标', detail: '创建持续推进的目标', snippet: '/goal' },\n  { id: 'swarm', label: '蜂群', detail: '让多个子代理并行处理任务', snippet: '/swarm' },\n]\n\nexport interface ComposerPaletteSource`,
    `const PRODUCT_COMMANDS: readonly {`,
  )
  m.replace(actions, `  /** 这条会话报来的命令表。 */\n  readonly commands: readonly SessionCommand[]\n`, ``)
  m.replace(actions, `  commands,\n`, ``)
  edit(
    m,
    actions,
    /\n  if \(commands\.length > 0\) \{[\s\S]*?\n  \}\n\n  return groups/,
    `\n  groups.push({\n    id: 'commands',\n    heading: '命令',\n    rows: PRODUCT_COMMANDS.map((command) => ({\n      id: command.id,\n      icon: <TerminalIcon aria-hidden=\"true\" />,\n      label: command.label,\n      detail: command.detail,\n      token: command.snippet,\n      action: { kind: 'insert' as const, snippet: command.snippet },\n    })),\n  })\n\n  return groups`,
    `PRODUCT_COMMANDS.map((command)`,
  )

  removePluginPalette(m)
  m.assertAbsent('SessionCommandsPort', [
    'packages/agent-contract/src/index.ts', ipc, runtime, store, context, surface,
  ])
  m.assertAbsent("kind: 'commands'", [ipc])
  m.assertAbsent("name: 'write-goal'", [actions])
  m.assertAbsent("name: 'tasks'", [actions])
}

function removePluginPalette(m) {
  const path = 'packages/plugins/src/plugin-store.ts'
  edit(
    m,
    path,
    /^import type \{ SessionCommand \} from '@poietica\/agent-contract'\n[\s\S]*?(?=import type \{ InstalledPlugin)/,
    ``,
    `import type { InstalledPlugin`,
  )
  m.replace(path, `  /** agent 最近报来的命令表：斜杠菜单与扩展页读同一份。 */\n  readonly palette: readonly SessionCommand[]\n`, ``)
  m.replace(path, `  /** agent 报来的命令表；store 持有这条订阅的完整寿命。 */\n  readonly palette?: AgentPalettePort | undefined\n`, ``)
  m.replace(path, `  palette: [],\n`, ``)
  m.replace(path, `  let stopPalette: (() => void) | null = null\n\n`, ``)
  edit(m, path, /  \/\*\n   \* 收下 agent 最近报来的命令表。[\s\S]*?(?=  function publish\()/, ``, `function publish`)
  edit(m, path, /\n      if \(options\.palette !== undefined\) \{[\s\S]*?\n      \}\n/, `\n`, `queue = queue.then`)
  m.replace(path, `      stopPalette?.()\n      stopPalette = null\n`, ``)

  m.replace('packages/plugins/src/index.ts', `  type AgentPalettePort,\n`, ``)

  const pluginSurface = 'packages/plugins/src/surface/plugins-surface.tsx'
  m.replace(pluginSurface, `import type { PaletteEntry } from '@poietica/agent-contract'\n`, ``)
  edit(m, pluginSurface, /  \/\*\n   \* 装在这里的技能[\s\S]*?  const reported = view\.palette\.filter\([\s\S]*?\n  \)\n\n/, ``, `const counts`)
  m.replace(pluginSurface, `    skills: view.skills.length + reported.length,`, `    skills: view.skills.length,`)
  m.replace(pluginSurface, `          reported={reported}\n`, ``)
  m.replace(pluginSurface, `  readonly reported: readonly PaletteEntry[]\n`, ``)
  m.replace(pluginSurface, `function TabBody({ entries, needle, onOpen, reported, store, tab, view }: TabBodyProps) {`, `function TabBody({ entries, needle, onOpen, store, tab, view }: TabBodyProps) {`)
  edit(
    m,
    pluginSurface,
    /      const rows = \[\n        \.\.\.view\.skills\.map\(\(skill\) => installedSkillRow\(skill, store\)\),\n        \.\.\.reported\.map\(skillRow\),\n      \]\.filter\(\(row\) => matches\(needle, row\.title, row\.detail\)\)/,
    `      const rows = view.skills\n        .map((skill) => installedSkillRow(skill, store))\n        .filter((row) => matches(needle, row.title, row.detail))`,
    `const rows = view.skills`,
  )
  edit(m, pluginSurface, /\n\/\*\n \* agent 报来的那些。[\s\S]*?\nfunction skillRow\([\s\S]*?\n\}\n(?=\nfunction )/, `\n`, `function installedSkillRow`)
}
