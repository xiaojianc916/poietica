#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

const root = resolve(process.cwd())
const changed = new Map()
const removed = new Set()

function fail(message) {
  throw new Error(`[refactor] ${message}`)
}

function file(path) {
  const absolute = join(root, path)
  if (!existsSync(absolute)) fail(`missing required file: ${path}`)
  return readFileSync(absolute, 'utf8')
}

function stage(path, content) {
  changed.set(path, content)
}

function current(path) {
  return changed.get(path) ?? file(path)
}

function replaceOnce(path, before, after) {
  const source = current(path)
  if (source.includes(after) && !source.includes(before)) return
  const first = source.indexOf(before)
  if (first < 0) fail(`anchor not found in ${path}: ${JSON.stringify(before.slice(0, 80))}`)
  if (source.indexOf(before, first + before.length) >= 0) {
    fail(`anchor is not unique in ${path}: ${JSON.stringify(before.slice(0, 80))}`)
  }
  stage(path, source.slice(0, first) + after + source.slice(first + before.length))
}

function replaceRange(path, start, end, replacement) {
  const source = current(path)
  if (source.includes(replacement) && !source.includes(start)) return
  const from = source.indexOf(start)
  if (from < 0) fail(`start anchor not found in ${path}: ${JSON.stringify(start)}`)
  const to = source.indexOf(end, from + start.length)
  if (to < 0) fail(`end anchor not found in ${path}: ${JSON.stringify(end)}`)
  if (source.indexOf(start, from + start.length) >= 0) fail(`start anchor is not unique in ${path}`)
  stage(path, source.slice(0, from) + replacement + source.slice(to))
}

function removeExact(path, marker) {
  if (!existsSync(join(root, path))) return
  const source = file(path)
  if (!source.includes(marker)) fail(`refusing to delete unexpected file: ${path}`)
  removed.add(path)
  changed.delete(path)
}

function assertAbsent(needle, paths) {
  for (const path of paths) {
    if (removed.has(path)) continue
    if (current(path).includes(needle)) fail(`obsolete architecture remains in ${path}: ${needle}`)
  }
}

function migrateConfigModel() {
  const path = 'crates/agent-runtime/src/config.rs'

  replaceOnce(
    path,
    `pub enum ConfigPurpose {\n    /// How much freedom the agent takes during a turn.\n    Mode,`,
    `pub enum ConfigPurpose {\n    /// Which permission policy governs tool execution.\n    Permission,\n    /// An independent session feature toggle.\n    Mode,`,
  )

  replaceRange(
    path,
    `/// 运行模式的四档：`,
    `#[derive(Debug)]\nstruct ThinkingOffer`,
    `const PERMISSIONS: [(&str, &str, &str); 3] = [\n    (\"manual\", \"请求批准\", \"编辑外部资源前请求批准。\"),\n    (\"yolo\", \"帮我批准\", \"自动批准工具动作，但仍可提问。\"),\n    (\"auto\", \"完全访问\", \"自动批准工具动作与问题。\"),\n];\n\nconst TOGGLES: [(&str, &str); 2] = [(\"off\", \"关闭\"), (\"on\", \"开启\")];\n\n#[derive(Debug)]\nstruct ThinkingOffer`,
  )

  replaceOnce(
    path,
    `    offered.push(mode_control(status));\n\n    offered`,
    `    offered.push(permission_control(status));\n    offered.push(toggle_control(\"plan\", \"计划\", bool_of(status, \"plan_mode\")));\n    offered.push(toggle_control(\"swarm\", \"蜂群\", bool_of(status, \"swarm_mode\")));\n\n    if let Some(enabled) = status.get(\"tower_mode\").and_then(Value::as_bool) {\n        offered.push(toggle_control(\"tower\", \"Tower\", enabled));\n    }\n\n    offered`,
  )

  replaceRange(
    path,
    `pub fn selector_patch(config_id: &str, value: &str) -> Option<Value> {`,
    `fn model_control(`,
    `pub fn selector_patch(config_id: &str, value: &str) -> Option<Value> {\n    match config_id {\n        \"model\" if !value.is_empty() => Some(json!({ \"model\": value })),\n        \"thinking\" if !value.is_empty() => Some(json!({ \"thinking\": value })),\n        \"permission\" if PERMISSIONS.iter().any(|(id, ..)| *id == value) => {\n            Some(json!({ \"permission_mode\": value }))\n        }\n        \"plan\" => toggle_patch(\"plan_mode\", value),\n        \"swarm\" => toggle_patch(\"swarm_mode\", value),\n        \"tower\" => toggle_patch(\"tower_mode\", value),\n        _ => None,\n    }\n}\n\nfn toggle_patch(field: &str, value: &str) -> Option<Value> {\n    let enabled = match value {\n        \"on\" => true,\n        \"off\" => false,\n        _ => return None,\n    };\n    let mut patch = serde_json::Map::new();\n    patch.insert(field.to_owned(), Value::Bool(enabled));\n    Some(Value::Object(patch))\n}\n\nfn model_control(`,
  )

  replaceRange(
    path,
    `fn mode_control(status: &Value) -> ConfigControl {`,
    `/// 生效值必须在候选里`,
    `fn permission_control(status: &Value) -> ConfigControl {\n    let mut choices: Vec<ConfigChoice> = PERMISSIONS\n        .iter()\n        .map(|(value, label, detail)| ConfigChoice {\n            value: (*value).to_owned(),\n            label: (*label).to_owned(),\n            detail: Some((*detail).to_owned()),\n        })\n        .collect();\n\n    let reported = status.get(\"permission\").and_then(Value::as_str).unwrap_or(\"manual\");\n    if current_not_offered(&choices, reported) {\n        choices.push(ConfigChoice { value: reported.to_owned(), label: reported.to_owned(), detail: None });\n    }\n\n    ConfigControl {\n        id: \"permission\".to_owned(),\n        label: \"权限\".to_owned(),\n        detail: None,\n        purpose: ConfigPurpose::Permission,\n        current: in_force(&choices, reported).unwrap_or_else(|| \"manual\".to_owned()),\n        choices,\n    }\n}\n\nfn toggle_control(id: &str, label: &str, enabled: bool) -> ConfigControl {\n    ConfigControl {\n        id: id.to_owned(),\n        label: label.to_owned(),\n        detail: None,\n        purpose: ConfigPurpose::Mode,\n        current: if enabled { \"on\" } else { \"off\" }.to_owned(),\n        choices: TOGGLES\n            .iter()\n            .map(|(value, label)| ConfigChoice {\n                value: (*value).to_owned(),\n                label: (*label).to_owned(),\n                detail: None,\n            })\n            .collect(),\n    }\n}\n\nfn bool_of(status: &Value, field: &str) -> bool {\n    status.get(field).and_then(Value::as_bool).unwrap_or(false)\n}\n\n/// 生效值必须在候选里`,
  )

  replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/dto.rs',
    `pub enum AgentConfigPurpose {\n    /// How much freedom the agent takes during a turn.\n    Mode,`,
    `pub enum AgentConfigPurpose {\n    /// Which permission policy governs tool execution.\n    Permission,\n    /// An independent session feature toggle.\n    Mode,`,
  )

  replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/config.rs',
    `        purpose: match control.purpose {\n            ConfigPurpose::Mode => AgentConfigPurpose::Mode,`,
    `        purpose: match control.purpose {\n            ConfigPurpose::Permission => AgentConfigPurpose::Permission,\n            ConfigPurpose::Mode => AgentConfigPurpose::Mode,`,
  )

  replaceOnce(
    'packages/agent-contract/src/config.ts',
    `export type SessionConfigPurpose = 'model' | 'thought' | 'mode' | 'other'`,
    `export type SessionConfigPurpose = 'model' | 'thought' | 'permission' | 'mode' | 'other'`,
  )

  replaceOnce(
    'packages/agent/src/session/permission-posture.ts',
    `return controls.find((control) => control.purpose === 'mode')`,
    `return controls.find((control) => control.purpose === 'permission')`,
  )

  replaceOnce(
    'packages/agent/src/session/agent-capability-store.ts',
    `if (control.purpose === 'mode') {`,
    `if (control.purpose === 'permission') {`,
  )

  replaceOnce(
    'packages/agent/src/session/session-controls-store.ts',
    `if (control?.purpose === 'mode') {`,
    `if (control?.purpose === 'permission') {`,
  )
}

function removeImpossibleCommandEvent() {
  removeExact('packages/agent-contract/src/commands.ts', 'export interface SessionCommandsPort')

  replaceOnce(
    'packages/agent-contract/src/index.ts',
    `export type { SessionCommand, SessionCommandReport, SessionCommandsPort } from './commands'\n`,
    ``,
  )

  const ipc = 'packages/ipc/src/agent.ts'
  replaceOnce(ipc, `  SessionCommand,\n  SessionCommandsPort,\n`, ``)
  replaceOnce(
    ipc,
    `  | { readonly kind: 'commands'; readonly sessionId: string; readonly commands: unknown }\n`,
    ``,
  )
  replaceRange(
    ipc,
    `/*\n * 命令表这一路。`,
    `/*\n * 技能这一路：`,
    `/*\n * 技能这一路：`,
  )

  const runtime = 'apps/desktop/src/assistant/agent-runtime.ts'
  replaceOnce(runtime, `  SessionCommandsPort,\n`, ``)
  replaceOnce(runtime, `  createAgentSessionCommandsBridge,\n`, ``)
  replaceOnce(runtime, `  readonly sessionCommands: SessionCommandsPort\n`, ``)
  replaceOnce(
    runtime,
    `  const sessionCommands = createAgentSessionCommandsBridge({ onListenFailure: noteListenFailure })\n\n`,
    ``,
  )
  replaceOnce(runtime, `    sessionCommands,\n`, ``)

  const provider = 'apps/desktop/src/assistant/threads-provider.tsx'
  replaceOnce(provider, `    | 'sessionCommands'\n`, ``)
  replaceOnce(provider, `        commands: agent.sessionCommands,\n`, ``)

  const context = 'packages/agent-ui/src/session/session-controls-context.ts'
  replaceOnce(context, `  SessionCommand,\n`, ``)
  replaceRange(
    context,
    `/** 这条对话敲得出来的命令表；`,
    `/** 这条对话背后那个会话最近报的上下文用量；`,
    `/** 这条对话背后那个会话最近报的上下文用量；`,
  )
  replaceOnce('packages/agent-ui/src/index.ts', `  useThreadCommands,\n`, ``)

  const store = 'packages/agent/src/session/session-controls-store.ts'
  replaceOnce(store, `  SessionCommand,\n  SessionCommandReport,\n  SessionCommandsPort,\n`, ``)
  replaceOnce(store, `  readonly commands: ReadonlyMap<string, readonly SessionCommand[]>\n`, ``)
  replaceOnce(store, `  commands: new Map(),\n`, ``)
  replaceOnce(store, `  readonly commands?: SessionCommandsPort | undefined\n`, ``)
  replaceOnce(store, `  readonly #commands: SessionCommandsPort | undefined\n\n`, ``)
  replaceOnce(store, `    commands,\n`, ``)
  replaceOnce(store, `    this.#commands = commands\n`, ``)
  replaceOnce(
    store,
    `    const stopCommands = this.#commands?.subscribe((report) => {\n      this.#commandsReported(report)\n    })\n\n`,
    ``,
  )
  replaceOnce(store, `      stopCommands?.()\n`, ``)
  replaceRange(
    store,
    `  /** 这条对话背后那个会话敲得出来的命令；`,
    `  /**\n   * 激活一条技能。`,
    `  /**\n   * 激活一条技能。`,
  )
  replaceOnce(store, `      commands: withoutEntry(this.#held.commands, threadId),\n`, ``)
  replaceRange(
    store,
    `  /*\n   * agent 报来了一张命令表。`,
    `  /* 这条对话的先后。`,
    `  /* 这条对话的先后。`,
  )
  replaceOnce(store, `      next.commands === this.#held.commands &&\n`, ``)

  const surface = 'packages/agent-ui/src/surface/assistant-surface.tsx'
  replaceOnce(surface, `  SessionCommand,\n`, ``)
  replaceOnce(surface, `  useThreadCommands,\n`, ``)
  replaceRange(
    surface,
    `  /**\n   * 全局命令面板`,
    `  /**\n   * 往输入框草稿里写字`,
    `  /**\n   * 往输入框草稿里写字`,
  )
  replaceOnce(surface, `  globalPalette,\n`, ``)
  replaceOnce(surface, `  const sessionCommands = useThreadCommands(endpoint)\n`, ``)
  replaceOnce(surface, `\n  /* 会话命令为空时，用全局命令兜底（入口态、或会话还没报命令）。 */\n  const commands = sessionCommands?.length ? sessionCommands : (globalPalette ?? [])\n`, ``)
  replaceOnce(surface, `        commands={commands}\n`, ``)

  const conversation = 'apps/desktop/src/workbench/conversation-surface.tsx'
  replaceOnce(conversation, `import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'`, `import { useCallback, useEffect, useRef } from 'react'`)
  replaceOnce(conversation, `import { pluginStore } from '../plugins/plugin-runtime'\n`, ``)
  replaceRange(
    conversation,
    `  /*\n   * 斜杠菜单的候选表`,
    `  const sessionControls = useSessionControlsActions()`,
    `  const sessionControls = useSessionControlsActions()`,
  )
  replaceOnce(conversation, `      globalPalette={globalPalette}\n`, ``)

  const composer = 'packages/agent-ui/src/composer/assistant-composer.tsx'
  replaceOnce(composer, `  SessionCommand,\n`, ``)
  replaceOnce(composer, `  readonly commands?: readonly SessionCommand[] | undefined\n`, ``)
  replaceOnce(composer, `  commands,\n`, ``)
  replaceOnce(composer, `        commands: commands ?? [],\n`, ``)
  replaceOnce(composer, `    [commands, onActivateSkill, skills, toolbar.controls, toolbar.onSelectControl],`, `    [onActivateSkill, skills, toolbar.controls, toolbar.onSelectControl],`)
}

function migrateSkillDescriptor() {
  const contract = 'packages/agent-contract/src/skill.ts'
  replaceOnce(
    contract,
    `  /** project / user / extra / builtin，由 kap 判定。 */\n  readonly source: string\n`,
    `  /** project / user / extra / builtin，由 kap 判定。 */\n  readonly source: string\n  readonly path: string\n  readonly type?: string | undefined\n  readonly disableModelInvocation?: boolean | undefined\n`,
  )
  replaceOnce(
    contract,
    `  readonly list: (sessionId: string) => Promise<readonly AgentSkill[]>`,
    `  readonly list: (sessionId?: string) => Promise<readonly AgentSkill[]>`,
  )

  const native = 'crates/agent-runtime/src/session.rs'
  replaceOnce(
    native,
    `    /// project / user / extra / builtin。\n    pub source: String,\n`,
    `    /// project / user / extra / builtin。\n    pub source: String,\n    pub path: String,\n    pub kind: Option<String>,\n    pub disable_model_invocation: Option<bool>,\n`,
  )

  const dto = 'apps/desktop/src-tauri/src/commands/agent/skill.rs'
  replaceOnce(
    dto,
    `    /// project / user / extra / builtin，由 kap 判定。\n    pub source: String,\n`,
    `    /// project / user / extra / builtin，由 kap 判定。\n    pub source: String,\n    pub path: String,\n    #[serde(rename = \"type\")]\n    pub kind: Option<String>,\n    pub disable_model_invocation: Option<bool>,\n`,
  )
  replaceOnce(dto, `    pub session_id: String,`, `    pub session_id: Option<String>,`)
  replaceOnce(
    dto,
    `.skills(request.session_id)`,
    `.skills(request.session_id.unwrap_or_else(|| live.anchor.clone()))`,
  )
  replaceOnce(
    dto,
    `            source: skill.source,\n`,
    `            source: skill.source,\n            path: skill.path,\n            kind: skill.kind,\n            disable_model_invocation: skill.disable_model_invocation,\n`,
  )

  replaceOnce(
    'packages/ipc/src/agent.ts',
    `const listed = await throughIpc(() => commands.agentSkills({ sessionId }))`,
    `const listed = await throughIpc(() => commands.agentSkills({ sessionId: sessionId ?? null }))`,
  )
}

function writeArchitectureTests() {
  const test = `//! Session profile fields are independent; no selector may hide another.\n\nuse poietica_agent_runtime_native::{ConfigPurpose, controls, selector_patch};\nuse serde_json::{Value, json};\n\nfn status(plan: bool, swarm: bool, tower: bool) -> Value {\n    json!({\n        \"busy\": false,\n        \"model\": \"kimi\",\n        \"thinking_level\": \"on\",\n        \"permission\": \"manual\",\n        \"plan_mode\": plan,\n        \"swarm_mode\": swarm,\n        \"tower_mode\": tower,\n        \"context_tokens\": 0\n    })\n}\n\nfn catalog() -> Value {\n    json!({ \"items\": [{\n        \"model\": \"kimi\",\n        \"display_name\": \"Kimi\",\n        \"capabilities\": [\"thinking\"]\n    }] })\n}\n\n#[test]\nfn independent_profile_fields_are_simultaneously_visible() {\n    let offered = controls(&status(true, true, true), &catalog());\n    let ids: Vec<&str> = offered.iter().map(|item| item.id.as_str()).collect();\n    assert_eq!(ids, [\"model\", \"thinking\", \"permission\", \"plan\", \"swarm\", \"tower\"]);\n    assert!(offered.iter().find(|item| item.id == \"permission\").is_some_and(|item| item.purpose == ConfigPurpose::Permission));\n    for id in [\"plan\", \"swarm\", \"tower\"] {\n        assert!(offered.iter().find(|item| item.id == id).is_some_and(|item| item.purpose == ConfigPurpose::Mode && item.current == \"on\"));\n    }\n}\n\n#[test]\nfn every_selector_maps_to_one_official_profile_field() {\n    assert_eq!(selector_patch(\"permission\", \"yolo\"), Some(json!({ \"permission_mode\": \"yolo\" })));\n    assert_eq!(selector_patch(\"plan\", \"on\"), Some(json!({ \"plan_mode\": true })));\n    assert_eq!(selector_patch(\"swarm\", \"on\"), Some(json!({ \"swarm_mode\": true })));\n    assert_eq!(selector_patch(\"tower\", \"off\"), Some(json!({ \"tower_mode\": false })));\n    assert_eq!(selector_patch(\"plan\", \"maybe\"), None);\n}\n`
  const path = 'crates/agent-runtime/tests/config.rs'
  const source = current(path)
  if (source === test) return
  if (!source.includes('fn the_session_offers_three_selectors')) fail(`unexpected ${path}`)
  stage(path, test)
}

function validate() {
  const inspected = [
    'packages/agent-contract/src/index.ts',
    'packages/ipc/src/agent.ts',
    'apps/desktop/src/assistant/agent-runtime.ts',
    'packages/agent/src/session/session-controls-store.ts',
    'packages/agent-ui/src/session/session-controls-context.ts',
    'packages/agent-ui/src/surface/assistant-surface.tsx',
  ]
  assertAbsent('SessionCommandsPort', inspected)
  assertAbsent("kind: 'commands'", inspected)
  assertAbsent("name: 'write-goal'", ['packages/agent-ui/src/composer/composer-actions.tsx'])
  assertAbsent("name: 'tasks'", ['packages/agent-ui/src/composer/composer-actions.tsx'])
}

function commitFiles() {
  for (const [path, content] of changed) {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    const temporary = `${absolute}.refactor-${process.pid}`
    writeFileSync(temporary, content, 'utf8')
    renameSync(temporary, absolute)
    console.log(`[refactor] updated ${relative(root, absolute)}`)
  }
  for (const path of removed) {
    rmSync(join(root, path))
    console.log(`[refactor] removed ${path}`)
  }
}

function run(command, args) {
  const executable = process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command
  const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit' })
  if (result.error) fail(`${command} could not start: ${result.error.message}`)
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
}

function main() {
  const manifest = file('package.json')
  if (!manifest.includes('"name": "poietica"')) fail('run this script from the poietica repository root')

  migrateConfigModel()
  removeImpossibleCommandEvent()
  migrateSkillDescriptor()
  writeArchitectureTests()
  validate()

  if (changed.size === 0 && removed.size === 0) {
    console.log('[refactor] architecture already migrated; no source files changed')
  } else {
    commitFiles()
  }

  run('pnpm', ['ipc:generate'])
  run('pnpm', ['kap:spec:check'])
  run('pnpm', ['check'])
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
