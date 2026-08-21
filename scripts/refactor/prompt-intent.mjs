export function migratePromptIntent(m) {
  const parser = `import type { AgentPromptIntent } from '@poietica/agent-contract'\n\nconst MAX_GOAL_OBJECTIVE_LENGTH = 4_000\n\nexport interface ParsedPromptIntent {\n  readonly intent: AgentPromptIntent\n  readonly text: string\n}\n\nexport function parsePromptIntent(input: string): ParsedPromptIntent {\n  const text = input.trim()\n  const goal = argument(text, '/goal')\n  if (goal !== undefined) {\n    if (goal.length === 0) throw new Error('请输入目标，例如 /goal 发布新版本。')\n    if (goal.length > MAX_GOAL_OBJECTIVE_LENGTH) {\n      throw new Error('目标不能超过 4000 个字符；请把长内容放进文件并引用路径。')\n    }\n    return { intent: 'goal', text: goal }\n  }\n  const swarm = argument(text, '/swarm')\n  if (swarm !== undefined) {\n    if (swarm.length === 0) throw new Error('请输入蜂群任务，例如 /swarm 并行审查模块。')\n    return { intent: 'swarm', text: swarm }\n  }\n  return { intent: 'normal', text }\n}\n\nfunction argument(text: string, command: string): string | undefined {\n  if (text === command) return ''\n  return text.startsWith(\`${'${command}'} \`) ? text.slice(command.length + 1).trim() : undefined\n}\n`
  m.write('packages/agent/src/session/prompt-intent.ts', parser)

  const contract = 'packages/agent-contract/src/session.ts'
  m.replace(contract, `export interface PromptRequest {`, `export type AgentPromptIntent = 'normal' | 'goal' | 'swarm'\n\nexport interface PromptRequest {`)
  m.replace(contract, `  readonly sessionId: string\n  readonly text: string`, `  readonly sessionId: string\n  readonly intent: AgentPromptIntent\n  readonly text: string`)
  m.replace('packages/agent-contract/src/index.ts', `  AgentSessionPort,\n  PromptAsset,`, `  AgentPromptIntent,\n  AgentSessionPort,\n  PromptAsset,`)

  const store = 'packages/agent/src/session/transcript-store.ts'
  m.replace(store, `import { createTimelineState } from '../timeline/timeline-reducer'`, `import { createTimelineState } from '../timeline/timeline-reducer'\nimport { parsePromptIntent } from './prompt-intent'`)
  m.replace(
    store,
    `    /* 在拿走附件、记标题与插进转录之前，先把所有会失败的前置动作做完。 */\n    let sessionId: string`,
    `    /* 领域命令先解析成类型；失败时不记标题、不接管附件，也不发送普通 prompt。 */\n    let parsed: ReturnType<typeof parsePromptIntent>\n    try {\n      parsed = parsePromptIntent(said)\n    } catch (cause) {\n      this.#failLocal(key, describeFailure(cause), false)\n      return\n    }\n    said = parsed.text\n\n    /* 在拿走附件、记标题与插进转录之前，先把所有会失败的前置动作做完。 */\n    let sessionId: string`,
  )
  m.replace(store, `      await port.prompt({\n        sessionId,\n        text: said,`, `      await port.prompt({\n        sessionId,\n        intent: parsed.intent,\n        text: said,`)

  m.replace('packages/ipc/src/agent.ts', `          sessionId: request.sessionId,\n          prompt: request.text,`, `          sessionId: request.sessionId,\n          intent: request.intent,\n          prompt: request.text,`)

  const dto = 'apps/desktop/src-tauri/src/commands/agent/dto.rs'
  m.replace(
    dto,
    `#[derive(Debug, Deserialize, Type)]\n#[serde(rename_all = \"camelCase\")]\npub struct AgentPromptRequest {`,
    `#[derive(Debug, Clone, Copy, Deserialize, Type)]\n#[serde(rename_all = \"snake_case\")]\npub enum AgentPromptIntent {\n    Normal,\n    Goal,\n    Swarm,\n}\n\n#[derive(Debug, Deserialize, Type)]\n#[serde(rename_all = \"camelCase\")]\npub struct AgentPromptRequest {`,
  )
  m.replace(dto, `    pub session_id: String,\n    pub prompt: String,`, `    pub session_id: String,\n    pub intent: AgentPromptIntent,\n    pub prompt: String,`)

  const session = 'crates/agent-runtime/src/session.rs'
  m.replace(session, `/// A session the agent just opened, and the selectors it offers for it.`, `#[derive(Debug, Clone, Copy)]\npub enum PromptIntent {\n    Normal,\n    Goal,\n    Swarm,\n}\n\n/// A session the agent just opened, and the selectors it offers for it.`)
  m.replace('crates/agent-runtime/src/lib.rs', `    AgentConnection, AgentSpawn, Cursor, Handshake, OpenedSession, SessionEntry, SessionEvent,`, `    AgentConnection, AgentSpawn, Cursor, Handshake, OpenedSession, PromptIntent, SessionEntry, SessionEvent,`)

  const commands = 'crates/agent-runtime/src/commands.rs'
  m.replace(commands, `use crate::session::{Cursor, OpenedSession, SessionEntry, Skill};`, `use crate::session::{Cursor, OpenedSession, PromptIntent, SessionEntry, Skill};`)
  m.replace(
    commands,
    `    Prompt {\n        /// The session this turn belongs to.`,
    `    PreparePrompt {\n        session_id: String,\n        intent: PromptIntent,\n        text: String,\n        reply: oneshot::Sender<Result<()>>,\n    },\n    Prompt {\n        /// The session this turn belongs to.`,
  )
  m.replace(
    commands,
    `    /// Starts a turn, delivering every frame of it to the sink handed in.`,
    `    pub async fn prepare_prompt(\n        &self,\n        session_id: String,\n        intent: PromptIntent,\n        text: String,\n    ) -> Result<()> {\n        let (reply, answer) = oneshot::channel();\n        self.send(Command::PreparePrompt { session_id, intent, text, reply })?;\n        answer.await.map_err(|_dropped| KapError::Refused(Refusal::Gone))?\n    }\n\n    /// Starts a turn, delivering every frame of it to the sink handed in.`,
  )

  const turn = 'apps/desktop/src-tauri/src/commands/agent/turn.rs'
  m.replace(turn, `    AgentPromptRequest, AgentPromptResult, AgentResolvePermissionRequest, answered, decided,`, `    AgentPromptIntent, AgentPromptRequest, AgentPromptResult, AgentResolvePermissionRequest,\n    answered, decided,`)
  m.replace(turn, `use poietica_agent_runtime_native::{FrameSink, RecordedEvent};`, `use poietica_agent_runtime_native::{FrameSink, PromptIntent, RecordedEvent};`)
  m.replace(
    turn,
    `    let thread_id = held.thread_id;\n    let addressed = held.session_id;\n\n    // The first thing said names`,
    `    let thread_id = held.thread_id;\n    let addressed = held.session_id;\n\n    session\n        .client\n        .prepare_prompt(\n            addressed.clone(),\n            match request.intent {\n                AgentPromptIntent::Normal => PromptIntent::Normal,\n                AgentPromptIntent::Goal => PromptIntent::Goal,\n                AgentPromptIntent::Swarm => PromptIntent::Swarm,\n            },\n            text.clone(),\n        )\n        .await\n        .map_err(translate)?;\n\n    // The first thing said names`,
  )

  const driver = 'crates/agent-runtime/src/driver.rs'
  m.replace(driver, `    SessionEvents, Skill,`, `    PromptIntent, SessionEvents, Skill,`)
  m.replace(
    driver,
    `                        Some(Command::Prompt { session_id: sid, text, images, frames, reply }) => {`,
    `                        Some(Command::PreparePrompt { session_id: sid, intent, text, reply }) => {\n                            let http2 = http.clone();\n                            let base2 = base_url.clone();\n                            tokio::spawn(async move {\n                                let result = prepare_prompt(&http2, &base2, &sid, intent, &text).await;\n                                let _ = reply.send(result);\n                            });\n                        }\n\n                        Some(Command::Prompt { session_id: sid, text, images, frames, reply }) => {`,
  )
  m.replace(
    driver,
    `async fn submit_prompt(`,
    `async fn prepare_prompt(\n    http: &reqwest::Client,\n    base_url: &str,\n    session_id: &str,\n    intent: PromptIntent,\n    text: &str,\n) -> Result<()> {\n    let patch = match intent {\n        PromptIntent::Normal => return Ok(()),\n        PromptIntent::Goal => json!({ \"goal_objective\": text }),\n        PromptIntent::Swarm => json!({ \"swarm_mode\": true }),\n    };\n    post(\n        http,\n        &format!(\"{base_url}/sessions/{session_id}/profile\"),\n        &json!({ \"agent_config\": patch }),\n    )\n    .await?;\n    Ok(())\n}\n\nasync fn submit_prompt(`,
  )

  const test = `import { describe, expect, it } from 'vitest'\nimport { parsePromptIntent } from './prompt-intent'\n\ndescribe('parsePromptIntent', () => {\n  it('turns goal and swarm commands into typed intents', () => {\n    expect(parsePromptIntent('/goal ship the release')).toEqual({ intent: 'goal', text: 'ship the release' })\n    expect(parsePromptIntent('/swarm audit every package')).toEqual({ intent: 'swarm', text: 'audit every package' })\n  })\n  it('does not steal ordinary text that merely starts similarly', () => {\n    expect(parsePromptIntent('/goalkeeper')).toEqual({ intent: 'normal', text: '/goalkeeper' })\n  })\n  it('rejects empty structured commands before side effects', () => {\n    expect(() => parsePromptIntent('/goal')).toThrow()\n    expect(() => parsePromptIntent('/swarm')).toThrow()\n  })\n})\n`
  m.write('packages/agent/src/session/prompt-intent.test.ts', test)
}
