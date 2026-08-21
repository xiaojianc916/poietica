#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, extname, relative, resolve } from 'node:path'

const ROOT = process.cwd()
const GENERATED = 'packages/ipc/src/generated/ipc-bindings.ts'
const staged = new Map()
const removed = new Set()
const originals = new Map()

function fail(message) {
  throw new Error(message)
}

async function exists(path) {
  try {
    await access(resolve(ROOT, path))
    return true
  } catch {
    return false
  }
}

async function load(path) {
  if (removed.has(path)) fail(`${path}: already staged for deletion`)
  if (staged.has(path)) return staged.get(path)
  const absolute = resolve(ROOT, path)
  const content = await readFile(absolute, 'utf8')
  originals.set(path, content)
  staged.set(path, content)
  return content
}

async function replaceOnce(path, before, after) {
  const current = await load(path)
  if (current.includes(after) && !current.includes(before)) return
  const first = current.indexOf(before)
  if (first < 0) fail(`${path}: required anchor not found`)
  if (current.indexOf(before, first + before.length) >= 0) {
    fail(`${path}: required anchor is not unique`)
  }
  staged.set(path, `${current.slice(0, first)}${after}${current.slice(first + before.length)}`)
}

async function replaceAll(path, before, after, expected) {
  const current = await load(path)
  const count = current.split(before).length - 1
  if (count === 0 && current.includes(after)) return
  if (count !== expected) fail(`${path}: expected ${expected} anchors, found ${count}`)
  staged.set(path, current.split(before).join(after))
}

async function overwrite(path, oldMarker, next) {
  if (await exists(path)) {
    const current = await load(path)
    if (current === next) return
    if (!current.includes(oldMarker)) fail(`${path}: base marker not found`)
  } else {
    originals.set(path, null)
  }
  staged.set(path, next)
}

async function create(path, content) {
  if (await exists(path)) {
    const current = await readFile(resolve(ROOT, path), 'utf8')
    if (current === content) return
    fail(`${path}: refusing to overwrite an unexpected file`)
  }
  originals.set(path, null)
  staged.set(path, content)
}

async function deleteFile(path, marker) {
  if (!(await exists(path))) return
  const current = await load(path)
  if (!current.includes(marker)) fail(`${path}: deletion marker not found`)
  removed.add(path)
  staged.delete(path)
}

async function atomicWrite(path, content) {
  const absolute = resolve(ROOT, path)
  await mkdir(dirname(absolute), { recursive: true })
  const temporary = `${absolute}.${randomUUID()}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, absolute)
}

function run(command, args) {
  const executable = process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command
  const result = spawnSync(executable, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
}

async function filesBelow(directory) {
  const found = []
  async function walk(path) {
    for (const entry of await readdir(resolve(ROOT, path), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'target' || entry.name === '.git') continue
      const child = `${path}/${entry.name}`
      if (entry.isDirectory()) await walk(child)
      else found.push(child)
    }
  }
  await walk(directory)
  return found
}

async function assertForbiddenAbsent() {
  const forbidden = [
    'agent_activate_skill',
    'agentActivateSkill',
    'ActivateSkill',
    'activateSkill',
    'useSkillActivation',
    'onActivateSkill',
    'useAssistantGoal',
    'activeGoal',
    'assistant-mode-chip--state',
    'usePostureMemory',
    "heading: '命令'",
    '/skill:',
    '/mcp',
  ]
  const paths = [
    ...(await filesBelow('apps')),
    ...(await filesBelow('crates')),
    ...(await filesBelow('packages')),
  ]
  for (const path of paths) {
    if (path === GENERATED || removed.has(path)) continue
    const extension = extname(path)
    if (!['.rs', '.ts', '.tsx', '.css'].includes(extension)) continue
    const content = staged.get(path) ?? (await readFile(resolve(ROOT, path), 'utf8'))
    for (const token of forbidden) {
      if (content.includes(token)) fail(`${path}: obsolete token remains: ${token}`)
    }
  }
}

async function snapshotRust() {
  for (const root of ['apps', 'crates']) {
    for (const path of await filesBelow(root)) {
      if (extname(path) !== '.rs' || originals.has(path)) continue
      originals.set(path, await readFile(resolve(ROOT, path), 'utf8'))
    }
  }
  if (!originals.has(GENERATED) && (await exists(GENERATED))) {
    originals.set(GENERATED, await readFile(resolve(ROOT, GENERATED), 'utf8'))
  }
}

async function rollback() {
  for (const [path, content] of originals) {
    if (content === null) await rm(resolve(ROOT, path), { force: true })
    else await atomicWrite(path, content)
  }
}

const CONFIG_RS = `//! Kimi 会话配置的唯一领域投影。
//!
//! status、model catalog 与 goal snapshot 在这里合成批准方式、计划、目标、蜂群、
//! 模型和 Thinking。独立的上游状态保持独立；UI 不再反推或复制它们。

use serde_json::{Value, json};

use crate::error::{KapError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigPurpose {
    Permission,
    Mode,
    Model,
    Thought,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigChoice {
    pub value: String,
    pub label: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigControl {
    pub id: String,
    pub label: String,
    pub detail: Option<String>,
    pub purpose: ConfigPurpose,
    pub current: String,
    pub choices: Vec<ConfigChoice>,
}

const PERMISSIONS: [(&str, &str); 3] = [
    ("manual", "请求批准"),
    ("yolo", "帮我批准"),
    ("auto", "完全访问权限"),
];
const OFF: &str = "off";
const ON: &str = "on";
const MAX_GOAL_OBJECTIVE_UTF16: usize = 4000;

#[derive(Debug)]
struct ThinkingOffer {
    current: String,
    choices: Vec<ConfigChoice>,
}

#[must_use]
pub fn controls(status: &Value, catalog: &Value, goal: &Value) -> Vec<ConfigControl> {
    let mut offered = Vec::new();
    let current_model = status.get("model").and_then(Value::as_str).unwrap_or("");
    let items = catalog
        .get("items")
        .and_then(Value::as_array)
        .map(Vec::as_slice);

    if let Some(model) = model_control(current_model, items) {
        offered.push(model);
    }
    if let Some(thinking) = thinking_control(
        status
            .get("thinking_level")
            .and_then(Value::as_str)
            .unwrap_or(""),
        current_model,
        items,
    ) {
        offered.push(thinking);
    }

    offered.push(permission_control(status));
    offered.push(toggle_control(
        "plan",
        "计划",
        "只读分析并先产出计划",
        status.get("plan_mode").and_then(Value::as_bool) == Some(true),
    ));
    offered.push(goal_control(goal));
    offered.push(toggle_control(
        "swarm",
        "蜂群",
        "并行调度子代理",
        status.get("swarm_mode").and_then(Value::as_bool) == Some(true),
    ));

    offered
}

pub fn selector_patch(config_id: &str, value: &str, input: Option<&str>) -> Result<Value> {
    match config_id {
        "model" if !value.is_empty() => Ok(json!({ "model": value })),
        "thinking" if !value.is_empty() => Ok(json!({ "thinking": value })),
        "permission" if PERMISSIONS.iter().any(|(candidate, _)| *candidate == value) => {
            Ok(json!({ "permission_mode": value }))
        }
        "plan" if matches!(value, OFF | ON) => Ok(json!({ "plan_mode": value == ON })),
        "swarm" if matches!(value, OFF | ON) => Ok(json!({ "swarm_mode": value == ON })),
        "goal" if value == OFF => Ok(json!({ "goal_control": "cancel" })),
        "goal" if value == ON => {
            let objective = input.unwrap_or_default().trim();
            if objective.is_empty() {
                return Err(KapError::Validation {
                    message: "goal objective cannot be empty".to_owned(),
                });
            }
            if objective.encode_utf16().count() > MAX_GOAL_OBJECTIVE_UTF16 {
                return Err(KapError::Validation {
                    message: format!(
                        "goal objective cannot exceed {MAX_GOAL_OBJECTIVE_UTF16} UTF-16 code units"
                    ),
                });
            }
            Ok(json!({ "goal_objective": objective }))
        }
        _ => Err(KapError::Validation {
            message: format!("the session offers no control {config_id} with value {value}"),
        }),
    }
}

fn permission_control(status: &Value) -> ConfigControl {
    let mut choices: Vec<ConfigChoice> = PERMISSIONS
        .iter()
        .map(|(value, label)| ConfigChoice {
            value: (*value).to_owned(),
            label: (*label).to_owned(),
            detail: None,
        })
        .collect();
    let reported = status
        .get("permission")
        .and_then(Value::as_str)
        .unwrap_or("manual");
    if current_not_offered(&choices, reported) {
        choices.push(choice(reported));
    }

    ConfigControl {
        id: "permission".to_owned(),
        label: "批准方式".to_owned(),
        detail: None,
        purpose: ConfigPurpose::Permission,
        current: in_force(&choices, reported).unwrap_or_else(|| "manual".to_owned()),
        choices,
    }
}

fn toggle_control(id: &str, label: &str, detail: &str, enabled: bool) -> ConfigControl {
    ConfigControl {
        id: id.to_owned(),
        label: label.to_owned(),
        detail: None,
        purpose: ConfigPurpose::Mode,
        current: if enabled { ON } else { OFF }.to_owned(),
        choices: vec![
            ConfigChoice {
                value: OFF.to_owned(),
                label: "关闭".to_owned(),
                detail: None,
            },
            ConfigChoice {
                value: ON.to_owned(),
                label: label.to_owned(),
                detail: Some(detail.to_owned()),
            },
        ],
    }
}

fn goal_control(goal: &Value) -> ConfigControl {
    let objective = goal
        .get("objective")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut control = toggle_control(
        "goal",
        "目标",
        "以当前草稿为目标持续推进",
        objective.is_some(),
    );
    control.detail = objective;
    control
}

fn model_control(current: &str, items: Option<&[Value]>) -> Option<ConfigControl> {
    if current.is_empty() {
        return None;
    }
    let mut choices: Vec<ConfigChoice> = items
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let model = item.get("model").and_then(Value::as_str)?;
            Some(ConfigChoice {
                value: model.to_owned(),
                label: item
                    .get("display_name")
                    .and_then(Value::as_str)
                    .unwrap_or(model)
                    .to_owned(),
                detail: None,
            })
        })
        .collect();
    if current_not_offered(&choices, current) {
        choices.push(choice(current));
    }
    Some(ConfigControl {
        id: "model".to_owned(),
        label: "Model".to_owned(),
        detail: None,
        purpose: ConfigPurpose::Model,
        current: in_force(&choices, current)?,
        choices,
    })
}

fn thinking_control(reported: &str, model: &str, items: Option<&[Value]>) -> Option<ConfigControl> {
    let offer = thinking_offer(model, non_empty(reported), items?)?;
    Some(ConfigControl {
        id: "thinking".to_owned(),
        label: "Thinking".to_owned(),
        detail: None,
        purpose: ConfigPurpose::Thought,
        current: offer.current,
        choices: offer.choices,
    })
}

fn thinking_offer(model: &str, reported: Option<&str>, items: &[Value]) -> Option<ThinkingOffer> {
    let item = items
        .iter()
        .find(|item| item.get("model").and_then(Value::as_str) == Some(model))?;
    let capabilities = item
        .get("capabilities")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let supports = capabilities
        .iter()
        .any(|capability| matches!(capability.as_str(), Some("thinking" | "always_thinking")));
    let always = capabilities
        .iter()
        .any(|capability| capability.as_str() == Some("always_thinking"));
    let mut choices = Vec::new();

    if let Some(efforts) = item.get("support_efforts").and_then(Value::as_array) {
        for effort in efforts {
            let Some(value) = effort.as_str().and_then(non_empty) else {
                continue;
            };
            push_unique(&mut choices, choice(value));
        }
    }
    if !choices.is_empty() {
        let current = reported
            .filter(|value| contains(&choices, value))
            .or_else(|| {
                item.get("default_effort")
                    .and_then(Value::as_str)
                    .and_then(non_empty)
                    .filter(|value| contains(&choices, value))
            })
            .or_else(|| choices.get(choices.len() / 2).map(|choice| choice.value.as_str()))?;
        return Some(ThinkingOffer {
            current: current.to_owned(),
            choices,
        });
    }
    if !supports {
        return None;
    }
    choices.push(choice(ON));
    if !always {
        choices.push(choice(OFF));
    }
    let current = reported
        .filter(|value| contains(&choices, value))
        .unwrap_or(ON)
        .to_owned();
    Some(ThinkingOffer { current, choices })
}

fn in_force(choices: &[ConfigChoice], reported: &str) -> Option<String> {
    choices
        .iter()
        .find(|choice| choice.value == reported)
        .or_else(|| choices.first())
        .map(|choice| choice.value.clone())
}

fn current_not_offered(choices: &[ConfigChoice], current: &str) -> bool {
    !current.is_empty() && !contains(choices, current)
}

fn choice(value: &str) -> ConfigChoice {
    ConfigChoice {
        value: value.to_owned(),
        label: value.to_owned(),
        detail: None,
    }
}

fn push_unique(choices: &mut Vec<ConfigChoice>, candidate: ConfigChoice) {
    if !contains(choices, &candidate.value) {
        choices.push(candidate);
    }
}

fn contains(choices: &[ConfigChoice], value: &str) -> bool {
    choices.iter().any(|choice| choice.value == value)
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(model: &str, thinking: &str) -> Value {
        json!({
            "model": model,
            "thinking_level": thinking,
            "permission": "manual",
            "plan_mode": false,
            "swarm_mode": false
        })
    }

    fn catalog(model: &str, capabilities: Value, efforts: Value, default: &str) -> Value {
        json!({ "items": [{
            "model": model,
            "capabilities": capabilities,
            "support_efforts": efforts,
            "default_effort": default
        }] })
    }

    #[test]
    fn stale_effort_falls_back_to_declared_default() {
        let offered = catalog("deepseek", json!(["thinking"]), json!(["high", "max"]), "high");
        let thought = controls(&status("deepseek", "low"), &offered, &Value::Null)
            .into_iter()
            .find(|control| control.purpose == ConfigPurpose::Thought)
            .expect("Thinking control");
        assert_eq!(thought.current, "high");
    }

    #[test]
    fn boolean_and_unavailable_thinking_are_distinct() {
        let boolean = json!({ "items": [{ "model": "boolean", "capabilities": ["thinking"] }] });
        let unavailable = json!({ "items": [{ "model": "plain", "capabilities": [] }] });
        let thought = controls(&status("boolean", "low"), &boolean, &Value::Null)
            .into_iter()
            .find(|control| control.purpose == ConfigPurpose::Thought)
            .expect("boolean Thinking control");
        assert_eq!(thought.current, ON);
        assert!(
            controls(&status("plain", "low"), &unavailable, &Value::Null)
                .iter()
                .all(|control| control.purpose != ConfigPurpose::Thought)
        );
    }

    #[test]
    fn plan_goal_and_swarm_remain_independent() {
        let status = json!({
            "model": "model",
            "thinking_level": "on",
            "permission": "yolo",
            "plan_mode": true,
            "swarm_mode": true
        });
        let catalog = json!({ "items": [{ "model": "model", "capabilities": [] }] });
        let goal = json!({ "objective": "修掉 flaky 测试", "status": "active" });
        let offered = controls(&status, &catalog, &goal);
        for id in ["plan", "goal", "swarm"] {
            assert_eq!(
                offered.iter().find(|control| control.id == id).map(|control| control.current.as_str()),
                Some(ON)
            );
        }
        assert_eq!(
            offered.iter().find(|control| control.id == "permission").map(|control| control.current.as_str()),
            Some("yolo")
        );
    }

    #[test]
    fn goal_patch_validates_the_official_limit() {
        assert!(matches!(
            selector_patch("goal", ON, Some("  ")),
            Err(KapError::Validation { .. })
        ));
        let too_long = "😀".repeat(2001);
        assert!(matches!(
            selector_patch("goal", ON, Some(&too_long)),
            Err(KapError::Validation { .. })
        ));
        assert_eq!(
            selector_patch("goal", ON, Some("  ship it  ")).expect("goal patch"),
            json!({ "goal_objective": "ship it" })
        );
        assert_eq!(
            selector_patch("goal", OFF, None).expect("cancel patch"),
            json!({ "goal_control": "cancel" })
        );
    }
}
`

const SKILL_RS = `//! Kimi 当前会话提供的 Skill 目录。

use poietica_agent_runtime_native::Skill;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use super::failure::translate;
use super::runtime::{AgentRuntime, borrow};
use super::{AgentCommandResult, NO_SESSION};
use crate::error::Error;

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkill {
    pub name: String,
    pub description: String,
    pub source: String,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillsRequest {
    pub session_id: String,
}

#[tauri::command]
#[specta::specta]
pub async fn agent_skills(
    state: State<'_, AgentRuntime>,
    request: AgentSkillsRequest,
) -> AgentCommandResult<Vec<AgentSkill>> {
    let live = borrow(&state)?.ok_or_else(|| Error::NotFound(NO_SESSION.to_owned()))?;
    let listed = live
        .client
        .skills(request.session_id)
        .await
        .map_err(translate)?;

    Ok(listed
        .into_iter()
        .map(|skill: Skill| AgentSkill {
            name: skill.name,
            description: skill.description,
            source: skill.source,
        })
        .collect())
}
`

const MCP_RS = `//! Kimi 检测到的 MCP server 名册。

use poietica_agent_runtime_native::{McpServer, McpStatus, McpTransport};
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, State};

use super::dto::AgentCapabilitiesRequest;
use super::failure::translate;
use super::runtime::{AgentRuntime, ensure_session};
use super::AgentCommandResult;

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentMcpTransport {
    Stdio,
    Http,
    Sse,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentMcpStatus {
    Connected,
    Connecting,
    Disconnected,
    Error,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcpServer {
    pub id: String,
    pub name: String,
    pub transport: AgentMcpTransport,
    pub status: AgentMcpStatus,
    pub tool_count: u32,
    pub last_error: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn agent_mcp_servers(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
    request: AgentCapabilitiesRequest,
) -> AgentCommandResult<Vec<AgentMcpServer>> {
    let live = ensure_session(&app, &state, request.launch, request.cwd).await?;
    let listed = live.client.mcp_servers().await.map_err(translate)?;
    Ok(listed.into_iter().map(restate).collect())
}

fn restate(server: McpServer) -> AgentMcpServer {
    AgentMcpServer {
        id: server.id,
        name: server.name,
        transport: match server.transport {
            McpTransport::Stdio => AgentMcpTransport::Stdio,
            McpTransport::Http => AgentMcpTransport::Http,
            McpTransport::Sse => AgentMcpTransport::Sse,
        },
        status: match server.status {
            McpStatus::Connected => AgentMcpStatus::Connected,
            McpStatus::Connecting => AgentMcpStatus::Connecting,
            McpStatus::Disconnected => AgentMcpStatus::Disconnected,
            McpStatus::Error => AgentMcpStatus::Error,
        },
        tool_count: server.tool_count,
        last_error: server.last_error,
    }
}
`

const CONTRACT_SKILL = `/** Kimi 当前会话公布的一条 Skill。 */
export interface AgentSkill {
  readonly name: string
  readonly description: string
  readonly source: string
}

/** Skill 目录按会话寻址；执行随同一次 prompt 的 skills 字段提交。 */
export interface AgentSkillPort {
  readonly list: (sessionId: string) => Promise<readonly AgentSkill[]>
}
`

const CONTRACT_MCP = `export type AgentMcpTransport = 'stdio' | 'http' | 'sse'
export type AgentMcpStatus = 'connected' | 'connecting' | 'disconnected' | 'error'

/** Kimi GET /mcp/servers 返回的一条 server。 */
export interface AgentMcpServer {
  readonly id: string
  readonly name: string
  readonly transport: AgentMcpTransport
  readonly status: AgentMcpStatus
  readonly toolCount: number
  readonly lastError?: string | undefined
}

/** 名册属于当前 Kimi 进程，不属于某一轮 prompt。 */
export interface AgentMcpPort {
  readonly list: () => Promise<readonly AgentMcpServer[]>
}
`

const PROMPT_CHIP = `import './prompt-chip.css'

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $getNodeByKey,
  DecoratorNode,
  type NodeKey,
  type SerializedLexicalNode,
} from 'lexical'
import type { ReactNode } from 'react'
import { CloseIcon, SkillIcon, ToolIcon } from '../primitives/icons'

export type PromptChipValue =
  | { readonly kind: 'skill'; readonly name: string; readonly args?: string | undefined }
  | { readonly kind: 'mcp'; readonly id: string; readonly name: string }

type SerializedChipNode = SerializedLexicalNode & { readonly value: PromptChipValue }

export function samePromptChip(left: PromptChipValue, right: PromptChipValue): boolean {
  return left.kind === right.kind &&
    (left.kind === 'skill'
      ? left.name === (right.kind === 'skill' ? right.name : '')
      : left.id === (right.kind === 'mcp' ? right.id : ''))
}

export class ChipNode extends DecoratorNode<ReactNode> {
  readonly #value: PromptChipValue

  static override getType(): string {
    return 'chip'
  }

  static override clone(node: ChipNode): ChipNode {
    return new ChipNode(node.#value, node.__key)
  }

  static override importJSON(serialized: SerializedChipNode): ChipNode {
    return new ChipNode(serialized.value)
  }

  constructor(value: PromptChipValue, key?: NodeKey) {
    super(key)
    this.#value = value
  }

  value(): PromptChipValue {
    return this.#value
  }

  override exportJSON(): SerializedChipNode {
    return { ...super.exportJSON(), value: this.#value }
  }

  override createDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'assistant-prompt-chip'
    return span
  }

  override updateDOM(): false {
    return false
  }

  override isInline(): true {
    return true
  }

  override getTextContent(): string {
    return this.#value.kind === 'mcp' ? \@\mcp:\${this.#value.name}\ : ''
  }

  override decorate(): ReactNode {
    return <PromptChipView nodeKey={this.getKey()} value={this.#value} />
  }
}

function PromptChipView({ nodeKey, value }: { readonly nodeKey: NodeKey; readonly value: PromptChipValue }) {
  const [editor] = useLexicalComposerContext()
  const Icon = value.kind === 'skill' ? SkillIcon : ToolIcon
  const label = value.kind === 'skill' ? value.name : \@\\${value.name}\

  return (
    <span className="assistant-prompt-chip__body" contentEditable={false}>
      <Icon aria-hidden="true" />
      <span>{label}</span>
      <button
        aria-label={\移除\${label}\}
        className="assistant-prompt-chip__remove"
        onMouseDown={(event) => {
          event.preventDefault()
          editor.update(() => {
            const node = $getNodeByKey(nodeKey)
            if (node instanceof ChipNode) node.remove()
          })
        }}
        type="button"
      >
        <CloseIcon aria-hidden="true" />
      </button>
    </span>
  )
}

export function $createChipNode(value: PromptChipValue): ChipNode {
  return new ChipNode(value)
}
`

const PROMPT_CHIP_CSS = `.assistant-prompt-chip {
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
`

const COMPOSER_ACTIONS = `import type { AgentMcpServer, AgentSkill, SessionConfigControl } from '@poietica/agent-contract'
import type { ReactNode } from 'react'
import {
  CloseIcon,
  GoalIcon,
  PlusIcon,
  SirenIcon,
  SkillIcon,
  SwarmIcon,
  ToolIcon,
} from '../primitives/icons'
import type { PaletteGroup, PaletteRow } from './composer-palette'
import type { PromptChipValue } from './prompt-chip'
import { usePromptInputActions } from './prompt-input'

export function ComposerActions() {
  const { togglePalette } = usePromptInputActions()
  return (
    <button aria-label="添加内容" className="assistant-plus" onClick={togglePalette} type="button">
      <PlusIcon aria-hidden="true" />
    </button>
  )
}

export interface ComposerPaletteSource {
  readonly controls: readonly SessionConfigControl[]
  readonly onSelectControl: (controlId: string, value: string, input?: string) => void
  readonly skills: readonly AgentSkill[]
  readonly mcpServers: readonly AgentMcpServer[]
}

function insertRow(
  id: string,
  label: string,
  detail: string | undefined,
  icon: ReactNode,
  chip: PromptChipValue,
): PaletteRow {
  return {
    id,
    icon,
    label,
    ...(detail === undefined || detail === '' ? {} : { detail }),
    action: { kind: 'insert', chip },
  }
}

function toggleRow(
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
}

function choiceRow(
  control: SessionConfigControl,
  choice: SessionConfigControl['choices'][number],
  onSelect: ComposerPaletteSource['onSelectControl'],
): PaletteRow {
  return {
    id: \\${control.id}:\${choice.value}\,
    icon: <ToolIcon aria-hidden="true" />,
    label: choice.label,
    ...(choice.detail === undefined ? {} : { detail: choice.detail }),
    checked: choice.value === control.current,
    action: {
      kind: 'run',
      run: () => {
        if (choice.value !== control.current) onSelect(control.id, choice.value)
      },
    },
  }
}

export function composerPaletteGroups({
  controls,
  mcpServers,
  onSelectControl,
  skills,
}: ComposerPaletteSource): readonly PaletteGroup[] {
  const groups: PaletteGroup[] = []
  const modes = controls
    .filter((control) => control.purpose === 'mode')
    .map((control) => toggleRow(control, onSelectControl))
  if (modes.length > 0) groups.push({ id: 'modes', heading: '模式', rows: modes })

  for (const control of controls) {
    if (control.purpose !== 'other' || control.choices.length === 0) continue
    groups.push({
      id: control.id,
      heading: control.label,
      rows: control.choices.map((choice) => choiceRow(control, choice, onSelectControl)),
    })
  }

  if (skills.length > 0) {
    groups.push({
      id: 'skills',
      heading: '技能',
      rows: skills.map((skill) =>
        insertRow(
          \skill:\${skill.name}\,
          skill.name,
          skill.description,
          <SkillIcon aria-hidden="true" />,
          { kind: 'skill', name: skill.name },
        ),
      ),
    })
  }

  const connected = mcpServers.filter((server) => server.status === 'connected')
  if (connected.length > 0) {
    groups.push({
      id: 'mcp',
      heading: '检测到可用的 MCP',
      rows: connected.map((server) =>
        insertRow(
          \mcp:\${server.id}\,
          server.name,
          \\${server.transport} · \${String(server.toolCount)} 个工具\,
          <ToolIcon aria-hidden="true" />,
          { kind: 'mcp', id: server.id, name: server.name },
        ),
      ),
    })
  }
  return groups
}

export interface ComposerChipsProps {
  readonly controls: readonly SessionConfigControl[]
  readonly onSelect: (controlId: string, value: string) => void
  readonly swarm?: number | undefined
}

function glyph(controlId: string): ReactNode {
  if (controlId === 'goal') return <GoalIcon />
  if (controlId === 'swarm') return <SwarmIcon />
  return <SirenIcon />
}

function label(control: SessionConfigControl, swarm: number | undefined): string {
  if (control.id === 'goal' && control.detail) return \目标：\${control.detail}\
  if (control.id === 'swarm' && swarm !== undefined && swarm > 0) {
    return \蜂群 · \${String(swarm)}\
  }
  return control.label
}

export function ComposerChips({ controls, onSelect, swarm }: ComposerChipsProps) {
  const active = controls.filter(
    (control) => control.purpose === 'mode' && control.current === 'on',
  )
  if (active.length === 0) return null
  return (
    <>
      <span aria-hidden="true" className="assistant-mode-chip__divider" />
      {active.map((control) => {
        const text = label(control, swarm)
        return (
          <button
            aria-label={\退出\${text}\}
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
    </>
  )
}
`

async function apply() {
  if (!(await exists('AGENTS.md')) || !(await exists('pnpm-workspace.yaml'))) {
    fail('run this script from the poietica repository root')
  }

  await overwrite('crates/agent-runtime/src/config.rs', 'const MODES:', CONFIG_RS)
  await replaceOnce(
    'crates/agent-runtime/src/error.rs',
    `    /// 答复与桌上的问题对不上：没问过、没这个选项、或问的那一侧已经走了。\n`,
    `    /// 本地领域校验失败，请求尚未发给 Kimi。\n    #[error("invalid request: {message}")]\n    Validation { message: String },\n    /// 答复与桌上的问题对不上：没问过、没这个选项、或问的那一侧已经走了。\n`,
  )

  await replaceOnce(
    'crates/agent-runtime/src/commands.rs',
    `use crate::session::{Cursor, OpenedSession, SessionEntry, Skill};`,
    `use crate::session::{Cursor, McpServer, OpenedSession, SessionEntry, Skill};`,
  )
  await replaceOnce(
    'crates/agent-runtime/src/commands.rs',
    `/// What the driver is asked to do next.`,
    `#[derive(Clone, Debug)]\npub struct PromptSkill {\n    pub name: String,\n    pub args: Option<String>,\n}\n\n/// What the driver is asked to do next.`,
  )
  await replaceOnce(
    'crates/agent-runtime/src/commands.rs',
    `    /// 在这条会话上激活一条技能。\n    ActivateSkill {\n        session_id: String,\n        name: String,\n        /// 技能名后面那段自由文本；没有就是空串。\n        args: String,\n        reply: oneshot::Sender<Result<()>>,\n    },`,
    `    /// Kimi 当前进程检测到的 MCP server。\n    McpServers {\n        reply: oneshot::Sender<Result<Vec<McpServer>>>,\n    },`,
  )
  await replaceOnce(
    'crates/agent-runtime/src/commands.rs',
    `        images: Vec<PromptImage>,\n        /// 这一轮的帧交到哪里去。`,
    `        images: Vec<PromptImage>,\n        /// 与正文、附件同一次提交的 Skill。\n        skills: Vec<PromptSkill>,\n        /// 这一轮的帧交到哪里去。`,
  )
  await replaceOnce(
    'crates/agent-runtime/src/commands.rs',
    `    Cancel {\n        session_id: String,\n    },`,
    `    Cancel {\n        session_id: String,\n        reply: oneshot::Sender<Result<()>>,\n    },`,
  )
  await replaceOnce(
    'crates/agent-runtime/src/commands.rs',
    `        value: String,\n        reply: oneshot::Sender<Result<Vec<ConfigControl>>>,\n    },\n}`,
    `        value: String,\n        input: Option<String>,\n        reply: oneshot::Sender<Result<Vec<ConfigControl>>>,\n    },\n}`,
  )
  await replaceOnce(
    'crates/agent-runtime/src/commands.rs',
    `        images: Vec<PromptImage>,\n        frames: FrameSink,`,
    `        images: Vec<PromptImage>,\n        skills: Vec<PromptSkill>,\n        frames: FrameSink,`,
  )
  await replaceOnce(
    'crates/agent-runtime/src/commands.rs',
    `            images,\n            frames,`,
    `            images,\n            skills,\n            frames,`,
  )
  await replaceOnce(
    'crates/agent-runtime/src/commands.rs',
    `    pub fn cancel(&self, session_id: String) -> Result<()> {\n        self.send(Command::Cancel { session_id })\n    }`,
    `    pub async fn cancel(&self, session_id: String) -> Result<()> {\n        let (reply, answer) = oneshot::channel();\n        self.send(Command::Cancel { session_id, reply })?;\n        answer\n            .await\n            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?\n    }`,
  )
  await replaceOnce(
    'crates/agent-runtime/src/commands.rs',
    `        value: String,\n    ) -> Result<oneshot::Receiver<Result<Vec<ConfigControl>>>> {`,
    `        value: String,\n        input: Option<String>,\n    ) -> Result<oneshot::Receiver<Result<Vec<ConfigControl>>>> {`,
  )
  await replaceOnce(
    'crates/agent-runtime/src/commands.rs',
    `            value,\n            reply,\n        })?;`,
    `            value,\n            input,\n            reply,\n        })?;`,
  )
  const activateMethodStart = `    /// Activates one skill on one session.`
  const activateMethodEnd = `    fn send(&self, command: Command) -> Result<()> {`
  const commands = await load('crates/agent-runtime/src/commands.rs')
  const begin = commands.indexOf(activateMethodStart)
  const end = commands.indexOf(activateMethodEnd)
  if (begin < 0 || end < begin) fail('commands.rs: activation method anchors missing')
  staged.set(
    'crates/agent-runtime/src/commands.rs',
    `${commands.slice(0, begin)}    pub async fn mcp_servers(&self) -> Result<Vec<McpServer>> {\n        let (reply, answer) = oneshot::channel();\n        self.send(Command::McpServers { reply })?;\n        answer\n            .await\n            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?\n    }\n\n${commands.slice(end)}`,
  )

  await replaceOnce(
    'crates/agent-runtime/src/session.rs',
    `/// kap 报的一条技能（protocol/skill.ts 的 skillDescriptorSchema）。`,
    `#[derive(Debug, Clone)]\npub enum McpTransport { Stdio, Http, Sse }\n\n#[derive(Debug, Clone)]\npub enum McpStatus { Connected, Connecting, Disconnected, Error }\n\n#[derive(Debug, Clone)]\npub struct McpServer {\n    pub id: String,\n    pub name: String,\n    pub transport: McpTransport,\n    pub status: McpStatus,\n    pub tool_count: u32,\n    pub last_error: Option<String>,\n}\n\n/// kap 报的一条技能（protocol/skill.ts 的 skillDescriptorSchema）。`,
  )
  await replaceOnce(
    'crates/agent-runtime/src/lib.rs',
    `pub use commands::{AgentClient, PromptImage};`,
    `pub use commands::{AgentClient, PromptImage, PromptSkill};`,
  )
  await replaceOnce(
    'crates/agent-runtime/src/lib.rs',
    `    AgentConnection, AgentSpawn, Cursor, Handshake, OpenedSession, SessionEntry, SessionEvent,\n    SessionEvents, Skill,`,
    `    AgentConnection, AgentSpawn, Cursor, Handshake, McpServer, McpStatus, McpTransport,\n    OpenedSession, SessionEntry, SessionEvent, SessionEvents, Skill,`,
  )

  await replaceOnce(
    'crates/agent-runtime/src/selection.rs',
    `    value: String,\n) -> Result<Vec<ConfigControl>> {\n    let answer = client.select(session_id.clone(), config_id.clone(), value.clone())?;`,
    `    value: String,\n    input: Option<String>,\n) -> Result<Vec<ConfigControl>> {\n    let answer = client.select(\n        session_id.clone(),\n        config_id.clone(),\n        value.clone(),\n        input,\n    )?;`,
  )
  await replaceOnce(
    'crates/agent-runtime/src/selection.rs',
    `        thinking_value.clone(),\n    )?;`,
    `        thinking_value.clone(),\n        None,\n    )?;`,
  )
  await replaceAll(
    'crates/agent-runtime/src/selection.rs',
    `                "deepseek".to_owned(),\n            )`,
    `                "deepseek".to_owned(),\n                None,\n            )`,
    1,
  )
  await replaceAll(
    'crates/agent-runtime/src/selection.rs',
    `                "plain".to_owned(),\n            )`,
    `                "plain".to_owned(),\n                None,\n            )`,
    1,
  )

  await replaceOnce(
    'crates/agent-runtime/src/driver.rs',
    `use crate::commands::{AgentClient, Command, PromptImage};`,
    `use crate::commands::{AgentClient, Command, PromptImage, PromptSkill};`,
  )
  await replaceOnce(
    'crates/agent-runtime/src/driver.rs',
    `    AgentConnection, AgentSpawn, Cursor, Handshake, OpenedSession, SessionEntry, SessionEvent,\n    SessionEvents, Skill,`,
    `    AgentConnection, AgentSpawn, Cursor, Handshake, McpServer, McpStatus, McpTransport,\n    OpenedSession, SessionEntry, SessionEvent, SessionEvents, Skill,`,
  )
  await replaceOnce(
    'crates/agent-runtime/src/driver.rs',
    `    /// 当前在飞的 prompt_id（若有）。\n    active_prompt_id: Option<String>,\n`,
    ``,
  )
  await replaceOnce(
    'crates/agent-runtime/src/driver.rs',
    `            active_prompt_id: None,\n`,
    ``,
  )
  await replaceOnce(
    'crates/agent-runtime/src/driver.rs',
    `        let mut stopping = false;\n\n        loop {\n            tokio::select! {\n                cmd = commands_rx.next(), if !stopping => {`,
    `        loop {\n            tokio::select! {\n                cmd = commands_rx.next() => {`,
  )
  await replaceOnce(
    'crates/agent-runtime/src/driver.rs',
    `                        None | Some(Command::Shutdown) => {\n                            stopping = true;\n                            kill_tree(&mut child).await;\n                        }`,
    `                        None | Some(Command::Shutdown) => {\n                            kill_tree(&mut child).await;\n                            break;\n                        }`,
  )
  const oldCancel = `                        Some(Command::Cancel { session_id: sid }) => {\n                            if let Some(state) = sessions.get(&sid)\n                                && let Some(prompt_id) = &state.active_prompt_id\n                            {\n                                let aborted = send_frame(&ws, "abort", json!({\n                                    "session_id": sid,\n                                    "prompt_id": prompt_id,\n                                }))\n                                .await;\n\n                                if let Err(error) = aborted {\n                                    log::warn!("the abort for {sid} never left: {error}");\n                                }\n                            }\n                        }`
  const newCancel = `                        Some(Command::Cancel { session_id: sid, reply }) => {\n                            let http2 = http.clone();\n                            let base2 = base_url.clone();\n                            tokio::spawn(async move {\n                                let result = abort_session(&http2, &base2, &sid).await;\n                                let _ = reply.send(result);\n                            });\n                        }`
  await replaceOnce('crates/agent-runtime/src/driver.rs', oldCancel, newCancel)
  await replaceOnce(
    'crates/agent-runtime/src/driver.rs',
    `Some(Command::Prompt { session_id: sid, text, images, frames, reply })`,
    `Some(Command::Prompt { session_id: sid, text, images, skills, frames, reply })`,
  )
  const oldPromptId = `                                    let prompt_id = Uuid::new_v4().to_string();\n                                    sessions\n                                        .entry(sid.clone())\n                                        .or_insert_with(SessionState::new)\n                                        .active_prompt_id = Some(prompt_id.clone());\n\n`
  await replaceOnce('crates/agent-runtime/src/driver.rs', oldPromptId, ``)
  await replaceOnce(
    'crates/agent-runtime/src/driver.rs',
    `                                            &http2, &base2, &sid2, &text, &images, &prompt_id,\n`,
    `                                            &http2, &base2, &sid2, &text, &images, &skills,\n`,
  )
  const oldActivateBranch = `                        Some(Command::ActivateSkill {\n                            session_id: sid,\n                            name,\n                            args,\n                            reply,\n                        }) => {\n                            let http2 = http.clone();\n                            let base2 = base_url.clone();\n                            tokio::spawn(async move {\n                                let result =\n                                    activate_skill(&http2, &base2, &sid, &name, &args).await;\n                                let _ = reply.send(result);\n                            });\n                        }\n\n`
  await replaceOnce(
    'crates/agent-runtime/src/driver.rs',
    oldActivateBranch,
    `                        Some(Command::McpServers { reply }) => {\n                            let http2 = http.clone();\n                            let base2 = base_url.clone();\n                            tokio::spawn(async move {\n                                let result = list_mcp_servers(&http2, &base2).await;\n                                let _ = reply.send(result);\n                            });\n                        }\n\n`,
  )
  await replaceOnce(
    'crates/agent-runtime/src/driver.rs',
    `Some(Command::Select { session_id: sid, config_id, value, reply })`,
    `Some(Command::Select { session_id: sid, config_id, value, input, reply })`,
  )
  await replaceOnce(
    'crates/agent-runtime/src/driver.rs',
    `set_selector(&http2, &base2, &sid, &config_id, &value)\n`,
    `set_selector(&http2, &base2, &sid, &config_id, &value, input.as_deref())\n`,
  )
  await replaceOnce(
    'crates/agent-runtime/src/driver.rs',
    `\n                    if stopping && sessions.values().all(|s| s.active_prompt_id.is_none()) {\n                        break;\n                    }`,
    ``,
  )
  await replaceAll(
    'crates/agent-runtime/src/driver.rs',
    `            state.active_prompt_id = None;\n`,
    ``,
    2,
  )
  const oldSubmit = `async fn submit_prompt(\n    http: &reqwest::Client,\n    base_url: &str,\n    session_id: &str,\n    text: &str,\n    images: &[PromptImage],\n    prompt_id: &str,\n) -> Result<String> {\n    let mut content: Vec<Value> = vec![];\n\n    if !text.is_empty() {\n        content.push(json!({ "type": "text", "text": text }));\n    }\n\n    for image in images {\n        // kap 的图像块（protocol/message.ts 的 imageContentSchema）。\n        content.push(json!({\n            "type": "image",\n            "source": {\n                "kind": "base64",\n                "media_type": image.mime_type,\n                "data": image.data,\n            }\n        }));\n    }\n\n    if content.is_empty() {\n        return Err(KapError::Transport {\n            message: "prompt has no content".into(),\n        });\n    }\n\n    let data = post(\n        http,\n        &format!("{base_url}/sessions/{session_id}/prompts"),\n        &json!({ "content": content, "prompt_id": prompt_id }),\n    )\n    .await?;\n\n    Ok(data\n        .get("prompt_id")\n        .and_then(Value::as_str)\n        .unwrap_or(prompt_id)\n        .to_owned())\n}`
  const newSubmit = `async fn submit_prompt(\n    http: &reqwest::Client,\n    base_url: &str,\n    session_id: &str,\n    text: &str,\n    images: &[PromptImage],\n    skills: &[PromptSkill],\n) -> Result<String> {\n    let body = prompt_body(text, images, skills)?;\n    let data = post(\n        http,\n        &format!("{base_url}/sessions/{session_id}/prompts"),\n        &body,\n    )\n    .await?;\n    data.get("prompt_id")\n        .and_then(Value::as_str)\n        .map(str::to_owned)\n        .ok_or_else(|| KapError::Transport {\n            message: format!("no prompt_id in prompt response: {data}"),\n        })\n}\n\nfn prompt_body(text: &str, images: &[PromptImage], skills: &[PromptSkill]) -> Result<Value> {\n    let mut content = Vec::new();\n    if !text.is_empty() {\n        content.push(json!({ "type": "text", "text": text }));\n    }\n    for image in images {\n        content.push(json!({\n            "type": "image",\n            "source": {\n                "kind": "base64",\n                "media_type": image.mime_type,\n                "data": image.data,\n            }\n        }));\n    }\n    if content.is_empty() {\n        return Err(KapError::Validation { message: "prompt has no content".to_owned() });\n    }\n    let activations: Vec<Value> = skills\n        .iter()\n        .map(|skill| match skill.args.as_deref().filter(|args| !args.is_empty()) {\n            Some(args) => json!({ "name": skill.name, "args": args }),\n            None => json!({ "name": skill.name }),\n        })\n        .collect();\n    if activations.is_empty() {\n        Ok(json!({ "content": content }))\n    } else {\n        Ok(json!({ "content": content, "skills": activations }))\n    }\n}`
  await replaceOnce('crates/agent-runtime/src/driver.rs', oldSubmit, newSubmit)

  const oldActivateFnStart = `/// 激活一条技能。动作后缀路由：POST /sessions/{id}/skills/{name}:activate。`
  const driverNow = await load('crates/agent-runtime/src/driver.rs')
  const activateStart = driverNow.indexOf(oldActivateFnStart)
  const selectorsStart = driverNow.indexOf(`async fn get_selectors(`, activateStart)
  if (activateStart < 0 || selectorsStart < 0) fail('driver.rs: old Skill activation helper missing')
  const mcpHelper = `async fn list_mcp_servers(\n    http: &reqwest::Client,\n    base_url: &str,\n) -> Result<Vec<McpServer>> {\n    let data = get(http, &format!("{base_url}/mcp/servers")).await?;\n    let listed = data.get("servers").and_then(Value::as_array).ok_or_else(|| {\n        KapError::Transport { message: "MCP response has no servers array".to_owned() }\n    })?;\n    listed.iter().map(|item| {\n        let required = |key: &str| item.get(key).and_then(Value::as_str).ok_or_else(|| {\n            KapError::Transport { message: format!("MCP server has no {key}: {item}") }\n        });\n        let transport = match required("transport")? {\n            "stdio" => McpTransport::Stdio,\n            "http" => McpTransport::Http,\n            "sse" => McpTransport::Sse,\n            other => return Err(KapError::Transport { message: format!("unknown MCP transport {other}") }),\n        };\n        let status = match required("status")? {\n            "connected" => McpStatus::Connected,\n            "connecting" => McpStatus::Connecting,\n            "disconnected" => McpStatus::Disconnected,\n            "error" => McpStatus::Error,\n            other => return Err(KapError::Transport { message: format!("unknown MCP status {other}") }),\n        };\n        let count = item.get("tool_count").and_then(Value::as_u64).ok_or_else(|| {\n            KapError::Transport { message: format!("MCP server has no tool_count: {item}") }\n        })?;\n        Ok(McpServer {\n            id: required("id")?.to_owned(),\n            name: required("name")?.to_owned(),\n            transport,\n            status,\n            tool_count: u32::try_from(count).map_err(|_| KapError::Transport {\n                message: format!("MCP tool_count is too large: {count}"),\n            })?,\n            last_error: item.get("last_error").and_then(Value::as_str).map(str::to_owned),\n        })\n    }).collect()\n}\n\nasync fn abort_session(http: &reqwest::Client, base_url: &str, session_id: &str) -> Result<()> {\n    post(\n        http,\n        &format!("{base_url}/sessions/{session_id}:abort"),\n        &json!({}),\n    )\n    .await?;\n    Ok(())\n}\n\n`
  staged.set(
    'crates/agent-runtime/src/driver.rs',
    `${driverNow.slice(0, activateStart)}${mcpHelper}${driverNow.slice(selectorsStart)}`,
  )

  const oldSelectors = `async fn get_selectors(\n    http: &reqwest::Client,\n    base_url: &str,\n    session_id: &str,\n) -> Result<Vec<ConfigControl>> {\n    let status = get(http, &format!("{base_url}/sessions/{session_id}/status")).await?;\n    let catalog = get(http, &format!("{base_url}/models")).await?;\n\n    Ok(controls(&status, &catalog))\n}\n\nasync fn set_selector(\n    http: &reqwest::Client,\n    base_url: &str,\n    session_id: &str,\n    config_id: &str,\n    value: &str,\n) -> Result<Vec<ConfigControl>> {\n    let patch = selector_patch(config_id, value).ok_or_else(|| KapError::Transport {\n        message: format!("the session offers no selector {config_id} with value {value}"),\n    })?;\n\n    post(\n        http,\n        &format!("{base_url}/sessions/{session_id}/profile"),\n        &json!({ "agent_config": patch }),\n    )\n    .await?;\n\n    get_selectors(http, base_url, session_id).await\n}`
  const newSelectors = `async fn get_selectors(\n    http: &reqwest::Client,\n    base_url: &str,\n    session_id: &str,\n) -> Result<Vec<ConfigControl>> {\n    let status = get(http, &format!("{base_url}/sessions/{session_id}/status")).await?;\n    let catalog = get(http, &format!("{base_url}/models")).await?;\n    let goal = get(http, &format!("{base_url}/sessions/{session_id}/goal")).await?;\n    Ok(controls(&status, &catalog, &goal))\n}\n\nasync fn set_selector(\n    http: &reqwest::Client,\n    base_url: &str,\n    session_id: &str,\n    config_id: &str,\n    value: &str,\n    input: Option<&str>,\n) -> Result<Vec<ConfigControl>> {\n    let current = get_selectors(http, base_url, session_id).await?;\n    let control = current.iter().find(|control| control.id == config_id).ok_or_else(|| {\n        KapError::Validation { message: format!("the session offers no control {config_id}") }\n    })?;\n    if control.current == value {\n        return Ok(current);\n    }\n    if !control.choices.iter().any(|choice| choice.value == value) {\n        return Err(KapError::Validation {\n            message: format!("control {config_id} does not offer {value}"),\n        });\n    }\n    let patch = selector_patch(config_id, value, input)?;\n    post(\n        http,\n        &format!("{base_url}/sessions/{session_id}/profile"),\n        &json!({ "agent_config": patch }),\n    )\n    .await?;\n    get_selectors(http, base_url, session_id).await\n}`
  await replaceOnce('crates/agent-runtime/src/driver.rs', oldSelectors, newSelectors)

  const cursorSend = `            let _sent = events_tx.unbounded_send(SessionEvent::Cursor {\n                session_id: session_id.to_owned(),\n                cursor: Cursor {\n                    seq,\n                    epoch: envelope\n                        .get("epoch")\n                        .and_then(Value::as_str)\n                        .map(str::to_owned),\n                },\n            });`
  await replaceOnce(
    'crates/agent-runtime/src/driver.rs',
    cursorSend,
    `${cursorSend}\n\n            let http = http.clone();\n            let base_url = base_url.to_owned();\n            let session_id = session_id.to_owned();\n            let events = events_tx.clone();\n            tokio::spawn(async move {\n                match get_selectors(&http, &base_url, &session_id).await {\n                    Ok(controls) => {\n                        let _sent = events.unbounded_send(SessionEvent::Selectors {\n                            session_id,\n                            controls,\n                        });\n                    }\n                    Err(error) => log::warn!("could not refresh session controls: {error}"),\n                }\n            });`,
  )
  const driverTail = await load('crates/agent-runtime/src/driver.rs')
  staged.set(
    'crates/agent-runtime/src/driver.rs',
    `${driverTail}\n\n#[cfg(test)]\nmod prompt_tests {\n    use super::*;\n\n    #[test]\n    fn bundled_skills_share_one_prompt_and_never_send_a_client_prompt_id() {\n        let body = prompt_body(\n            "review this",\n            &[],\n            &[PromptSkill { name: "research".to_owned(), args: None }],\n        )\n        .expect("prompt body");\n        assert!(body.get("prompt_id").is_none());\n        assert_eq!(body.get("skills").and_then(Value::as_array).map(Vec::len), Some(1));\n        assert_eq!(body.get("content").and_then(Value::as_array).map(Vec::len), Some(1));\n    }\n}\n`,
  )

  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/dto.rs',
    `/// A prompt, and how to start the agent if it is not running yet.`,
    `#[derive(Debug, Deserialize, Type)]\n#[serde(rename_all = "camelCase")]\npub struct AgentPromptSkill {\n    pub name: String,\n    pub args: Option<String>,\n}\n\n/// A prompt, and how to start the agent if it is not running yet.`,
  )
  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/dto.rs',
    `    pub assets: Vec<AgentPromptAsset>,\n    /// The conversation this turn belongs to, when the interface names one.`,
    `    pub assets: Vec<AgentPromptAsset>,\n    /// 与正文和附件同一次 prompt 提交的 Skill。\n    pub skills: Vec<AgentPromptSkill>,\n    /// The conversation this turn belongs to, when the interface names one.`,
  )
  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/dto.rs',
    `pub enum AgentConfigPurpose {\n    /// How much freedom the agent takes during a turn.\n    Mode,`,
    `pub enum AgentConfigPurpose {\n    /// How tool approvals are decided.\n    Permission,\n    /// Independent Plan, Goal and Swarm controls.\n    Mode,`,
  )
  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/dto.rs',
    `    pub value: String,\n}`,
    `    pub value: String,\n    /// Goal creation uses the current composer draft as its objective.\n    pub input: Option<String>,\n}`,
  )

  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/turn.rs',
    `use poietica_agent_runtime_native::{FrameSink, RecordedEvent};`,
    `use poietica_agent_runtime_native::{FrameSink, PromptSkill, RecordedEvent};`,
  )
  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/turn.rs',
    `    let attached = request.assets;\n`,
    `    let attached = request.assets;\n    let skills = request\n        .skills\n        .into_iter()\n        .map(|skill| PromptSkill { name: skill.name, args: skill.args })\n        .collect();\n`,
  )
  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/turn.rs',
    `.prompt(addressed.clone(), text, carried, frames)`,
    `.prompt(addressed.clone(), text, carried, skills, frames)`,
  )
  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/turn.rs',
    `    if live.book.slot(&addressed).map_err(translate)?.is_none() {\n        return Err(Error::NotFound(NOTHING_TO_STOP.to_owned()).into());\n    }\n\n    live.client.cancel(addressed).map_err(translate)?;`,
    `    let Some(slot) = live.book.slot(&addressed).map_err(translate)? else {\n        return Err(Error::NotFound(NOTHING_TO_STOP.to_owned()).into());\n    };\n    if !slot.is_listening() {\n        return Err(Error::NotFound(NOTHING_TO_STOP.to_owned()).into());\n    }\n\n    live.client.cancel(addressed).await.map_err(translate)?;`,
  )

  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/config.rs',
    `        value,\n    } = request;`,
    `        value,\n        input,\n    } = request;`,
  )
  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/config.rs',
    `    let offered = select_config(&live.client, addressed, config_id, value)`,
    `    let offered = select_config(&live.client, addressed, config_id, value, input)`,
  )
  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/config.rs',
    `        purpose: match control.purpose {\n            ConfigPurpose::Mode => AgentConfigPurpose::Mode,`,
    `        purpose: match control.purpose {\n            ConfigPurpose::Permission => AgentConfigPurpose::Permission,\n            ConfigPurpose::Mode => AgentConfigPurpose::Mode,`,
  )

  await overwrite(
    'apps/desktop/src-tauri/src/commands/agent/skill.rs',
    'pub struct AgentActivateSkillRequest',
    SKILL_RS,
  )
  await create('apps/desktop/src-tauri/src/commands/agent/mcp.rs', MCP_RS)
  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/mod.rs',
    `pub mod runtime;\npub mod skill;`,
    `pub mod runtime;\npub mod mcp;\npub mod skill;`,
  )

  await replaceOnce(
    'apps/desktop/src-tauri/src/ipc/mod.rs',
    `        AgentPromptRequest, AgentPromptResult, AgentQuestionAnswer, AgentQuestionChoice,`,
    `        AgentPromptRequest, AgentPromptResult, AgentPromptSkill, AgentQuestionAnswer, AgentQuestionChoice,`,
  )
  await replaceOnce(
    'apps/desktop/src-tauri/src/ipc/mod.rs',
    `    agent::skill::{AgentActivateSkillRequest, AgentSkill, AgentSkillsRequest},`,
    `    agent::mcp::{AgentMcpServer, AgentMcpStatus, AgentMcpTransport},\n    agent::skill::{AgentSkill, AgentSkillsRequest},`,
  )
  await replaceOnce(
    'apps/desktop/src-tauri/src/ipc/mod.rs',
    `            crate::commands::agent::skill::agent_skills,\n            crate::commands::agent::skill::agent_activate_skill,`,
    `            crate::commands::agent::skill::agent_skills,\n            crate::commands::agent::mcp::agent_mcp_servers,`,
  )
  await replaceOnce(
    'apps/desktop/src-tauri/src/ipc/mod.rs',
    `        .typ::<AgentPromptResult>()`,
    `        .typ::<AgentPromptResult>()\n        .typ::<AgentPromptSkill>()`,
  )
  await replaceOnce(
    'apps/desktop/src-tauri/src/ipc/mod.rs',
    `        .typ::<AgentSkill>()\n        .typ::<AgentSkillsRequest>()\n        .typ::<AgentActivateSkillRequest>()`,
    `        .typ::<AgentSkill>()\n        .typ::<AgentSkillsRequest>()\n        .typ::<AgentMcpServer>()\n        .typ::<AgentMcpStatus>()\n        .typ::<AgentMcpTransport>()`,
  )

  await replaceOnce(
    'packages/agent-contract/src/config.ts',
    `export type SessionConfigPurpose = 'model' | 'thought' | 'mode' | 'other'`,
    `export type SessionConfigPurpose = 'model' | 'thought' | 'permission' | 'mode' | 'other'`,
  )
  await replaceOnce(
    'packages/agent-contract/src/config.ts',
    `    value: string,\n  ) => Promise<readonly SessionConfigControl[]>`,
    `    value: string,\n    input?: string,\n  ) => Promise<readonly SessionConfigControl[]>`,
  )
  await replaceOnce(
    'packages/agent-contract/src/session.ts',
    `export interface AgentPromptRequest {`,
    `export interface PromptSkill {\n  readonly name: string\n  readonly args?: string | undefined\n}\n\nexport interface AgentPromptRequest {`,
  )
  await replaceOnce(
    'packages/agent-contract/src/session.ts',
    `  readonly assets: readonly PromptAsset[]\n}`,
    `  readonly assets: readonly PromptAsset[]\n  readonly skills: readonly PromptSkill[]\n}`,
  )
  await overwrite('packages/agent-contract/src/skill.ts', 'readonly activate:', CONTRACT_SKILL)
  await create('packages/agent-contract/src/mcp.ts', CONTRACT_MCP)
  await replaceOnce(
    'packages/agent-contract/src/index.ts',
    `export type { KapEventPayload, KapSessionId, KapStopReason, KapToolCallId } from './kap'`,
    `export type { KapEventPayload, KapSessionId, KapStopReason, KapToolCallId } from './kap'\nexport type { AgentMcpPort, AgentMcpServer, AgentMcpStatus, AgentMcpTransport } from './mcp'`,
  )
  await replaceOnce(
    'packages/agent-contract/src/index.ts',
    `  PromptAsset,\n} from './session'`,
    `  PromptAsset,\n  PromptSkill,\n} from './session'`,
  )

  await overwrite('packages/agent-ui/src/composer/prompt-chip.tsx', 'readonly #token', PROMPT_CHIP)
  await overwrite('packages/agent-ui/src/composer/prompt-chip.css', 'white-space: nowrap;', PROMPT_CHIP_CSS)
  await overwrite(
    'packages/agent-ui/src/composer/composer-actions.tsx',
    `heading: '命令'`,
    COMPOSER_ACTIONS,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/composer-palette.tsx',
    `  | { readonly kind: 'insert'; readonly snippet: string }\n  | { readonly kind: 'run'; readonly run: (args: string) => void }`,
    `  | { readonly kind: 'insert'; readonly chip: import('./prompt-chip').PromptChipValue }\n  | { readonly kind: 'run'; readonly run: (draft: string) => void }`,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/composer-palette.tsx',
    `\n  /** 斜杠过滤时拿来匹配的调用式。没有就不参与斜杠过滤。 */\n  readonly token?: string | undefined`,
    ``,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    `import type { ChatStatus } from '@poietica/agent-contract'`,
    `import type { ChatStatus, PromptSkill } from '@poietica/agent-contract'`,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    `  $createTextNode,\n  $getRoot,`,
    `  $createTextNode,\n  $getRoot,\n  $nodesOfType,`,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    `import { $createChipNode, ChipNode } from './prompt-chip'`,
    `import { $createChipNode, ChipNode, samePromptChip } from './prompt-chip'`,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    `  readonly assets: readonly ComposerAsset[]\n}`,
    `  readonly assets: readonly ComposerAsset[]\n  readonly skills: readonly PromptSkill[]\n}`,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    `  /** 在插入符处插入一段调用式或片段。 */\n  readonly insertSnippet: (snippet: string) => void\n`,
    ``,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    `interface DraftProjection {\n  readonly text: string\n  /** 插入符所在那一行到插入符为止的字：调用式与它的参数都在里面。 */\n  readonly line: string\n}\n\nconst EMPTY_PROJECTION: DraftProjection = { text: '', line: '' }`,
    `interface DraftProjection {\n  readonly text: string\n  readonly skills: readonly PromptSkill[]\n}\n\nconst EMPTY_PROJECTION: DraftProjection = { text: '', skills: [] }`,
  )
  const readDraftStart = `function readDraft(): DraftProjection {`
  const clearDraftStart = `function clearDraft(editor: LexicalEditor): void {`
  let promptInput = await load('packages/agent-ui/src/composer/prompt-input.tsx')
  let readStart = promptInput.indexOf(readDraftStart)
  let clearStart = promptInput.indexOf(clearDraftStart)
  if (readStart < 0 || clearStart < readStart) fail('prompt-input.tsx: readDraft anchors missing')
  const newReadDraft = `function readDraft(): DraftProjection {\n  const skills = new Map<string, PromptSkill>()\n  for (const node of $nodesOfType(ChipNode)) {\n    const value = node.value()\n    if (value.kind === 'skill') {\n      skills.set(value.name, {\n        name: value.name,\n        ...(value.args === undefined ? {} : { args: value.args }),\n      })\n    }\n  }\n  return { text: $getRoot().getTextContent(), skills: [...skills.values()] }\n}\n\n`
  promptInput = `${promptInput.slice(0, readStart)}${newReadDraft}${promptInput.slice(clearStart)}`
  staged.set('packages/agent-ui/src/composer/prompt-input.tsx', promptInput)
  promptInput = await load('packages/agent-ui/src/composer/prompt-input.tsx')
  const dropStart = promptInput.indexOf(`/** 吃掉插入符前那一段字`)
  const propsStart = promptInput.indexOf(`export interface PromptInputProps`, dropStart)
  if (dropStart < 0 || propsStart < 0) fail('prompt-input.tsx: slash helpers missing')
  staged.set(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    `${promptInput.slice(0, dropStart)}${promptInput.slice(propsStart)}`,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    `  const [paletteDismissed, setPaletteDismissed] = useState(false)\n`,
    ``,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    `    setPaletteDismissed(false)\n    setPaletteOpened(false)`,
    `    setPaletteOpened(false)`,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    `    setPaletteDismissed(false)\n    setHighlighted(0)`,
    `    setHighlighted(0)`,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    `    setPaletteOpened(false)\n    setPaletteDismissed(true)`,
    `    setPaletteOpened(false)`,
  )
  promptInput = await load('packages/agent-ui/src/composer/prompt-input.tsx')
  const snippetStart = promptInput.indexOf(`  const insertSnippet = useCallback(`)
  const requestStart = promptInput.indexOf(`  const requestSubmit = useCallback(`, snippetStart)
  if (snippetStart < 0 || requestStart < 0) fail('prompt-input.tsx: insertSnippet anchors missing')
  staged.set(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    `${promptInput.slice(0, snippetStart)}${promptInput.slice(requestStart)}`,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    `      togglePalette,\n      insertSnippet,`,
    `      togglePalette,`,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    `      insertSnippet,\n`,
    ``,
  )
  promptInput = await load('packages/agent-ui/src/composer/prompt-input.tsx')
  const slashProjection = promptInput.indexOf(`  /* 斜杠给同一张面板`)
  const pointerComment = promptInput.indexOf(`  /* 点到卡外就收面板`, slashProjection)
  if (slashProjection < 0 || pointerComment < 0) fail('prompt-input.tsx: palette projection anchors missing')
  const newPaletteProjection = `  const visible = allGroups\n  const rows = useMemo(() => visible.flatMap((group) => group.rows), [visible])\n  const paletteOpen = paletteOpened && rows.length > 0\n  const active = paletteOpen ? rows[highlighted] : undefined\n\n  const paletteAria = useMemo<PaletteAria>(\n    () => ({\n      listboxId,\n      expanded: paletteOpen,\n      activeId: active === undefined ? undefined : paletteOptionId(listboxId, active.id),\n    }),\n    [active, listboxId, paletteOpen],\n  )\n\n  const pickRow = useCallback(\n    (row: PaletteRow) => {\n      closePalette()\n      if (row.action.kind === 'run') {\n        row.action.run(draftText.text)\n        focusEditor()\n        return\n      }\n      editor.update(() => {\n        const selection = $getSelection()\n        if (!$isRangeSelection(selection)) return\n        const duplicate = $nodesOfType(ChipNode).some((node) =>\n          samePromptChip(node.value(), row.action.kind === 'insert' ? row.action.chip : { kind: 'skill', name: '' }),\n        )\n        if (!duplicate && row.action.kind === 'insert') {\n          selection.insertNodes([$createChipNode(row.action.chip), $createTextNode(' ')])\n        }\n      })\n      focusEditor()\n    },\n    [closePalette, draftText.text, editor, focusEditor],\n  )\n\n`
  staged.set(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    `${promptInput.slice(0, slashProjection)}${newPaletteProjection}${promptInput.slice(pointerComment)}`,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    `              onSubmit({ text: said, assets: attachments })`,
    `              onSubmit({ text: said, assets: attachments, skills: draftText.skills })`,
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    `  AgentSkill,\n  ChatStatus,`,
    `  AgentMcpServer,\n  AgentSkill,\n  ChatStatus,\n  PromptSkill,`,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    `    readonly assets: readonly ComposerAsset[]\n  }) => void`,
    `    readonly assets: readonly ComposerAsset[]\n    readonly skills: readonly PromptSkill[]\n  }) => void`,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    `  /** 激活一条技能，args 由斜杠那一行给。 */\n  readonly onActivateSkill: (name: string, args: string) => void\n  /** 这一段在进行的那个目标，真相在转录。 */\n  readonly goal?: string | undefined\n`,
    `  /** Kimi 检测到的 MCP server。 */\n  readonly mcpServers?: readonly AgentMcpServer[] | undefined\n`,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    `  readonly onSelectControl: (controlId: string, value: string) => void`,
    `  readonly onSelectControl: (controlId: string, value: string, input?: string) => void`,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    `  | 'goal'\n`,
    ``,
  )
  await replaceAll(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    `  goal,\n`,
    ``,
    2,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    `<ComposerChips controls={controls} goal={goal} onSelect={onSelectControl} swarm={swarm} />`,
    `<ComposerChips controls={controls} onSelect={onSelectControl} swarm={swarm} />`,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    `  onActivateSkill,\n  skills,`,
    `  mcpServers,\n  skills,`,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    `        onActivateSkill,\n        onSelectControl: toolbar.onSelectControl,\n        skills: skills ?? [],`,
    `        mcpServers: mcpServers ?? [],\n        onSelectControl: toolbar.onSelectControl,\n        skills: skills ?? [],`,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/assistant-composer.tsx',
    `[onActivateSkill, skills, toolbar.controls, toolbar.onSelectControl]`,
    `[mcpServers, skills, toolbar.controls, toolbar.onSelectControl]`,
  )

  await replaceOnce(
    'packages/agent-ui/src/session/use-assistant-session.ts',
    `  activeGoal,\n`,
    ``,
  )
  await replaceOnce(
    'packages/agent-ui/src/session/use-assistant-session.ts',
    `  PromptAsset,\n`,
    `  PromptAsset,\n  PromptSkill,\n`,
  )
  await replaceOnce(
    'packages/agent-ui/src/session/use-assistant-session.ts',
    `  readonly assets: readonly PromptAsset[]\n}`,
    `  readonly assets: readonly PromptAsset[]\n  readonly skills: readonly PromptSkill[]\n}`,
  )
  await replaceOnce(
    'packages/agent-ui/src/session/use-assistant-session.ts',
    `        text: submission.text,\n`,
    `        text: submission.text,\n        skills: submission.skills,\n`,
  )
  const assistantSession = await load('packages/agent-ui/src/session/use-assistant-session.ts')
  const goalHookStart = assistantSession.indexOf(`const readGoal =`)
  const swarmHookStart = assistantSession.indexOf(`const readSwarm =`, goalHookStart)
  const goalExportEnd = assistantSession.indexOf(`/** 此刻还在跑的子代理数。 */`, swarmHookStart)
  if (goalHookStart < 0 || swarmHookStart < 0 || goalExportEnd < 0) {
    fail('use-assistant-session.ts: goal projection anchors missing')
  }
  staged.set(
    'packages/agent-ui/src/session/use-assistant-session.ts',
    `${assistantSession.slice(0, goalHookStart)}${assistantSession.slice(swarmHookStart, goalExportEnd)}${assistantSession.slice(goalExportEnd)}`,
  )

  await replaceOnce(
    'packages/agent/src/session/transcript-store.ts',
    `  PromptAsset,\n`,
    `  PromptAsset,\n  PromptSkill,\n`,
  )
  await replaceOnce(
    'packages/agent/src/session/transcript-store.ts',
    `  readonly assets: readonly PromptAsset[]\n`,
    `  readonly assets: readonly PromptAsset[]\n  readonly skills: readonly PromptSkill[]\n`,
  )
  await replaceOnce(
    'packages/agent/src/session/transcript-store.ts',
    `  send = ({ assets, endpoint, identify, key, onUserMessage, port, text }: SendOptions): void => {`,
    `  send = ({ assets, endpoint, identify, key, onUserMessage, port, skills, text }: SendOptions): void => {`,
  )
  await replaceOnce(
    'packages/agent/src/session/transcript-store.ts',
    `        return port.prompt({ threadId, text, assets }).then((handle) => {`,
    `        return port.prompt({ threadId, text, assets, skills }).then((handle) => {`,
  )

  await overwrite(
    'packages/agent-contract/src/skill.ts',
    'readonly activate:',
    CONTRACT_SKILL,
  )
  await deleteFile('packages/agent-ui/src/composer/posture-memory.ts', 'usePostureMemory')
  await replaceOnce(
    'packages/agent-ui/src/composer/permission-picker.tsx',
    `import { usePostureMemory } from './posture-memory'\n`,
    ``,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/permission-picker.tsx',
    `  const rememberedPosture = usePostureMemory(controls)\n`,
    ``,
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/permission-picker.tsx',
    `  const currentPosture = rememberedPosture ?? control.current`,
    `  const currentPosture = control.current`,
  )

  await replaceOnce(
    'packages/agent/src/session/permission-posture.ts',
    `return controls.find((control) => control.purpose === 'mode')`,
    `return controls.find((control) => control.purpose === 'permission')`,
  )

  const timelineQueries = await load('packages/agent/src/timeline/timeline-queries.ts')
  const activeStart = timelineQueries.indexOf(`/**\n * 这一段在哪个目标下。`)
  const delegationsStart = timelineQueries.indexOf(`/**\n * 此刻还在跑的子代理数`, activeStart)
  if (activeStart < 0 || delegationsStart < 0) fail('timeline-queries.ts: active goal anchors missing')
  staged.set(
    'packages/agent/src/timeline/timeline-queries.ts',
    `${timelineQueries.slice(0, activeStart)}${timelineQueries.slice(delegationsStart)}`,
  )
  await replaceAll('packages/agent/src/timeline/index.ts', `  activeGoal,\n`, ``, 1)
  await replaceAll('packages/agent/src/index.ts', `  activeGoal,\n`, ``, 1)

  const modeStateCss = `\n/* 只读的那两枚：协议没有关掉目标与蜂群的动作，所以它们不当控件画。 */\n.assistant-mode-chip--state {\n  cursor: default;\n}\n\n.assistant-mode-chip--state:hover {\n  background: transparent;\n}\n\n.assistant-mode-chip--state:hover .assistant-mode-chip__glyph {\n  visibility: visible;\n}\n`
  await replaceOnce('packages/agent-ui/src/composer/composer-actions.css', modeStateCss, `\n`)

  await replaceOnce(
    'packages/agent/src/session/session-controls-store.ts',
    `  AgentSkill,\n  AgentSkillPort,`,
    `  AgentMcpPort,\n  AgentMcpServer,\n  AgentSkill,\n  AgentSkillPort,`,
  )
  await replaceOnce(
    'packages/agent/src/session/session-controls-store.ts',
    `  readonly skills: ReadonlyMap<string, readonly AgentSkill[]>\n`,
    `  readonly skills: ReadonlyMap<string, readonly AgentSkill[]>\n  readonly mcpServers: readonly AgentMcpServer[] | undefined\n`,
  )
  await replaceOnce(
    'packages/agent/src/session/session-controls-store.ts',
    `  skills: new Map(),\n  usage: new Map(),`,
    `  skills: new Map(),\n  mcpServers: undefined,\n  usage: new Map(),`,
  )
  await replaceOnce(
    'packages/agent/src/session/session-controls-store.ts',
    `  readonly skills?: AgentSkillPort | undefined\n`,
    `  readonly skills?: AgentSkillPort | undefined\n  readonly mcp?: AgentMcpPort | undefined\n`,
  )
  await replaceOnce(
    'packages/agent/src/session/session-controls-store.ts',
    `  readonly #skills: AgentSkillPort | undefined\n`,
    `  readonly #skills: AgentSkillPort | undefined\n\n  readonly #mcp: AgentMcpPort | undefined\n\n  #mcpAsked = false\n`,
  )
  await replaceOnce(
    'packages/agent/src/session/session-controls-store.ts',
    `    skills,\n    transcripts,`,
    `    skills,\n    mcp,\n    transcripts,`,
  )
  await replaceOnce(
    'packages/agent/src/session/session-controls-store.ts',
    `    this.#skills = skills\n`,
    `    this.#skills = skills\n    this.#mcp = mcp\n`,
  )
  await replaceOnce(
    'packages/agent/src/session/session-controls-store.ts',
    `  skillsOf = (threadId: string): readonly AgentSkill[] | undefined =>\n    this.#held.skills.get(threadId)\n`,
    `  skillsOf = (threadId: string): readonly AgentSkill[] | undefined =>\n    this.#held.skills.get(threadId)\n\n  mcpServers = (): readonly AgentMcpServer[] | undefined => this.#held.mcpServers\n\n  loadMcpServers = (): void => {\n    if (this.#mcpAsked || this.#mcp === undefined) return\n    this.#mcpAsked = true\n    void this.#mcp\n      .list()\n      .then((servers) => {\n        this.#commit({ mcpServers: servers })\n      })\n      .catch((reason: unknown) => {\n        this.#mcpAsked = false\n        this.#report?.changeFailed(reason)\n      })\n  }\n`,
  )
  let controlsStore = await load('packages/agent/src/session/session-controls-store.ts')
  const activationStart = controlsStore.indexOf(`  /**\n   * 激活一条技能。`)
  const openedStart = controlsStore.indexOf(`  /**\n   * 一份答复到手`, activationStart)
  if (activationStart < 0 || openedStart < 0) fail('session-controls-store.ts: activation anchors missing')
  staged.set(
    'packages/agent/src/session/session-controls-store.ts',
    `${controlsStore.slice(0, activationStart)}${controlsStore.slice(openedStart)}`,
  )
  await replaceOnce(
    'packages/agent/src/session/session-controls-store.ts',
    `  selectControl = (threadId: string, controlId: string, value: string): void => {`,
    `  selectControl = (threadId: string, controlId: string, value: string, input?: string): void => {`,
  )
  await replaceOnce(
    'packages/agent/src/session/session-controls-store.ts',
    `    if (control?.purpose === 'mode') {\n      this.#posture?.write(value)\n      this.#alignedTo.set(threadId, value)\n    }\n\n    this.#dispatch(threadId, controlId, value)`,
    `    if (control?.purpose === 'permission' && permissionPostureOf(value) !== undefined) {\n      this.#posture?.write(value)\n      this.#alignedTo.set(threadId, value)\n    }\n\n    this.#dispatch(threadId, controlId, value, input)`,
  )
  await replaceOnce(
    'packages/agent/src/session/session-controls-store.ts',
    `  #dispatch(threadId: string, controlId: string, value: string): void {`,
    `  #dispatch(threadId: string, controlId: string, value: string, input?: string): void {`,
  )
  await replaceOnce(
    'packages/agent/src/session/session-controls-store.ts',
    `        const offered = await config.select(threadId, controlId, value)`,
    `        const offered = await config.select(threadId, controlId, value, input)`,
  )
  await replaceOnce(
    'packages/agent/src/session/session-controls-store.ts',
    `      next.skills === this.#held.skills &&\n      next.usage === this.#held.usage`,
    `      next.skills === this.#held.skills &&\n      next.mcpServers === this.#held.mcpServers &&\n      next.usage === this.#held.usage`,
  )

  await replaceOnce(
    'packages/agent-ui/src/session/session-controls-context.ts',
    `import type { AgentSkill, SessionConfigControl, SessionUsage }`,
    `import type { AgentMcpServer, AgentSkill, SessionConfigControl, SessionUsage }`,
  )
  let context = await load('packages/agent-ui/src/session/session-controls-context.ts')
  const hookStart = context.indexOf(`/** 激活这条对话上的一条技能`)
  const usageStart = context.indexOf(`/** 这条对话背后那个会话最近报的上下文用量`, hookStart)
  if (hookStart < 0 || usageStart < 0) fail('session-controls-context.ts: activation hook anchors missing')
  const mcpHook = `/** Kimi 当前检测到的 MCP 名册；失败与尚未读取都是 undefined。 */\nexport function useMcpServers(): readonly AgentMcpServer[] | undefined {\n  const store = useContext(SessionControlsContext)\n  const read = useCallback(() => store?.mcpServers(), [store])\n\n  useEffect(() => {\n    store?.loadMcpServers()\n  }, [store])\n\n  return useSyncExternalStore(store?.subscribe ?? NO_SUBSCRIPTION, read, read)\n}\n\n`
  context = `${context.slice(0, hookStart)}${mcpHook}${context.slice(usageStart)}`
  context = context.replace(
    `import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'`,
    `import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react'`,
  )
  staged.set('packages/agent-ui/src/session/session-controls-context.ts', context)

  await replaceOnce(
    'packages/agent-ui/src/surface/assistant-surface.tsx',
    `import { useSkillActivation, useThreadSkills } from '../session/session-controls-context'`,
    `import { useMcpServers, useThreadSkills } from '../session/session-controls-context'`,
  )
  await replaceOnce(
    'packages/agent-ui/src/surface/assistant-surface.tsx',
    `  useAssistantGoal,\n`,
    ``,
  )
  await replaceOnce(
    'packages/agent-ui/src/surface/assistant-surface.tsx',
    `  readonly onSelectControl: (controlId: string, value: string) => void`,
    `  readonly onSelectControl: (controlId: string, value: string, input?: string) => void`,
  )
  await replaceOnce(
    'packages/agent-ui/src/surface/assistant-surface.tsx',
    `  const skills = useThreadSkills(endpoint)\n  const activateSkill = useSkillActivation(endpoint)`,
    `  const skills = useThreadSkills(endpoint)\n  const mcpServers = useMcpServers()`,
  )
  await replaceOnce(
    'packages/agent-ui/src/surface/assistant-surface.tsx',
    `  const goal = useAssistantGoal(assistant.key)\n`,
    ``,
  )
  await replaceOnce(
    'packages/agent-ui/src/surface/assistant-surface.tsx',
    `        goal={goal}\n        onActivateSkill={activateSkill}\n`,
    `        mcpServers={mcpServers}\n`,
  )

  await replaceOnce(
    'packages/agent-ui/src/index.ts',
    `  useSkillActivation,\n`,
    `  useMcpServers,\n`,
  )

  await replaceOnce(
    'packages/ipc/src/agent.ts',
    `  AgentCapabilityPort,\n`,
    `  AgentCapabilityPort,\n  AgentMcpPort,\n`,
  )
  await replaceOnce(
    'packages/ipc/src/agent.ts',
    `  type AgentLaunch,\n`,
    `  type AgentLaunch,\n  type AgentMcpServer,\n`,
  )
  await replaceOnce(
    'packages/ipc/src/agent.ts',
    `          assets: request.assets.map((asset) => ({`,
    `          skills: request.skills.map((skill) => ({\n            name: skill.name,\n            args: skill.args ?? null,\n          })),\n          assets: request.assets.map((asset) => ({`,
  )
  await replaceOnce(
    'packages/ipc/src/agent.ts',
    `    select: async (threadId, configId, value) => {`,
    `    select: async (threadId, configId, value, input) => {`,
  )
  await replaceOnce(
    'packages/ipc/src/agent.ts',
    `          value,\n        }),`,
    `          value,\n          input: input ?? null,\n        }),`,
  )
  await replaceOnce(
    'packages/ipc/src/agent.ts',
    `          value,\n        }),\n      )\n\n      return offered.map(controlOf)\n    },\n\n    /* 报文里那条会话是谁`,
    `          value,\n          input: null,\n        }),\n      )\n\n      return offered.map(controlOf)\n    },\n\n    /* 报文里那条会话是谁`,
  )
  let ipcAgent = await load('packages/ipc/src/agent.ts')
  const oldBridgeStart = ipcAgent.indexOf(`export function createAgentSkillBridge(): AgentSkillPort {`)
  if (oldBridgeStart < 0) fail('packages/ipc/src/agent.ts: Skill bridge missing')
  ipcAgent = ipcAgent.slice(0, oldBridgeStart) + `export function createAgentSkillBridge(): AgentSkillPort {\n  return {\n    list: async (sessionId) => {\n      const listed = await throughIpc(() => commands.agentSkills({ sessionId }))\n      return listed as readonly AgentSkill[]\n    },\n  }\n}\n\nexport function createAgentMcpBridge({ launch, cwd }: AgentBridgeOptions): AgentMcpPort {\n  return {\n    list: async () => {\n      const listed = await throughIpc(() =>\n        commands.agentMcpServers({ launch: await launch(), cwd: cwd?.() ?? null }),\n      )\n      return listed.map((server: AgentMcpServer) => ({\n        id: server.id,\n        name: server.name,\n        transport: server.transport,\n        status: server.status,\n        toolCount: server.toolCount,\n        ...(server.lastError === null ? {} : { lastError: server.lastError }),\n      }))\n    },\n  }\n}\n`
  staged.set('packages/ipc/src/agent.ts', ipcAgent)
  await replaceOnce(
    'packages/ipc/src/index.ts',
    `  createAgentCapabilityBridge,\n`,
    `  createAgentCapabilityBridge,\n  createAgentMcpBridge,\n`,
  )

  await replaceOnce(
    'apps/desktop/src/assistant/agent-runtime.ts',
    `  AgentCapabilityPort,\n`,
    `  AgentCapabilityPort,\n  AgentMcpPort,\n`,
  )
  await replaceOnce(
    'apps/desktop/src/assistant/agent-runtime.ts',
    `  createAgentCapabilityBridge,\n`,
    `  createAgentCapabilityBridge,\n  createAgentMcpBridge,\n`,
  )
  await replaceOnce(
    'apps/desktop/src/assistant/agent-runtime.ts',
    `  readonly skills: AgentSkillPort\n`,
    `  readonly skills: AgentSkillPort\n  readonly mcp: AgentMcpPort\n`,
  )
  await replaceOnce(
    'apps/desktop/src/assistant/agent-runtime.ts',
    `  const skills = createAgentSkillBridge()\n`,
    `  const skills = createAgentSkillBridge()\n  const mcp = createAgentMcpBridge({ cwd: options.cwd, launch: launchSelected })\n`,
  )
  await replaceOnce(
    'apps/desktop/src/assistant/agent-runtime.ts',
    `    skills,\n    permissionPosture,`,
    `    skills,\n    mcp,\n    permissionPosture,`,
  )

  await replaceOnce(
    'apps/desktop/src/assistant/threads-provider.tsx',
    `'permissionPosture' | 'sessionConfig' | 'sessionUsage' | 'skills' | 'threads'`,
    `'mcp' | 'permissionPosture' | 'sessionConfig' | 'sessionUsage' | 'skills' | 'threads'`,
  )
  await replaceOnce(
    'apps/desktop/src/assistant/threads-provider.tsx',
    `        skills: agent.skills,\n`,
    `        skills: agent.skills,\n        mcp: agent.mcp,\n`,
  )

  await replaceOnce(
    'apps/desktop/src/workbench/conversation-surface.tsx',
    `    (controlId: string, value: string) => {\n      if (threadId === null) {\n        selectControl(controlId, value)\n\n        return\n      }\n\n      sessionControls.selectControl(threadId, controlId, value)\n    },\n    [selectControl, sessionControls, threadId],`,
    `    (controlId: string, value: string, input?: string) => {\n      const control = controls.find((candidate) => candidate.id === controlId)\n      if (threadId === null && control?.purpose === 'mode') {\n        void onIdentify?.().then((identified) => {\n          if (identified !== null && identified !== undefined) {\n            sessionControls.selectControl(identified, controlId, value, input)\n          }\n        })\n        return\n      }\n      if (threadId === null) {\n        selectControl(controlId, value)\n        return\n      }\n      sessionControls.selectControl(threadId, controlId, value, input)\n    },\n    [controls, onIdentify, selectControl, sessionControls, threadId],`,
  )

  await replaceOnce(
    'packages/agent-ui/src/index.ts',
    `export type { ChatStatus, PromptInputHandle, PromptInputMessage } from './composer/prompt-input'`,
    `export type { ChatStatus, PromptInputHandle, PromptInputMessage } from './composer/prompt-input'\nexport type { PromptChipValue } from './composer/prompt-chip'`,
  )

  await assertForbiddenAbsent()
}

let changed = false
try {
  await apply()
  for (const [path, content] of staged) {
    if (originals.get(path) !== content) changed = true
  }
  if (removed.size > 0) changed = true
  if (!changed) {
    console.log('Kimi mode, Skill, MCP and chip refactor is already applied.')
    process.exit(0)
  }

  await snapshotRust()
  for (const [path, content] of staged) {
    if (originals.get(path) !== content) await atomicWrite(path, content)
  }
  for (const path of removed) await rm(resolve(ROOT, path), { force: true })

  run('pnpm', ['ipc:generate'])
  run('cargo', ['fmt', '--all'])
  const web = [...staged.keys()].filter((path) => ['.ts', '.tsx', '.css'].includes(extname(path)))
  if (web.length > 0) run('pnpm', ['exec', 'biome', 'check', '--write', ...web])
  run('cargo', ['test', '-p', 'poietica-agent-runtime-native'])
  run('pnpm', ['--filter', '@poietica/agent', 'test'])
  run('pnpm', ['--filter', '@poietica/agent-ui', 'test'])
  run('pnpm', ['kap:spec:check'])
  run('pnpm', ['check'])

  const generated = await readFile(resolve(ROOT, GENERATED), 'utf8')
  for (const token of ['agentActivateSkill', 'AgentActivateSkillRequest']) {
    if (generated.includes(token)) fail(`${GENERATED}: stale generated symbol ${token}`)
  }
  console.log('Applied and verified the Kimi mode, Skill, MCP and chip refactor.')
} catch (error) {
  if (changed) {
    try {
      await rollback()
      console.error('Refactor failed; source files were restored.')
    } catch (rollbackError) {
      console.error('Refactor failed and rollback also failed:', rollbackError)
    }
  }
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
}
