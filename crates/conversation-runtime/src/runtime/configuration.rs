use super::failure::CommandError;
use super::{Runtime, RuntimeFailure};
use crate::connection::Handle;
use crate::session::{SessionMode, SessionRequest};
use poietica_kap_client::{ConfigControl, SessionEvent, select_config};

impl<E: RuntimeFailure> Runtime<E> {
    pub async fn select_configuration(
        &self,
        thread_id: Option<String>,
        config_id: String,
        value: String,
        input: Option<String>,
    ) -> Result<Vec<ConfigControl>, CommandError<E>> {
        let live = self
            .connection
            .current()
            .map_err(CommandError::Runtime)?
            .ok_or(CommandError::MissingSession)?;
        let held = match thread_id.as_deref() {
            Some(named) => Some(
                self.sessions
                    .resolve(
                        &self.index,
                        &live.client,
                        &live.book,
                        SessionRequest {
                            owner: &live.agent_id,
                            default_root: self.root(),
                            named,
                            mode: SessionMode::CreateIfUnbound,
                        },
                    )
                    .await
                    .map_err(CommandError::Session)?,
            ),
            None => None,
        };
        let addressed = held
            .as_ref()
            .map_or_else(|| live.anchor.clone(), |held| held.session_id.clone());
        let controls = select_config(&live.client, addressed.clone(), config_id, value, input)
            .await
            .map_err(CommandError::Agent)?;
        self.announce(&live, addressed, controls.clone()).await;
        drop(held);
        Ok(controls)
    }

    pub(super) async fn announce(
        &self,
        live: &Handle,
        session_id: String,
        controls: Vec<ConfigControl>,
    ) {
        match live.client.goal(session_id.clone()).await {
            Ok(goal) => (self.publish)(SessionEvent::Selectors {
                session_id,
                controls,
                goal,
            }),
            Err(error) => {
                // Reporting failure does not undo an already accepted configuration.
                log::warn!(
                    "could not report the session goal after a configuration change: {error}"
                );
            }
        }
    }
}
