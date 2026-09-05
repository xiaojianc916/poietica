use super::POISONED;
use super::config::restate;
use super::dto::{AgentSessionEvent, AgentTranscriptEvent, reported_goal, reported_usage};
use super::failure::translate;
use crate::agent::profile::{agent_args, agent_data_home, agent_program, launch_env};
use crate::error::Error;
use crate::ledger::LocalIndex;
use poietica_conversation_runtime::connection::{Runtime, RuntimeError};
use poietica_conversation_runtime::journal::FrameJournal;
use poietica_kap_client::{AgentSpawn, KapError, Refusal, SessionEvent};
use poietica_ledger::execution::read_index;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::AppHandle;
use tauri_specta::Event as _;

pub type AgentRuntime = Arc<Runtime<Error>>;

pub fn compose(
    app: &AppHandle,
    root: PathBuf,
    attachments: PathBuf,
    index: LocalIndex,
    journal: FrameJournal,
) -> AgentRuntime {
    let preparing = app.clone();
    let authority = index.clone();
    let publishing = app.clone();
    Arc::new(Runtime::new(
        root,
        attachments,
        index,
        journal,
        move |request| {
            let app = preparing.clone();
            let index = authority.clone();
            Box::pin(async move {
                if let Some(serving) = request.replacing {
                    let owned = read_index(&index, move |store| {
                        if !store.automation_initialized().map_err(Error::from)? {
                            return Ok(false);
                        }
                        Ok(store
                            .automation_state()
                            .map_err(Error::from)?
                            .executions
                            .values()
                            .any(|entry| entry.agent_id == serving))
                    })
                    .await?;
                    if owned {
                        return Err(poietica_automation::AutomationError::Busy.into());
                    }
                }
                crate::workspace::environment::prepare_mcp(&app, &request.agent_id).await?;
                crate::webview::ensure_live_kernel(&app);
                Ok(AgentSpawn {
                    program: agent_program(&app, &request.agent_id)?,
                    args: agent_args(&app, &request.agent_id)?,
                    cwd: request.cwd,
                    env: launch_env(&app, &request.agent_id)?,
                    home: agent_data_home(&app, &request.agent_id)?,
                })
            })
        },
        move |event| {
            let emitted = match event {
                SessionEvent::Selectors {
                    session_id,
                    controls,
                    goal,
                } => AgentSessionEvent::Selectors {
                    session_id,
                    selectors: controls.into_iter().map(restate).collect(),
                    goal: goal.map(reported_goal),
                }
                .emit(&publishing),
                SessionEvent::Transcript {
                    session_id,
                    payload,
                } => AgentTranscriptEvent {
                    session_id,
                    json: payload.to_string(),
                }
                .emit(&publishing),
                SessionEvent::Usage { session_id, usage } => AgentSessionEvent::Usage {
                    session_id,
                    usage: reported_usage(usage),
                }
                .emit(&publishing),
                SessionEvent::ModelCatalogChanged => {
                    AgentSessionEvent::ModelCatalogChanged.emit(&publishing)
                }
                SessionEvent::Cursor { .. }
                | SessionEvent::CursorLost { .. }
                | SessionEvent::Link(_) => return,
            };
            if let Err(error) = emitted {
                log::warn!("emit the session state failed: {error}");
            }
        },
    ))
}

impl From<RuntimeError> for Error {
    fn from(error: RuntimeError) -> Self {
        match error {
            RuntimeError::Agent(error) => translate(error),
            RuntimeError::Gone => translate(KapError::Refused(Refusal::Gone)),
            RuntimeError::Busy => Self::Automation(poietica_automation::AutomationError::Data(
                "另一代理正在使用连接；后台任务不会中断它".to_owned(),
            )),
            RuntimeError::Poisoned => Self::Internal(POISONED.to_owned()),
            error => {
                log::error!("conversation lifecycle failed: {error}");
                Self::Internal(
                    "the conversation connection could not complete its lifecycle".to_owned(),
                )
            }
        }
    }
}
