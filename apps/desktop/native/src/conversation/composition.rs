use super::configuration::restate;
use super::dto::{AgentSessionEvent, AgentTranscriptEvent, reported_goal, reported_usage};
use crate::agent::profile::{
    agent_args, agent_data_home, agent_entry, agent_program, bundled_directory, launch_env,
};
use crate::error::Error;
use crate::ledger::LocalIndex;
use poietica_agent_client::{AgentSpawn, SessionEvent};
use poietica_conversation_runtime::Runtime;
use poietica_conversation_runtime::journal::FrameJournal;
use std::path::PathBuf;
use std::sync::Arc;

use super::AgentRuntime;

pub(crate) fn compose(
    root: PathBuf,
    attachments: PathBuf,
    index: LocalIndex,
    journal: FrameJournal,
) -> AgentRuntime {
    let authority = index.clone();
    Arc::new(Runtime::new(
        root,
        attachments,
        index,
        journal,
        move |request| {
            let index = authority.clone();
            Box::pin(async move {
                if let Some(serving) = request.replacing {
                    poietica_automation_runtime::catalog::ensure_agent_replaceable::<Error>(
                        &index, serving,
                    )
                    .await?;
                }
                /* 唯一在册 agent：起哪一家不由请求说，档案在原生侧。 */
                crate::workspace::environment::prepare_mcp().await?;
                Ok(AgentSpawn {
                    program: agent_program()?,
                    bundled: bundled_directory()?,
                    entry: agent_entry()?,
                    args: agent_args()?,
                    cwd: request.cwd,
                    env: launch_env()?,
                    home: agent_data_home()?,
                })
            })
        },
        |event| {
            let (kind, payload) = match event {
                SessionEvent::Selectors {
                    session_id,
                    controls,
                    goal,
                } => (
                    "agent_session_event",
                    serde_json::to_value(AgentSessionEvent::Selectors {
                        session_id,
                        selectors: controls.into_iter().map(restate).collect(),
                        goal: goal.map(reported_goal),
                    }),
                ),
                SessionEvent::Transcript {
                    session_id,
                    payload,
                } => (
                    "agent_transcript_event",
                    serde_json::to_value(AgentTranscriptEvent {
                        session_id,
                        json: payload,
                    }),
                ),
                SessionEvent::Usage { session_id, usage } => (
                    "agent_session_event",
                    serde_json::to_value(AgentSessionEvent::Usage {
                        session_id,
                        usage: reported_usage(usage),
                    }),
                ),
                SessionEvent::Queue { session_id, queue } => (
                    "agent_session_event",
                    serde_json::to_value(AgentSessionEvent::Queue {
                        session_id,
                        queue: queue.into(),
                    }),
                ),
                SessionEvent::PromptDropped { session_id, text } => (
                    "agent_session_event",
                    serde_json::to_value(AgentSessionEvent::PromptDropped { session_id, text }),
                ),
                SessionEvent::ModelCatalogChanged => (
                    "agent_session_event",
                    serde_json::to_value(AgentSessionEvent::ModelCatalogChanged),
                ),
                SessionEvent::Dialog {
                    session_id,
                    request,
                } => (
                    "agent_session_event",
                    serde_json::to_value(AgentSessionEvent::Dialog {
                        session_id,
                        request,
                    }),
                ),
                SessionEvent::Link(_) => return,
            };

            match payload {
                Ok(payload) => crate::transport::emit(kind, &payload),
                Err(error) => log::warn!("could not encode the session state: {error}"),
            }
        },
    ))
}
