use super::{CommandError, Runtime, RuntimeFailure, Takeover};
use crate::{
    catalog::{FALLBACK_THREAD_TITLE, checked_title},
    session::{SessionError, SessionHistory, SessionMode, SessionRequest, address, bound_session},
};
use poietica_kap_client::{ConfigControl, GoalSnapshot, KapError, PROMPT_ADMITTED};
use poietica_ledger::{
    execution::{IndexError, LocalIndex, read_index, write_index},
    index::ThreadSummary,
};
use std::{error::Error, future::Future, path::PathBuf};
use uuid::Uuid;

#[derive(Debug)]
pub enum ThreadTarget {
    Create(String),
    Existing(String),
}
#[derive(Debug)]
pub struct OpenThread {
    pub agent_id: String,
    pub cwd: Option<String>,
    pub target: ThreadTarget,
}
#[derive(Debug)]
pub struct ForkThread {
    pub agent_id: String,
    pub cwd: Option<String>,
    pub thread_id: String,
    pub title: String,
    pub drop_turns: u32,
}
#[derive(Debug)]
pub struct OpenedThread {
    pub thread: ThreadSummary,
    pub selectors: Vec<ConfigControl>,
    pub goal: Option<GoalSnapshot>,
    pub history: SessionHistory,
    pub transcript: String,
}
#[derive(Debug)]
pub struct DeletedThread {
    pub attachments: Vec<String>,
    pub workspace: Option<String>,
}
#[derive(Debug)]
pub struct ExportSource {
    thread: Uuid,
    session: String,
    owner: String,
    cwd: Option<String>,
}

impl<E: RuntimeFailure> Runtime<E> {
    pub async fn open_thread<P, PF>(
        &self,
        request: OpenThread,
        deliver_assets: P,
    ) -> Result<OpenedThread, CommandError<E>>
    where
        P: FnOnce(Uuid) -> PF + Send,
        PF: Future<Output = Result<(), E>> + Send,
    {
        let (named, create) = match request.target {
            ThreadTarget::Create(named) => (named, true),
            ThreadTarget::Existing(named) => (named, false),
        };
        let id =
            Uuid::parse_str(&named).map_err(|_| CommandError::Session(SessionError::InvalidId))?;
        let cwd = request.cwd.clone();
        let live = self
            .ensure(request.agent_id, request.cwd, Takeover::Replace)
            .await
            .map_err(CommandError::Runtime)?;
        if create {
            let _lease = self.sessions().exclusive(id).await;
            write_index(&self.inner.index, move |store| {
                store
                    .create_thread(id, FALLBACK_THREAD_TITLE, cwd.as_deref())
                    .map_err(IndexError::from)
                    .map_err(E::from)
            })
            .await
            .map_err(CommandError::Persistence)?;
        }
        let mut held = self
            .sessions()
            .resolve(
                &self.inner.index,
                &live.client,
                &live.book,
                SessionRequest {
                    owner: &live.agent_id,
                    default_root: self.root(),
                    named: &named,
                    mode: SessionMode::CreateIfUnbound,
                },
            )
            .await
            .map_err(CommandError::Session)?;
        let offered = held.offered.take();
        let session = held.session_id.clone();
        let selectors = async {
            match offered {
                Some(offered) => Ok::<_, CommandError<E>>(offered),
                None => live
                    .client
                    .selectors(session.clone())
                    .map_err(CommandError::Agent)?
                    .await
                    .map_err(|_| CommandError::ResponseClosed)?
                    .map_err(CommandError::Agent),
            }
        };
        let (selectors, goal, transcript) = tokio::try_join!(
            selectors,
            async {
                live.client
                    .goal(session.clone())
                    .await
                    .map_err(CommandError::Agent)
            },
            async {
                live.client
                    .read_transcript(session.clone(), "main".to_owned(), None)
                    .await
                    .map_err(CommandError::Agent)
            },
        )?;
        let thread = read_index(&self.inner.index, move |store| {
            store.thread(id).map_err(IndexError::from).map_err(E::from)
        })
        .await
        .map_err(CommandError::Persistence)?
        .ok_or(CommandError::Readback)?;
        deliver_assets(id)
            .await
            .map_err(CommandError::Attachments)?;
        let result = OpenedThread {
            thread,
            selectors,
            goal,
            history: held.history,
            transcript: transcript.to_string(),
        };
        drop(held);
        Ok(result)
    }

    pub async fn fork_thread(&self, request: ForkThread) -> Result<ThreadSummary, CommandError<E>> {
        let title = checked_title(&request.title).map_err(CommandError::Catalog)?;
        let source = Uuid::parse_str(&request.thread_id)
            .map_err(|_| CommandError::Session(SessionError::InvalidId))?;
        let live = self
            .ensure(request.agent_id, request.cwd, Takeover::Replace)
            .await
            .map_err(CommandError::Runtime)?;
        let held = self
            .sessions()
            .resolve(
                &self.inner.index,
                &live.client,
                &live.book,
                SessionRequest {
                    owner: &live.agent_id,
                    default_root: self.root(),
                    named: &request.thread_id,
                    mode: SessionMode::RequireBound,
                },
            )
            .await
            .map_err(CommandError::Session)?;
        let forked = live
            .client
            .fork_session(held.session_id.clone(), request.drop_turns)
            .await
            .map_err(CommandError::Agent)?;
        let id = bind_fork(
            &self.inner.index,
            ForkBinding {
                source,
                title,
                session: forked.session_id,
                owner: live.agent_id.clone(),
                drop_turns: request.drop_turns,
            },
            |session| live.client.delete_session(session),
        )
        .await?;
        let thread = read_index(&self.inner.index, move |store| {
            store.thread(id).map_err(IndexError::from).map_err(E::from)
        })
        .await
        .map_err(CommandError::Persistence)?
        .ok_or(CommandError::Readback)?;
        drop(held);
        Ok(thread)
    }

    pub async fn delete_thread(&self, named: &str) -> Result<DeletedThread, CommandError<E>> {
        let id =
            Uuid::parse_str(named).map_err(|_| CommandError::Session(SessionError::InvalidId))?;
        let _lease = self.sessions().exclusive(id).await;
        let live = self.current().map_err(CommandError::Runtime)?;
        let (binding, root) = write_index(&self.inner.index, move |store| {
            let stored = store
                .thread(id)
                .map_err(IndexError::from)
                .map_err(E::from)?;
            let root = stored
                .as_ref()
                .and_then(|thread| thread.workspace_root.clone());
            let binding = stored.and_then(|thread| thread.session_id.zip(thread.agent_id));
            store
                .delete_thread(id)
                .map_err(IndexError::from)
                .map_err(E::from)?;
            Ok((binding, root))
        })
        .await
        .map_err(CommandError::Persistence)?;
        if let Some(live) = live
            && let Some((session, owner)) = binding
            && owner == live.agent_id
        {
            match live.client.delete_session(session.clone()).await {
                Ok(()) => {
                    if let Err(error) = write_index(&self.inner.index, move |store| {
                        store
                            .discharge_session_disposal(&session)
                            .map_err(IndexError::from)
                            .map_err(E::from)
                    })
                    .await
                    {
                        log::warn!(
                            "confirmed archive remains due because acknowledgement failed: {error}"
                        );
                    }
                }
                Err(error) => {
                    log::warn!("archive intent remains durable after remote failure: {error}");
                }
            }
        }
        // Cleanup failure does not undo a committed deletion.
        let reclaimed = write_index(&self.inner.index, move |store| {
            let attachments = store
                .unreferenced_attachments()
                .map_err(IndexError::from)
                .map_err(E::from)?;
            for hash in &attachments {
                store
                    .forget_attachment(hash)
                    .map_err(IndexError::from)
                    .map_err(E::from)?;
            }
            let workspace = match root {
                Some(root)
                    if !store
                        .workspace_root_in_use(&root)
                        .map_err(IndexError::from)
                        .map_err(E::from)? =>
                {
                    Some(root)
                }
                _ => None,
            };
            Ok(DeletedThread {
                attachments,
                workspace,
            })
        })
        .await;
        match reclaimed {
            Ok(reclaimed) => Ok(reclaimed),
            Err(error) => {
                log::warn!("conversation deleted; resource cleanup failed: {error}");
                Ok(DeletedThread {
                    attachments: Vec::new(),
                    workspace: None,
                })
            }
        }
    }

    pub async fn prepare_export(
        &self,
        owner: String,
        named: &str,
    ) -> Result<ExportSource, CommandError<E>> {
        let id =
            Uuid::parse_str(named).map_err(|_| CommandError::Session(SessionError::InvalidId))?;
        let thread = read_index(&self.inner.index, move |store| {
            store.thread(id).map_err(IndexError::from).map_err(E::from)
        })
        .await
        .map_err(CommandError::Persistence)?
        .ok_or(CommandError::Session(SessionError::Missing))?;
        let session = bound_session(&thread, &owner)
            .map_err(CommandError::Session)?
            .ok_or(CommandError::Session(SessionError::Unbound))?;
        Ok(ExportSource {
            thread: id,
            session,
            owner,
            cwd: thread.workspace_root,
        })
    }

    pub async fn export_thread(
        &self,
        source: ExportSource,
        destination: PathBuf,
    ) -> Result<(), CommandError<E>> {
        let live = self
            .ensure(source.owner.clone(), source.cwd, Takeover::Replace)
            .await
            .map_err(CommandError::Runtime)?;
        let _lease = self.sessions().exclusive(source.thread).await;
        let current = address(&self.inner.index, &source.thread.to_string(), &source.owner)
            .await
            .map_err(CommandError::Session)?;
        if current.as_deref() != Some(source.session.as_str()) {
            return Err(CommandError::ExportChanged);
        }
        live.client
            .export_session(source.session, destination)
            .await
            .map_err(CommandError::Agent)
    }
}

struct ForkBinding {
    source: Uuid,
    title: String,
    session: String,
    owner: String,
    drop_turns: u32,
}

async fn bind_fork<E, F, A>(
    index: &LocalIndex<E>,
    binding: ForkBinding,
    archive: F,
) -> Result<Uuid, CommandError<E>>
where
    E: Error + From<IndexError> + Send + 'static,
    F: FnOnce(String) -> A,
    A: Future<Output = Result<(), KapError>>,
{
    let session = binding.session.clone();
    let owner = binding.owner.clone();
    let committed = write_index(index, move |store| {
        store
            .fork_thread(
                binding.source,
                &binding.title,
                &binding.session,
                &binding.owner,
                binding.drop_turns,
                PROMPT_ADMITTED,
            )
            .map_err(IndexError::from)
            .map_err(E::from)
    })
    .await;
    match committed {
        Ok(id) => Ok(id),
        Err(cause) => {
            let checked = session.clone();
            // Writer jobs can outlive their response; verify behind the writer before compensation.
            let bound = write_index(index, move |store| {
                store
                    .list_threads()
                    .map(|threads| {
                        threads.iter().any(|thread| {
                            thread.session_id.as_deref() == Some(checked.as_str())
                                && thread.agent_id.as_deref() == Some(owner.as_str())
                        })
                    })
                    .map_err(IndexError::from)
                    .map_err(E::from)
            })
            .await;
            match bound {
                Ok(true) => Err(CommandError::Persistence(cause)),
                Err(verification) => Err(CommandError::BindingUncertain {
                    cause,
                    verification,
                }),
                Ok(false) => match archive(session).await {
                    Ok(()) => Err(CommandError::Persistence(cause)),
                    Err(cleanup) => Err(CommandError::Session(SessionError::AttachCleanup {
                        cause,
                        cleanup,
                    })),
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CommandError, ForkBinding, SessionError, bind_fork};
    use poietica_kap_client::{KapError, Refusal};
    use poietica_ledger::execution::{IndexError, LocalIndex, read_index, write_index};
    use poietica_time::wall_clock::SystemWallClock;
    use std::{error::Error, future::ready};
    use uuid::Uuid;

    fn binding() -> ForkBinding {
        ForkBinding {
            source: Uuid::new_v4(),
            title: "fork".to_owned(),
            session: "unbound-fork".to_owned(),
            owner: "agent".to_owned(),
            drop_turns: 0,
        }
    }

    #[tokio::test]
    async fn failed_binding_compensates_only_the_unbound_fork() -> Result<(), Box<dyn Error>> {
        let directory = tempfile::tempdir()?;
        let index =
            LocalIndex::<IndexError>::open(&directory.path().join("index.db"), SystemWallClock)?;
        let mut archived = Vec::new();
        let outcome = bind_fork(&index, binding(), |session| {
            archived.push(session);
            ready(Ok(()))
        })
        .await;
        assert!(matches!(outcome, Err(CommandError::Persistence(_))));
        assert_eq!(archived, vec!["unbound-fork".to_owned()]);
        Ok(())
    }

    #[tokio::test]
    async fn failed_compensation_preserves_both_failures() -> Result<(), Box<dyn Error>> {
        let directory = tempfile::tempdir()?;
        let index =
            LocalIndex::<IndexError>::open(&directory.path().join("index.db"), SystemWallClock)?;
        let outcome = bind_fork(&index, binding(), |_| {
            ready(Err(KapError::Refused(Refusal::Gone)))
        })
        .await;
        assert!(matches!(
            outcome,
            Err(CommandError::Session(SessionError::AttachCleanup { .. }))
        ));
        Ok(())
    }

    #[tokio::test]
    async fn successful_binding_preserves_source_and_never_compensates()
    -> Result<(), Box<dyn Error>> {
        let directory = tempfile::tempdir()?;
        let index =
            LocalIndex::<IndexError>::open(&directory.path().join("index.db"), SystemWallClock)?;
        let fork = binding();
        let source = fork.source;
        write_index(&index, move |store| {
            store
                .create_thread(source, "source", None)
                .map_err(IndexError::from)?;
            store
                .attach_session(source, "original", "agent")
                .map_err(IndexError::from)
        })
        .await?;
        let mut archived = Vec::new();
        let created = bind_fork(&index, fork, |session| {
            archived.push(session);
            ready(Ok(()))
        })
        .await?;
        assert!(archived.is_empty());
        let (original, created) = read_index(&index, move |store| {
            Ok((
                store.thread(source).map_err(IndexError::from)?,
                store.thread(created).map_err(IndexError::from)?,
            ))
        })
        .await?;
        assert_eq!(
            original.and_then(|thread| thread.session_id).as_deref(),
            Some("original")
        );
        assert_eq!(
            created.and_then(|thread| thread.session_id).as_deref(),
            Some("unbound-fork")
        );
        Ok(())
    }
}
