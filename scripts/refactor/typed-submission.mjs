export function migrateTypedSubmission(m) {
  const parser = `import type { AgentPromptIntent } from '@poietica/agent-contract'\n\nconst MAX_GOAL_OBJECTIVE_LENGTH = 4_000\n\nexport interface ParsedPromptIntent {\n  readonly intent: AgentPromptIntent\n  readonly text: string\n}\n\nexport function parsePromptIntent(input: string): ParsedPromptIntent {\n  const text = input.trim()\n  const goal = argument(text, '/goal')\n  if (goal !== undefined) {\n    if (goal.length === 0) throw new Error('请输入目标，例如 /goal 发布新版本。')\n    if (goal.length > MAX_GOAL_OBJECTIVE_LENGTH) throw new Error('目标不能超过 4000 个字符；请把长内容放进文件并引用路径。')\n    return { intent: 'goal', text: goal }\n  }\n  const swarm = argument(text, '/swarm')\n  if (swarm !== undefined) {\n    if (swarm.length === 0) throw new Error('请输入蜂群任务，例如 /swarm 并行审查模块。')\n    return { intent: 'swarm', text: swarm }\n  }\n  return { intent: 'normal', text }\n}\n\nfunction argument(text: string, command: string): string | undefined {\n  if (text === command) return ''\n  return text.startsWith(\`${'${command}'} \`) ? text.slice(command.length + 1).trim() : undefined\n}\n`
  m.write('packages/agent/src/session/prompt-intent.ts', parser)

  const contract = 'packages/agent-contract/src/session.ts'
  m.replace(contract, `export interface AgentPromptRequest {`, `export type AgentPromptIntent = 'normal' | 'goal' | 'swarm'\n\nexport interface AgentPromptRequest {`)
  m.replace(contract, `  readonly threadId: ThreadId\n  readonly text: string`, `  readonly threadId: ThreadId\n  readonly intent: AgentPromptIntent\n  readonly text: string`)
  m.replace('packages/agent-contract/src/index.ts', `  AgentSessionPort,\n  PromptAsset,`, `  AgentPromptIntent,\n  AgentSessionPort,\n  PromptAsset,`)

  const store = 'packages/agent/src/session/transcript-store.ts'
  m.replace(store, `import { describeFailure } from './describe-failure'`, `import { describeFailure } from './describe-failure'\nimport { parsePromptIntent } from './prompt-intent'`)
  m.replace(
    store,
    `  send = ({ assets, endpoint, identify, key, onUserMessage, port, text }: SendOptions): void => {\n    const at = Date.now()`,
    `  send = ({ assets, endpoint, identify, key, onUserMessage, port, text }: SendOptions): void => {\n    let parsed: ReturnType<typeof parsePromptIntent>\n    try {\n      parsed = parsePromptIntent(text)\n    } catch (cause) {\n      this.note(key, describeFailure(cause))\n      return\n    }\n    const said = parsed.text\n    const at = Date.now()`,
  )
  m.replace(store, `appendUserMessage(current.timeline, text, at, assets.length)`, `appendUserMessage(current.timeline, said, at, assets.length)`)
  m.replace(store, `        onUserMessage?.(threadId, text.trim() === '' && assets.length > 0 ? IMAGE_OPENER : text)\n\n`, ``)
  m.replace(
    store,
    `        return port.prompt({ threadId, text, assets }).then((handle) => {`,
    `        return port.prompt({ threadId, intent: parsed.intent, text: said, assets }).then((handle) => {\n          onUserMessage?.(\n            threadId,\n            said === '' && assets.length > 0 ? IMAGE_OPENER : said,\n          )`,
  )

  m.replace('packages/ipc/src/agent.ts', `          text: request.text,\n          threadId: request.threadId,`, `          intent: request.intent,\n          text: request.text,\n          threadId: request.threadId,`)

  const dto = 'apps/desktop/src-tauri/src/commands/agent/dto.rs'
  m.replace(dto, `/// A prompt, and how to start the agent if it is not running yet.\n#[derive(Debug, Deserialize, Type)]`, `#[derive(Debug, Clone, Copy, Deserialize, Type)]\n#[serde(rename_all = \"snake_case\")]\npub enum AgentPromptIntent { Normal, Goal, Swarm }\n\n/// A prompt, and how to start the agent if it is not running yet.\n#[derive(Debug, Deserialize, Type)]`)
  m.replace(dto, `pub struct AgentPromptRequest {\n    /// What the user typed.`, `pub struct AgentPromptRequest {\n    pub intent: AgentPromptIntent,\n    /// What the user typed.`)

  m.replace('crates/agent-runtime/src/session.rs', `/// A session the agent just opened, and the selectors it offers for it.`, `#[derive(Debug, Clone, Copy)]\npub enum PromptIntent { Normal, Goal, Swarm }\n\n/// A session the agent just opened, and the selectors it offers for it.`)
  m.replace('crates/agent-runtime/src/lib.rs', `    AgentConnection, AgentSpawn, Cursor, Handshake, OpenedSession, SessionEntry, SessionEvent,`, `    AgentConnection, AgentSpawn, Cursor, Handshake, OpenedSession, PromptIntent, SessionEntry, SessionEvent,`)

  const commands = 'crates/agent-runtime/src/commands.rs'
  m.replace(commands, `use crate::session::{Cursor, OpenedSession, SessionEntry, Skill};`, `use crate::session::{Cursor, OpenedSession, PromptIntent, SessionEntry, Skill};`)
  m.replace(commands, `    Prompt {\n        /// The session this turn belongs to.`, `    PreparePrompt { session_id: String, intent: PromptIntent, text: String, reply: oneshot::Sender<Result<()>> },\n    Prompt {\n        /// The session this turn belongs to.`)
  m.replace(commands, `    /// Starts a turn, delivering every frame of it to the sink handed in.`, `    pub async fn prepare_prompt(&self, session_id: String, intent: PromptIntent, text: String) -> Result<()> {\n        let (reply, answer) = oneshot::channel();\n        self.send(Command::PreparePrompt { session_id, intent, text, reply })?;\n        answer.await.map_err(|_dropped| KapError::Refused(Refusal::Gone))?\n    }\n\n    /// Starts a turn, delivering every frame of it to the sink handed in.`)

  const turn = 'apps/desktop/src-tauri/src/commands/agent/turn.rs'
  m.replace(turn, `use poietica_agent_runtime_native::{FrameSink, RecordedEvent};`, `use poietica_agent_runtime_native::{FrameSink, PromptIntent, RecordedEvent};`)
  m.replace(turn, `    AgentPromptRequest, AgentPromptResult, AgentResolvePermissionRequest, answered, decided,`, `    AgentPromptIntent, AgentPromptRequest, AgentPromptResult, AgentResolvePermissionRequest,\n    answered, decided,`)
  m.replace(turn, `    let thread_id = held.thread_id;\n    let addressed = held.session_id;\n\n    // The first thing said names`, `    let thread_id = held.thread_id;\n    let addressed = held.session_id;\n\n    session.client.prepare_prompt(\n        addressed.clone(),\n        match request.intent {\n            AgentPromptIntent::Normal => PromptIntent::Normal,\n            AgentPromptIntent::Goal => PromptIntent::Goal,\n            AgentPromptIntent::Swarm => PromptIntent::Swarm,\n        },\n        text.clone(),\n    ).await.map_err(translate)?;\n\n    // The first thing said names`)

  const driver = 'crates/agent-runtime/src/driver.rs'
  m.replace(driver, `    SessionEvents, Skill,`, `    PromptIntent, SessionEvents, Skill,`)
  m.replace(driver, `                        Some(Command::Prompt { session_id: sid, text, images, frames, reply }) => {`, `                        Some(Command::PreparePrompt { session_id: sid, intent, text, reply }) => {\n                            let http2 = http.clone();\n                            let base2 = base_url.clone();\n                            tokio::spawn(async move {\n                                let result = prepare_prompt(&http2, &base2, &sid, intent, &text).await;\n                                let _ = reply.send(result);\n                            });\n                        }\n\n                        Some(Command::Prompt { session_id: sid, text, images, frames, reply }) => {`)
  m.replace(driver, `async fn submit_prompt(`, `async fn prepare_prompt(http: &reqwest::Client, base_url: &str, session_id: &str, intent: PromptIntent, text: &str) -> Result<()> {\n    let patch = match intent {\n        PromptIntent::Normal => return Ok(()),\n        PromptIntent::Goal => json!({ \"goal_objective\": text }),\n        PromptIntent::Swarm => json!({ \"swarm_mode\": true }),\n    };\n    post(http, &format!(\"{base_url}/sessions/{session_id}/profile\"), &json!({ \"agent_config\": patch })).await?;\n    Ok(())\n}\n\nasync fn submit_prompt(`)

  m.write('packages/agent/src/session/prompt-intent.test.ts', `import { describe, expect, it } from 'vitest'\nimport { parsePromptIntent } from './prompt-intent'\n\ndescribe('parsePromptIntent', () => {\n  it('types goal and swarm commands', () => {\n    expect(parsePromptIntent('/goal ship')).toEqual({ intent: 'goal', text: 'ship' })\n    expect(parsePromptIntent('/swarm audit')).toEqual({ intent: 'swarm', text: 'audit' })\n  })\n  it('leaves similar ordinary text alone', () => {\n    expect(parsePromptIntent('/goalkeeper')).toEqual({ intent: 'normal', text: '/goalkeeper' })\n  })\n  it('rejects empty structured commands', () => {\n    expect(() => parsePromptIntent('/goal')).toThrow()\n    expect(() => parsePromptIntent('/swarm')).toThrow()\n  })\n})\n`)
}
