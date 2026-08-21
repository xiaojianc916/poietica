#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

const root = process.cwd()
const generatedBinding = 'packages/ipc/src/generated/ipc-bindings.ts'
const snapshots = new Map()
let changed = 0

function occurrences(source, needle) {
  let count = 0
  let from = 0
  while ((from = source.indexOf(needle, from)) !== -1) {
    count += 1
    from += needle.length
  }
  return count
}

async function snapshot(path) {
  if (snapshots.has(path)) return
  try {
    snapshots.set(path, await readFile(resolve(root, path)))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
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
  await snapshot(path)
  const source = await readFile(resolve(root, path), 'utf8')
  if (source.includes(after)) {
    console.log(`skip ${label}`)
    return
  }
  const count = occurrences(source, before)
  if (count !== 1) {
    throw new Error(`${label}: expected one anchor in ${path}, found ${count}`)
  }
  await atomicWrite(path, source.replace(before, after))
  changed += 1
  console.log(`apply ${label}`)
}

async function createOnce(path, label, content) {
  await snapshot(path)
  try {
    const source = await readFile(resolve(root, path), 'utf8')
    if (source === content) {
      console.log(`skip ${label}`)
      return
    }
    throw new Error(`${label}: ${path} already exists with different content`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
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
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? String(code)})`))
    })
  })
}

async function rollback() {
  for (const [path, bytes] of [...snapshots].reverse()) {
    if (bytes === null) await rm(resolve(root, path), { force: true })
    else await atomicWrite(path, bytes)
  }
}

async function main() {
  const manifest = await readFile(resolve(root, 'package.json'), 'utf8')
  if (!manifest.includes('"packageManager": "pnpm@')) {
    throw new Error('run refactor.mjs from the poietica repository root')
  }

  await snapshot(generatedBinding)

  await replaceOnce(
    'packages/agent-contract/src/config.ts',
    'declare prompt-bound controls',
    `  readonly purpose: SessionConfigPurpose
  /** The value in force right now. */`,
    `  readonly purpose: SessionConfigPurpose
  /** Present only when enabling this control belongs to the next prompt transaction. */
  readonly appliesOnSubmit?: true
  /** The value in force right now. */`,
  )

  await replaceOnce(
    'packages/agent-contract/src/session.ts',
    'declare prompt configuration',
    `export interface PromptSkill {
  readonly name: string
  readonly args?: string | undefined
}

export interface AgentPromptRequest {`,
    `export interface PromptSkill {
  readonly name: string
  readonly args?: string | undefined
}

/** A selector value committed before the prompt enters the agent. */
export interface PromptConfiguration {
  readonly id: string
  readonly value: string
}

export interface AgentPromptRequest {`,
  )

  await replaceOnce(
    'packages/agent-contract/src/session.ts',
    'carry prompt configuration through the session port',
    `  readonly text: string
  /**
   * 这一句带的图片。`,
    `  readonly text: string
  readonly configuration: readonly PromptConfiguration[]
  /**
   * 这一句带的图片。`,
  )

  await replaceOnce(
    'packages/agent-contract/src/index.ts',
    'export prompt configuration',
    `  PromptAsset,
  PromptSkill,
} from './session'`,
    `  PromptAsset,
  PromptConfiguration,
  PromptSkill,
} from './session'`,
  )

  await replaceOnce(
    'crates/agent-runtime/src/config.rs',
    'mark prompt-bound runtime controls',
    `    pub purpose: ConfigPurpose,
    pub current: String,`,
    `    pub purpose: ConfigPurpose,
    pub applies_on_submit: bool,
    pub current: String,`,
  )

  await replaceOnce(
    'crates/agent-runtime/src/config.rs',
    'classify plan as an immediate mode',
    `        "只读分析并先产出计划",
        status.get("plan_mode").and_then(Value::as_bool) == Some(true),`,
    `        "只读分析并先产出计划",
        ConfigPurpose::Mode,
        false,
        status.get("plan_mode").and_then(Value::as_bool) == Some(true),`,
  )

  await replaceOnce(
    'crates/agent-runtime/src/config.rs',
    'classify swarm as an independent selector toggle',
    `        "并行调度子代理",
        status.get("swarm_mode").and_then(Value::as_bool) == Some(true),`,
    `        "并行调度子代理",
        ConfigPurpose::Other,
        false,
        status.get("swarm_mode").and_then(Value::as_bool) == Some(true),`,
  )

  await replaceOnce(
    'crates/agent-runtime/src/config.rs',
    'parameterize toggle placement and commit timing',
    `fn toggle_control(id: &str, label: &str, detail: &str, enabled: bool) -> ConfigControl {
    ConfigControl {
        id: id.to_owned(),
        label: label.to_owned(),
        detail: None,
        purpose: ConfigPurpose::Mode,
        current: if enabled { ON } else { OFF }.to_owned(),`,
    `fn toggle_control(
    id: &str,
    label: &str,
    detail: &str,
    purpose: ConfigPurpose,
    applies_on_submit: bool,
    enabled: bool,
) -> ConfigControl {
    ConfigControl {
        id: id.to_owned(),
        label: label.to_owned(),
        detail: None,
        purpose,
        applies_on_submit,
        current: if enabled { ON } else { OFF }.to_owned(),`,
  )

  await replaceOnce(
    'crates/agent-runtime/src/config.rs',
    'bind goal enablement to prompt submission',
    `        "以当前草稿为目标持续推进",
        objective.is_some(),`,
    `        "以当前草稿为目标持续推进",
        ConfigPurpose::Mode,
        true,
        objective.is_some(),`,
  )

  for (const purpose of ['Permission', 'Model', 'Thought']) {
    await replaceOnce(
      'crates/agent-runtime/src/config.rs',
      `default ${purpose.toLowerCase()} to immediate application`,
      `        purpose: ConfigPurpose::${purpose},
        current:`,
      `        purpose: ConfigPurpose::${purpose},
        applies_on_submit: false,
        current:`,
    )
  }

  await replaceOnce(
    'crates/agent-runtime/src/selection.rs',
    'add selector transaction imports',
    `use std::time::Duration;

use futures::channel::oneshot;`,
    `use std::collections::HashSet;
use std::time::Duration;

use futures::channel::oneshot;`,
  )

  await replaceOnce(
    'crates/agent-runtime/src/selection.rs',
    'import selector validation',
    `use crate::config::{ConfigControl, ConfigPurpose};`,
    `use crate::config::{ConfigControl, ConfigPurpose, selector_patch};`,
  )

  await replaceOnce(
    'crates/agent-runtime/src/selection.rs',
    'add prompt configuration transaction',
    `const SETTLE_INTERVAL: Duration = Duration::from_millis(25);

/// Changes one session control`,
    `const SETTLE_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigSelection {
    pub id: String,
    pub value: String,
}

/// Validates the complete prompt configuration before writing any selector,
/// skips values already in force, and returns the one authoritative table.
pub async fn apply_configurations(
    client: &AgentClient,
    session_id: String,
    selections: Vec<ConfigSelection>,
    input: Option<String>,
) -> Result<Vec<ConfigControl>> {
    let mut ids = HashSet::new();
    for selection in &selections {
        if !ids.insert(selection.id.as_str()) {
            return Err(KapError::Validation {
                message: format!("prompt configuration repeats selector {}", selection.id),
            });
        }
        let _validated = selector_patch(&selection.id, &selection.value, input.as_deref())?;
    }

    let mut controls = receive(client.selectors(session_id.clone())?).await?;
    for selection in selections {
        if controls
            .iter()
            .any(|control| control.id == selection.id && control.current == selection.value)
        {
            continue;
        }
        controls = select_config(
            client,
            session_id.clone(),
            selection.id,
            selection.value,
            input.clone(),
        )
        .await?;
    }
    Ok(controls)
}

/// Changes one session control`,
  )

  await replaceOnce(
    'crates/agent-runtime/src/selection.rs',
    'complete runtime control test fixtures',
    `            purpose,
            current: current.to_owned(),`,
    `            purpose,
            applies_on_submit: false,
            current: current.to_owned(),`,
  )

  await replaceOnce(
    'crates/agent-runtime/src/lib.rs',
    'export prompt configuration transaction',
    `pub use selection::select_config;`,
    `pub use selection::{ConfigSelection, apply_configurations, select_config};`,
  )

  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/dto.rs',
    'generate prompt configuration DTO',
    `/// A prompt, and how to start the agent if it is not running yet.
#[derive(Debug, Deserialize, Type)]`,
    `#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPromptConfiguration {
    pub id: String,
    pub value: String,
}

/// A prompt, and how to start the agent if it is not running yet.
#[derive(Debug, Deserialize, Type)]`,
  )

  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/dto.rs',
    'add configuration to native prompt request',
    `    /// What the user typed.
    pub text: String,
    /// 这一句带的图片`,
    `    /// What the user typed.
    pub text: String,
    /// Selector values committed as part of this prompt.
    pub configuration: Vec<AgentPromptConfiguration>,
    /// 这一句带的图片`,
  )

  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/dto.rs',
    'publish prompt commit timing',
    `    /// Where this selector belongs on screen.
    pub purpose: AgentConfigPurpose,
    /// The value in force right now.`,
    `    /// Where this selector belongs on screen.
    pub purpose: AgentConfigPurpose,
    /// Enabling this selector is committed with the next prompt.
    pub applies_on_submit: bool,
    /// The value in force right now.`,
  )

  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/config.rs',
    'map prompt commit timing to IPC',
    `        },
        current: control.current,`,
    `        },
        applies_on_submit: control.applies_on_submit,
        current: control.current,`,
  )

  await replaceOnce(
    'apps/desktop/src-tauri/src/ipc/mod.rs',
    'register prompt configuration DTO import',
    `        AgentPromptRequest, AgentPromptResult, AgentPromptSkill, AgentQuestionAnswer, AgentQuestionChoice,`,
    `        AgentPromptConfiguration, AgentPromptRequest, AgentPromptResult, AgentPromptSkill,
        AgentQuestionAnswer, AgentQuestionChoice,`,
  )

  await replaceOnce(
    'apps/desktop/src-tauri/src/ipc/mod.rs',
    'register prompt configuration DTO type',
    `        .typ::<AgentPromptRequest>()
        .typ::<AgentPromptResult>()`,
    `        .typ::<AgentPromptRequest>()
        .typ::<AgentPromptConfiguration>()
        .typ::<AgentPromptResult>()`,
  )

  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/turn.rs',
    'import prompt configuration transaction',
    `use poietica_agent_runtime_native::{FrameSink, PromptSkill, RecordedEvent};`,
    `use poietica_agent_runtime_native::{
    ConfigSelection, FrameSink, PromptSkill, RecordedEvent, apply_configurations,
};`,
  )

  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/turn.rs',
    'import selector event projection',
    `use super::addressing::session_for;
use super::attachment::{Kept, keep_bytes};`,
    `use super::addressing::session_for;
use super::attachment::{Kept, keep_bytes};
use super::config::restate;`,
  )

  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/turn.rs',
    'import selector event DTO',
    `    AgentPromptRequest, AgentPromptResult, AgentResolvePermissionRequest, answered, decided,`,
    `    AgentPromptRequest, AgentPromptResult, AgentResolvePermissionRequest, AgentSessionEvent,
    answered, decided,`,
  )

  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/turn.rs',
    'import selector event channel',
    `    AGENT_EVENT, AgentCommandResult, FRAME_INTERVAL, IMAGE_OPENER, NO_CONVERSATION, NO_SESSION,`,
    `    AGENT_EVENT, AGENT_SESSION_EVENT, AgentCommandResult, FRAME_INTERVAL, IMAGE_OPENER,
    NO_CONVERSATION, NO_SESSION,`,
  )

  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/turn.rs',
    'read prompt configuration once',
    `    let text = request.text.trim().to_owned();
    let attached = request.assets;`,
    `    let text = request.text.trim().to_owned();
    let configuration = request
        .configuration
        .into_iter()
        .map(|selected| ConfigSelection {
            id: selected.id,
            value: selected.value,
        })
        .collect();
    let attached = request.assets;`,
  )

  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/turn.rs',
    'commit configuration before recording the prompt',
    `    let addressed = held.session_id;

    // The first thing said names the conversation`,
    `    let addressed = held.session_id;

    if !configuration.is_empty() {
        let offered = apply_configurations(
            &session.client,
            addressed.clone(),
            configuration,
            Some(text.clone()),
        )
        .await
        .map_err(translate)?;

        let _ignored = app.emit(
            AGENT_SESSION_EVENT,
            AgentSessionEvent::Selectors {
                session_id: addressed.clone(),
                selectors: offered.into_iter().map(restate).collect(),
            },
        );
    }

    // The first thing said names the conversation`,
  )

  await replaceOnce(
    'packages/ipc/src/agent.ts',
    'send prompt configuration over generated IPC',
    `          text: request.text,
          threadId: request.threadId,`,
    `          text: request.text,
          threadId: request.threadId,
          configuration: request.configuration.map((selected) => ({
            id: selected.id,
            value: selected.value,
          })),`,
  )

  await replaceOnce(
    'packages/ipc/src/agent.ts',
    'map prompt commit timing into the domain',
    `    purpose: native.purpose,
    current: native.current,`,
    `    purpose: native.purpose,
    ...(native.appliesOnSubmit ? { appliesOnSubmit: true as const } : {}),
    current: native.current,`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/composer-palette.tsx',
    'type prompt-bound palette actions',
    `import type { ReactNode } from 'react'`,
    `import type { PromptConfiguration } from '@poietica/agent-contract'
import type { ReactNode } from 'react'`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/composer-palette.tsx',
    'add prompt configuration palette action',
    `  | { readonly kind: 'insert'; readonly chip: import('./prompt-chip').PromptChipValue }
  | { readonly kind: 'run'; readonly run: (draft: string) => void }`,
    `  | { readonly kind: 'insert'; readonly chip: import('./prompt-chip').PromptChipValue }
  | { readonly kind: 'configure'; readonly configuration: PromptConfiguration; readonly label: string }
  | { readonly kind: 'run'; readonly run: (draft: string) => void }`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/composer-actions.tsx',
    'import prompt configuration type',
    `import type { AgentMcpServer, AgentSkill, SessionConfigControl } from '@poietica/agent-contract'`,
    `import type {
  AgentMcpServer,
  AgentSkill,
  PromptConfiguration,
  SessionConfigControl,
} from '@poietica/agent-contract'`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/composer-actions.tsx',
    'remove swarm from composer mode icons',
    `  SkillIcon,
  SwarmIcon,
  ToolIcon,`,
    `  SkillIcon,
  ToolIcon,`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/composer-actions.tsx',
    'model toggle controls explicitly',
    `function toggleRow(
  control: SessionConfigControl,
  onSelect: ComposerPaletteSource['onSelectControl'],
): PaletteRow {
  const enabled = control.current === 'on'
  const choice = control.choices.find((candidate) => candidate.value === 'on')
  const Icon = control.id === 'goal' ? GoalIcon : control.id === 'swarm' ? SwarmIcon : SirenIcon
  return {
    id: control.id,
    icon: <Icon aria-hidden="true" />,
    label: control.label,
    ...(choice?.detail === undefined ? {} : { detail: choice.detail }),
    checked: enabled,
    action: {
      kind: 'run',
      run: (draft) => {
        onSelect(control.id, enabled ? 'off' : 'on', control.id === 'goal' ? draft : undefined)
      },
    },
  }
}`, 
    `export function isToggleControl(control: SessionConfigControl): boolean {
  const values = new Set(control.choices.map((choice) => choice.value))
  return values.size === 2 && values.has('off') && values.has('on')
}

export function activePromptConfiguration(
  controls: readonly SessionConfigControl[],
): readonly PromptConfiguration[] {
  return controls
    .filter(
      (control) =>
        control.appliesOnSubmit !== true &&
        isToggleControl(control) &&
        control.current === 'on',
    )
    .map((control) => ({ id: control.id, value: control.current }))
}

function toggleRow(
  control: SessionConfigControl,
  onSelect: ComposerPaletteSource['onSelectControl'],
): PaletteRow {
  const enabled = control.current === 'on'
  const choice = control.choices.find((candidate) => candidate.value === 'on')
  const Icon = control.id === 'goal' ? GoalIcon : SirenIcon
  return {
    id: control.id,
    icon: <Icon aria-hidden="true" />,
    label: control.label,
    ...(choice?.detail === undefined ? {} : { detail: choice.detail }),
    checked: enabled,
    action:
      !enabled && control.appliesOnSubmit === true
        ? {
            kind: 'configure',
            configuration: { id: control.id, value: 'on' },
            label: control.label,
          }
        : {
            kind: 'run',
            run: () => {
              onSelect(control.id, enabled ? 'off' : 'on')
            },
          },
  }
}`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/composer-actions.tsx',
    'keep selector toggles out of the composer palette',
    `    if (control.purpose !== 'other' || control.choices.length === 0) {`,
    `    if (
      control.purpose !== 'other' ||
      control.choices.length === 0 ||
      isToggleControl(control)
    ) {`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/composer-actions.tsx',
    'render pending prompt controls from the draft owner',
    `export interface ComposerChipsProps {
  readonly controls: readonly SessionConfigControl[]
  readonly onSelect: (controlId: string, value: string) => void
  readonly swarm?: number | undefined
}

function glyph(controlId: string): ReactNode {
  if (controlId === 'goal') {
    return <GoalIcon />
  }
  if (controlId === 'swarm') {
    return <SwarmIcon />
  }
  return <SirenIcon />
}

function label(control: SessionConfigControl, swarm: number | undefined): string {
  if (control.id === 'goal' && control.detail) {
    return \`目标：\${control.detail}\`
  }
  if (control.id === 'swarm' && swarm !== undefined && swarm > 0) {
    return \`蜂群 · \${String(swarm)}\`
  }
  return control.label
}

export function ComposerChips({ controls, onSelect, swarm }: ComposerChipsProps) {
  const active = controls.filter(
    (control) => control.purpose === 'mode' && control.current === 'on',
  )
  if (active.length === 0) {
    return null
  }
  return (
    <>
      <span aria-hidden="true" className="assistant-mode-chip__divider" />
      {active.map((control) => {
        const text = label(control, swarm)
        return (
          <button
            aria-label={\`退出 \${text}\`}
            className="assistant-mode-chip"
            key={control.id}
            onClick={() => onSelect(control.id, 'off')}
            type="button"
          >
            <span aria-hidden="true" className="assistant-mode-chip__icon">
              <span className="assistant-mode-chip__glyph">{glyph(control.id)}</span>
              <span className="assistant-mode-chip__remove">
                <CloseIcon />
              </span>
            </span>
            <span className="assistant-mode-chip__label">{text}</span>
          </button>
        )
      })}
    </>
  )
}`, 
    `export interface ComposerChipsProps {
  readonly controls: readonly SessionConfigControl[]
  readonly onSelect: (controlId: string, value: string) => void
}

function glyph(controlId: string): ReactNode {
  return controlId === 'goal' ? <GoalIcon /> : <SirenIcon />
}

function label(control: SessionConfigControl): string {
  return control.id === 'goal' && control.detail ? \`目标：\${control.detail}\` : control.label
}

export function ComposerChips({ controls, onSelect }: ComposerChipsProps) {
  const { configuration } = usePromptInputDraft()
  const { removeConfiguration } = usePromptInputActions()
  const active = controls.filter(
    (control) => control.purpose === 'mode' && control.current === 'on',
  )
  if (active.length === 0 && configuration.length === 0) {
    return null
  }
  return (
    <>
      <span aria-hidden="true" className="assistant-mode-chip__divider" />
      {active.map((control) => {
        const text = label(control)
        return (
          <button
            aria-label={\`退出 \${text}\`}
            className="assistant-mode-chip"
            key={control.id}
            onClick={() => onSelect(control.id, 'off')}
            type="button"
          >
            <span aria-hidden="true" className="assistant-mode-chip__icon">
              <span className="assistant-mode-chip__glyph">{glyph(control.id)}</span>
              <span className="assistant-mode-chip__remove"><CloseIcon /></span>
            </span>
            <span className="assistant-mode-chip__label">{text}</span>
          </button>
        )
      })}
      {configuration.map((selected) => (
        <button
          aria-label={\`取消 \${selected.label}\`}
          className="assistant-mode-chip"
          key={\`pending:\${selected.id}\`}
          onClick={() => removeConfiguration(selected.id)}
          type="button"
        >
          <span aria-hidden="true" className="assistant-mode-chip__icon">
            <span className="assistant-mode-chip__glyph">{glyph(selected.id)}</span>
            <span className="assistant-mode-chip__remove"><CloseIcon /></span>
          </span>
          <span className="assistant-mode-chip__label">{selected.label}</span>
        </button>
      ))}
    </>
  )
}`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/composer-actions.tsx',
    'import prompt draft projection for chips',
    `import { usePromptInputActions } from './prompt-input'`,
    `import { usePromptInputActions, usePromptInputDraft } from './prompt-input'`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    'import prompt configuration in the draft owner',
    `import type { ChatStatus, PromptSkill } from '@poietica/agent-contract'`,
    `import type { ChatStatus, PromptConfiguration, PromptSkill } from '@poietica/agent-contract'`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    'carry prompt configuration in submitted message',
    `  readonly text: string
  readonly assets: readonly ComposerAsset[]`,
    `  readonly text: string
  readonly configuration: readonly PromptConfiguration[]
  readonly assets: readonly ComposerAsset[]`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    'model pending prompt configuration in the draft',
    `/** 这一格此刻攒着的可发内容。整串草稿不出现在这里，因为没有人需要它。 */
export interface PromptInputDraft {
  readonly hasText: boolean
  readonly hasFiles: boolean
}`, 
    `export interface PendingPromptConfiguration extends PromptConfiguration {
  readonly label: string
}

/** 这一格此刻攒着的可发内容。 */
export interface PromptInputDraft {
  readonly hasText: boolean
  readonly hasFiles: boolean
  readonly requiresText: boolean
  readonly configuration: readonly PendingPromptConfiguration[]
}

export function canSubmitDraft(
  draft: Pick<PromptInputDraft, 'hasText' | 'hasFiles' | 'requiresText'>,
): boolean {
  return draft.requiresText ? draft.hasText : draft.hasText || draft.hasFiles
}`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    'add configuration removal to draft actions',
    `  readonly removeAttachment: (assetToken: string) => void
  readonly openFilePicker: () => void`,
    `  readonly removeAttachment: (assetToken: string) => void
  readonly removeConfiguration: (id: string) => void
  readonly openFilePicker: () => void`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    'accept carried selector configuration',
    `  readonly groups?: readonly PaletteGroup[] | undefined
  readonly onSubmit: (message: PromptInputMessage) => void`,
    `  readonly groups?: readonly PaletteGroup[] | undefined
  readonly configuration?: readonly PromptConfiguration[] | undefined
  readonly onSubmit: (message: PromptInputMessage) => void`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    'initialize pending configuration state',
    `  children,
  className,
  groups,`,
    `  children,
  className,
  configuration: carriedConfiguration = [],
  groups,`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    'own pending configuration beside the editor draft',
    `  const [attachments, setAttachments] = useState<readonly ComposerAsset[]>([])
  const [paletteOpened, setPaletteOpened] = useState(false)`,
    `  const [attachments, setAttachments] = useState<readonly ComposerAsset[]>([])
  const [pendingConfiguration, setPendingConfiguration] = useState<
    readonly PendingPromptConfiguration[]
  >([])
  const [paletteOpened, setPaletteOpened] = useState(false)`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    'add pending configuration mutations',
    `  const togglePalette = useCallback(() => {
    setHighlighted(0)
    setPaletteOpened((open) => !open)
  }, [])`,
    `  const removeConfiguration = useCallback((id: string) => {
    setPendingConfiguration((current) => current.filter((selected) => selected.id !== id))
  }, [])

  const toggleConfiguration = useCallback((selected: PendingPromptConfiguration) => {
    setPendingConfiguration((current) =>
      current.some((candidate) => candidate.id === selected.id)
        ? current.filter((candidate) => candidate.id !== selected.id)
        : [...current.filter((candidate) => candidate.id !== selected.id), selected],
    )
  }, [])

  const togglePalette = useCallback(() => {
    setHighlighted(0)
    setPaletteOpened((open) => !open)
  }, [])`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    'publish pending configuration through draft contexts',
    `      removeAttachment,
      openFilePicker,`,
    `      removeAttachment,
      removeConfiguration,
      openFilePicker,`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    'stabilize configuration action dependencies',
    `      openFilePicker,
      removeAttachment,
      requestSubmit,`,
    `      openFilePicker,
      removeAttachment,
      removeConfiguration,
      requestSubmit,`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    'project prompt requirements from the draft',
    `  const draft = useMemo<PromptInputDraft>(() => ({ hasText, hasFiles }), [hasFiles, hasText])`,
    `  const draft = useMemo<PromptInputDraft>(
    () => ({
      hasText,
      hasFiles,
      requiresText: pendingConfiguration.length > 0,
      configuration: pendingConfiguration,
    }),
    [hasFiles, hasText, pendingConfiguration],
  )`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    'project pending choices into the palette',
    `  const visible = allGroups
  const rows = useMemo(() => visible.flatMap((group) => group.rows), [visible])`,
    `  const visible = useMemo(
    () =>
      allGroups.map((group) => ({
        ...group,
        rows: group.rows.map((row) =>
          row.action.kind === 'configure'
            ? {
                ...row,
                checked: pendingConfiguration.some(
                  (selected) => selected.id === row.action.configuration.id,
                ),
              }
            : row,
        ),
      })),
    [allGroups, pendingConfiguration],
  )
  const rows = useMemo(() => visible.flatMap((group) => group.rows), [visible])`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    'handle prompt-bound palette choices without session effects',
    `      if (row.action.kind === 'run') {
        row.action.run(draftText.text)
        focusEditor()
        return
      }
      editor.update(() => {`,
    `      if (row.action.kind === 'run') {
        row.action.run(draftText.text)
        focusEditor()
        return
      }
      if (row.action.kind === 'configure') {
        toggleConfiguration({ ...row.action.configuration, label: row.action.label })
        focusEditor()
        return
      }
      editor.update(() => {`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    'track prompt-bound palette callback dependency',
    `    [closePalette, draftText.text, editor, focusEditor],`,
    `    [closePalette, draftText.text, editor, focusEditor, toggleConfiguration],`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    'commit objective and prompt in one submission',
    `              if (said.length === 0 && attachments.length === 0) {
                return
              }

              onSubmit({ text: said, assets: attachments, skills: draftText.skills })
              clearDraft(editor)
              rewindPalette()`,
    `              if (
                !canSubmitDraft({
                  hasText: said.length > 0,
                  hasFiles: attachments.length > 0,
                  requiresText: pendingConfiguration.length > 0,
                })
              ) {
                return
              }

              onSubmit({
                text: said,
                assets: attachments,
                skills: draftText.skills,
                configuration: [
                  ...carriedConfiguration,
                  ...pendingConfiguration.map(({ id, value }) => ({ id, value })),
                ],
              })
              clearDraft(editor)
              setPendingConfiguration([])
              rewindPalette()`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    'disable blank goal submission',
    `  const { hasFiles, hasText } = usePromptInputDraft()`,
    `  const draft = usePromptInputDraft()`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    'share the submit invariant with the button',
    `      disabled={disabled ?? (!isStreaming && !hasText && !hasFiles)}`,
    `      disabled={disabled ?? (!isStreaming && !canSubmitDraft(draft))}`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    'type submitted prompt configuration',
    `  PromptSkill,
  QuestionResponse,`,
    `  PromptConfiguration,
  PromptSkill,
  QuestionResponse,`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    'import active prompt configuration projection',
    `import { ComposerActions, ComposerChips, composerPaletteGroups } from './composer-actions'`,
    `import {
  activePromptConfiguration,
  ComposerActions,
  ComposerChips,
  composerPaletteGroups,
} from './composer-actions'`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    'publish configuration in composer submission',
    `    readonly text: string
    readonly assets: readonly ComposerAsset[]`,
    `    readonly text: string
    readonly configuration: readonly PromptConfiguration[]
    readonly assets: readonly ComposerAsset[]`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    'remove swarm transcript count prop',
    `  /** 此刻还在跑的子代理数，真相在转录。 */
  readonly swarm?: number | undefined
`,
    ``,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    'remove swarm toolbar field',
    `  | 'onSelectControl'
  | 'swarm'
  | 'usage'`,
    `  | 'onSelectControl'
  | 'usage'`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    'remove swarm toolbar argument',
    `  status,
  swarm,
  usage,`,
    `  status,
  usage,`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    'render only composer modes as chips',
    `<ComposerChips controls={controls} onSelect={onSelectControl} swarm={swarm} />`,
    `<ComposerChips controls={controls} onSelect={onSelectControl} />`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    'derive configuration carried into a new session',
    `  const groups = useMemo(
    () =>`,
    `  const configuration = useMemo(
    () => activePromptConfiguration(toolbar.controls),
    [toolbar.controls],
  )

  const groups = useMemo(
    () =>`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    'pass carried configuration to the draft owner',
    `        className={asking ? 'assistant-prompt-input--question' : undefined}
        groups={groups}`,
    `        className={asking ? 'assistant-prompt-input--question' : undefined}
        configuration={configuration}
        groups={groups}`,
  )

  await replaceOnce(
    'packages/agent-ui/src/session/use-assistant-session.ts',
    'type assistant prompt configuration',
    `  PromptAsset,
  PromptSkill,`,
    `  PromptAsset,
  PromptConfiguration,
  PromptSkill,`,
  )

  await replaceOnce(
    'packages/agent-ui/src/session/use-assistant-session.ts',
    'carry assistant prompt configuration',
    `  readonly assets: readonly PromptAsset[]
  readonly skills: readonly PromptSkill[]`,
    `  readonly assets: readonly PromptAsset[]
  readonly configuration: readonly PromptConfiguration[]
  readonly skills: readonly PromptSkill[]`,
  )

  await replaceOnce(
    'packages/agent-ui/src/session/use-assistant-session.ts',
    'send prompt configuration to transcript store',
    `        assets: submission.assets,
        endpoint,`,
    `        assets: submission.assets,
        configuration: submission.configuration,
        endpoint,`,
  )

  await replaceOnce(
    'packages/agent/src/session/transcript-store.ts',
    'type transcript prompt configuration',
    `  PromptAsset,
  PromptSkill,`,
    `  PromptAsset,
  PromptConfiguration,
  PromptSkill,`,
  )

  await replaceOnce(
    'packages/agent/src/session/transcript-store.ts',
    'declare transcript prompt configuration',
    `  readonly assets: readonly PromptAsset[]
  readonly skills: readonly PromptSkill[]`,
    `  readonly assets: readonly PromptAsset[]
  readonly configuration: readonly PromptConfiguration[]
  readonly skills: readonly PromptSkill[]`,
  )

  await replaceOnce(
    'packages/agent/src/session/transcript-store.ts',
    'read transcript prompt configuration',
    `    assets,
    endpoint,`,
    `    assets,
    configuration,
    endpoint,`,
  )

  await replaceOnce(
    'packages/agent/src/session/transcript-store.ts',
    'forward prompt configuration through the single send pipeline',
    `        return port.prompt({ threadId, text, assets, skills }).then((handle) => {`,
    `        return port.prompt({ threadId, text, assets, configuration, skills }).then((handle) => {`,
  )

  await replaceOnce(
    'packages/agent-ui/src/surface/assistant-surface.tsx',
    'remove swarm subscription import',
    `  useAssistantQuestion,
  useAssistantSession,
  useAssistantSwarm,`,
    `  useAssistantQuestion,
  useAssistantSession,`,
  )

  await replaceOnce(
    'packages/agent-ui/src/surface/assistant-surface.tsx',
    'remove redundant swarm transcript projection',
    `  /* 这一段的处境：目标与在跑的子代理数，都从帧日志派生（kap 的 goal_start 与 agent_call / task）。 */
  const swarm = useAssistantSwarm(assistant.key)

`,
    ``,
  )

  await replaceOnce(
    'packages/agent-ui/src/surface/assistant-surface.tsx',
    'remove swarm count from composer',
    `        status={assistant.status}
        swarm={swarm}
        usage={usage}`,
    `        status={assistant.status}
        usage={usage}`,
  )

  await replaceOnce(
    'apps/desktop/src/workbench/conversation-surface.tsx',
    'stop mode selection from creating a conversation',
    `      const control = controls.find((candidate) => candidate.id === controlId)
      if (threadId === null && control?.purpose === 'mode') {
        void onIdentify?.().then((identified) => {
          if (identified !== null && identified !== undefined) {
            sessionControls.selectControl(identified, controlId, value, input)
          }
        })
        return
      }
      if (threadId === null) {`,
    `      if (threadId === null) {`,
  )

  await replaceOnce(
    'apps/desktop/src/workbench/conversation-surface.tsx',
    'stabilize entry selector callback dependencies',
    `    [controls, onIdentify, selectControl, sessionControls, threadId],`,
    `    [selectControl, sessionControls, threadId],`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/session-controls.tsx',
    'use the design-system switch',
    `  DropdownMenuTrigger,
} from '@poietica/ui'`,
    `  DropdownMenuTrigger,
  Switch,
} from '@poietica/ui'`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/session-controls.tsx',
    'share toggle classification',
    `import { Fragment, memo, useMemo, useState } from 'react'`,
    `import { Fragment, memo, useMemo, useState } from 'react'
import { isToggleControl } from './composer-actions'`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/session-controls.tsx',
    'define selector rows without permission duplication',
    `export interface SessionControlsProps {`,
    `export function sessionControlRows(
  controls: readonly SessionConfigControl[],
): readonly SessionConfigControl[] {
  return [...controls]
    .filter((control) =>
      ['model', 'thought', 'other'].includes(control.purpose),
    )
    .sort((left, right) => rank(left.purpose) - rank(right.purpose))
}

export interface SessionControlsProps {`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/session-controls.tsx',
    'use explicit selector placement',
    `  const rows = useMemo(
    () =>
      [...controls]
        .filter((control) => control.purpose !== 'mode')
        .sort((left, right) => rank(left.purpose) - rank(right.purpose)),
    [controls],
  )`,
    `  const rows = useMemo(() => sessionControlRows(controls), [controls])`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/session-controls.tsx',
    'render independent selector toggles as switches',
    `          rows.map((control) => (
            <Fragment key={control.id}>
              <DropdownMenuItem
                className="assistant-config-menu__row"
                closeOnClick={false}
                onClick={() => {
                  setPane(control.id)
                }}
              >
                <span className="assistant-config-menu__row-label">{control.label}</span>

                <span className="assistant-config-menu__row-value">{chosen(control)}</span>
              </DropdownMenuItem>`,
    `          rows.map((control) => (
            <Fragment key={control.id}>
              {isToggleControl(control) ? (
                <DropdownMenuItem
                  aria-checked={control.current === 'on'}
                  className="assistant-config-menu__row"
                  closeOnClick={false}
                  onClick={() => {
                    onSelect(control.id, control.current === 'on' ? 'off' : 'on')
                  }}
                  role="menuitemcheckbox"
                >
                  <span className="assistant-config-menu__row-label">{control.label}</span>

                  <Switch
                    aria-hidden="true"
                    checked={control.current === 'on'}
                    className="pointer-events-none ml-auto"
                    size="sm"
                    tabIndex={-1}
                  />
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  className="assistant-config-menu__row"
                  closeOnClick={false}
                  onClick={() => {
                    setPane(control.id)
                  }}
                >
                  <span className="assistant-config-menu__row-label">{control.label}</span>

                  <span className="assistant-config-menu__row-value">{chosen(control)}</span>
                </DropdownMenuItem>
              )}`, 
  )

  await createOnce(
    'packages/agent-ui/src/__tests__/composer-configuration.test.ts',
    'add durable composer configuration regressions',
    `import type { SessionConfigControl } from '@poietica/agent-contract'
import { describe, expect, it } from 'vitest'
import { activePromptConfiguration } from '../composer/composer-actions'
import { canSubmitDraft } from '../composer/prompt-input'
import { sessionControlRows } from '../composer/session-controls'

function control(
  id: string,
  purpose: SessionConfigControl['purpose'],
  current: string,
  appliesOnSubmit = false,
): SessionConfigControl {
  return {
    id,
    label: id,
    purpose,
    current,
    choices: [
      { value: 'off', label: 'off' },
      { value: 'on', label: 'on' },
    ],
    ...(appliesOnSubmit ? { appliesOnSubmit: true as const } : {}),
  }
}

describe('composer configuration transaction', () => {
  it('does not expose permission in the model menu and keeps swarm independent', () => {
    const model: SessionConfigControl = {
      id: 'model',
      label: 'Model',
      purpose: 'model',
      current: 'k3',
      choices: [{ value: 'k3', label: 'K3' }],
    }
    const permission = control('permission', 'permission', 'off')
    const swarm = control('swarm', 'other', 'off')

    expect(sessionControlRows([permission, swarm, model]).map((item) => item.id)).toEqual([
      'model',
      'swarm',
    ])
  })

  it('carries active immediate modes without treating goal as already committed', () => {
    expect(
      activePromptConfiguration([
        control('plan', 'mode', 'on'),
        control('swarm', 'other', 'on'),
        control('goal', 'mode', 'on', true),
      ]),
    ).toEqual([
      { id: 'plan', value: 'on' },
      { id: 'swarm', value: 'on' },
    ])
  })

  it('requires real text when a prompt-bound goal is selected', () => {
    expect(canSubmitDraft({ hasText: false, hasFiles: true, requiresText: true })).toBe(false)
    expect(canSubmitDraft({ hasText: true, hasFiles: false, requiresText: true })).toBe(true)
  })
})
`,
  )

  if (changed === 0) {
    console.log('refactor already applied')
    return
  }

  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  await run(pnpm, ['ipc:generate'])
  await run(pnpm, ['check'])
  console.log(`refactor complete (${changed} anchored edits)`)
}

try {
  await main()
} catch (error) {
  try {
    await rollback()
  } catch (rollbackError) {
    console.error('rollback failed', rollbackError)
  }
  console.error(error)
  process.exitCode = 1
}
