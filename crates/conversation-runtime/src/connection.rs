use crate::{
    DeliveryError,
    gateway::KapGateway,
    journal::{FrameJournal, JournalError},
    session::SessionResolver,
};
use poietica_kap_client::{
    AgentClient, AgentConnection, AgentSpawn, Daemon, DaemonIntent, KapError, PermissionDesk,
    QuestionDesk, Reaction, RunSlot, SessionBook, SessionEvent, connect,
};
use poietica_ledger::execution::{IndexError, LocalIndex};
use std::error::Error;
use std::fmt;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error(transparent)]
    Agent(KapError),
    #[error("the conversation runtime is closed or its launch was cancelled")]
    Gone,
    #[error("another agent owns the connection")]
    Busy,
    #[error("the connection owner was poisoned")]
    Poisoned,
    #[error("the connection worker could not start: {0}")]
    Start(std::io::Error),
    #[error("the connection worker failed: {0}")]
    Worker(String),
    #[error("the connection workers did not stop before the shutdown deadline")]
    Timeout,
    #[error("a connection worker cannot join itself")]
    Reentrant,
}

pub trait RuntimeFailure:
    Error
    + From<IndexError>
    + From<DeliveryError>
    + From<JournalError>
    + From<RuntimeError>
    + Send
    + 'static
{
}
impl<T> RuntimeFailure for T where
    T: Error
        + From<IndexError>
        + From<DeliveryError>
        + From<JournalError>
        + From<RuntimeError>
        + Send
        + 'static
{
}

type Preparation<E> = Pin<Box<dyn Future<Output = Result<AgentSpawn, E>> + Send>>;
type Acquisition<E> = Pin<Box<dyn Future<Output = Result<Handle, E>> + Send>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Takeover {
    Replace,
    Preserve,
}

#[derive(Debug)]
pub struct LaunchRequest {
    pub agent_id: String,
    pub cwd: PathBuf,
    pub replacing: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Handle {
    pub client: AgentClient,
    pub agent_id: String,
    pub anchor: String,
    pub desk: PermissionDesk,
    pub questions: QuestionDesk,
    pub book: SessionBook,
}

struct Connection {
    client: AgentClient,
    agent_id: String,
    anchor: Option<String>,
    desk: PermissionDesk,
    questions: QuestionDesk,
    book: SessionBook,
    lease: Arc<CancellationToken>,
}
impl Connection {
    fn handle(&self) -> Option<Handle> {
        if self.lease.is_cancelled() {
            return None;
        }
        Some(Handle {
            client: self.client.clone(),
            agent_id: self.agent_id.clone(),
            anchor: self.anchor.clone()?,
            desk: self.desk.clone(),
            questions: self.questions.clone(),
            book: self.book.clone(),
        })
    }
    fn retire(self) {
        self.lease.cancel();
        if let Err(error) = self
            .book
            .fail_active("agent 连接已断开，本轮已终止，请重试")
        {
            log::error!("could not terminate turns owned by a dead connection: {error}");
        }
        self.desk.clear();
        self.questions.clear();
    }
}
struct Lifecycle {
    closed: bool,
    scope: Arc<CancellationToken>,
    connection: Option<Connection>,
    daemon: Daemon,
}
struct Worker {
    lease: Arc<CancellationToken>,
    thread: JoinHandle<Result<(), RuntimeError>>,
}
struct Inner<E: RuntimeFailure> {
    root: PathBuf,
    attachments: PathBuf,
    journal: FrameJournal,
    sessions: Arc<SessionResolver>,
    index: LocalIndex<E>,
    prepare: Box<dyn Fn(LaunchRequest) -> Preparation<E> + Send + Sync>,
    publish: Arc<dyn Fn(SessionEvent) + Send + Sync>,
    state: Mutex<Lifecycle>,
    starting: tokio::sync::Mutex<()>,
    workers: Mutex<Vec<Worker>>,
}

pub struct Runtime<E: RuntimeFailure> {
    inner: Arc<Inner<E>>,
}
impl<E: RuntimeFailure> fmt::Debug for Runtime<E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConversationRuntime")
            .finish_non_exhaustive()
    }
}
impl<E: RuntimeFailure> Runtime<E> {
    pub fn new(
        root: PathBuf,
        attachments: PathBuf,
        index: LocalIndex<E>,
        journal: FrameJournal,
        prepare: impl Fn(LaunchRequest) -> Preparation<E> + Send + Sync + 'static,
        publish: impl Fn(SessionEvent) + Send + Sync + 'static,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                root,
                attachments,
                index,
                journal,
                sessions: Arc::new(SessionResolver::default()),
                prepare: Box::new(prepare),
                publish: Arc::new(publish),
                state: Mutex::new(Lifecycle {
                    closed: false,
                    scope: Arc::new(CancellationToken::new()),
                    connection: None,
                    daemon: Daemon::new(DaemonIntent::Running),
                }),
                starting: tokio::sync::Mutex::new(()),
                workers: Mutex::new(Vec::new()),
            }),
        }
    }
    pub fn root(&self) -> &PathBuf {
        &self.inner.root
    }
    pub fn attachments(&self) -> &PathBuf {
        &self.inner.attachments
    }
    pub fn journal(&self) -> &FrameJournal {
        &self.inner.journal
    }
    pub fn sessions(&self) -> &SessionResolver {
        &self.inner.sessions
    }
    pub fn current(&self) -> Result<Option<Handle>, E> {
        let state = self.inner.state()?;
        Ok(state.connection.as_ref().and_then(Connection::handle))
    }
    pub async fn ensure(
        &self,
        agent: String,
        cwd: Option<String>,
        takeover: Takeover,
    ) -> Result<Handle, E> {
        let cwd = cwd.map_or_else(|| self.inner.root.clone(), PathBuf::from);
        Arc::clone(&self.inner)
            .acquire(agent, cwd, takeover, None)
            .await
    }
    pub async fn disconnect(&self) -> Result<(), E> {
        let inner = Arc::clone(&self.inner);
        tokio::task::spawn_blocking(move || inner.stop(false))
            .await
            .map_err(|error| E::from(RuntimeError::Worker(error.to_string())))?
    }
    pub fn shutdown(&self) -> Result<(), E> {
        self.inner.stop(true)
    }
    pub async fn apply_daemon_intent(&self, running: bool) -> Result<(), E> {
        {
            let mut state = self.inner.state()?;
            if state.closed {
                return Err(E::from(RuntimeError::Gone));
            }
            let intent = if running {
                DaemonIntent::Running
            } else {
                DaemonIntent::Stopped
            };
            let _reaction = state.daemon.set_intent(intent);
        }
        if !running {
            self.disconnect().await?;
        }
        Ok(())
    }
}
impl<E: RuntimeFailure> Drop for Runtime<E> {
    fn drop(&mut self) {
        if let Err(error) = self.shutdown() {
            log::error!("conversation runtime could not shut down cleanly: {error}");
        }
    }
}

struct Attempt<E: RuntimeFailure> {
    owner: Arc<Inner<E>>,
    lease: Arc<CancellationToken>,
    committed: bool,
}
impl<E: RuntimeFailure> Drop for Attempt<E> {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        self.lease.cancel();
        let retired = match self.owner.state() {
            Ok(mut state) => {
                if state
                    .connection
                    .as_ref()
                    .is_some_and(|connection| Arc::ptr_eq(&connection.lease, &self.lease))
                {
                    state.scope.cancel();
                    state.scope = Arc::new(CancellationToken::new());
                    state.connection.take()
                } else {
                    None
                }
            }
            Err(error) => {
                log::error!("could not release an abandoned launch: {error}");
                None
            }
        };
        if let Some(connection) = retired {
            connection.retire();
        }
    }
}

impl<E: RuntimeFailure> Inner<E> {
    fn state(&self) -> Result<MutexGuard<'_, Lifecycle>, E> {
        self.state
            .lock()
            .map_err(|_| E::from(RuntimeError::Poisoned))
    }
    fn stop(&self, closing: bool) -> Result<(), E> {
        let (retired, poisoned) = {
            let (mut state, poisoned) = match self.state.lock() {
                Ok(state) => (state, false),
                Err(poisoned) => (poisoned.into_inner(), true),
            };
            state.closed |= closing;
            state.scope.cancel();
            state.scope = Arc::new(CancellationToken::new());
            if closing {
                let _reaction = state.daemon.set_intent(DaemonIntent::Stopped);
            }
            (state.connection.take(), poisoned)
        };
        if let Some(connection) = retired {
            connection.retire();
        }
        self.join_retired().map_err(E::from)?;
        if closing {
            self.journal.close().map_err(E::from)?;
        } else {
            self.journal.flush().map_err(E::from)?;
        }
        if poisoned {
            return Err(E::from(RuntimeError::Poisoned));
        }
        Ok(())
    }
    fn join_retired(&self) -> Result<(), RuntimeError> {
        let (mut workers, poisoned) = match self.workers.lock() {
            Ok(workers) => (workers, false),
            Err(poisoned) => (poisoned.into_inner(), true),
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut position = 0;
        while position < workers.len() {
            let Some(worker) = workers.get(position) else {
                break;
            };
            if !worker.lease.is_cancelled() {
                position += 1;
                continue;
            }
            if worker.thread.thread().id() == std::thread::current().id() {
                return Err(RuntimeError::Reentrant);
            }
            while !worker.thread.is_finished() {
                if Instant::now() >= deadline {
                    return Err(RuntimeError::Timeout);
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            let worker = workers.remove(position);
            worker
                .thread
                .join()
                .map_err(|_| RuntimeError::Worker("worker panicked".to_owned()))??;
        }
        if poisoned {
            return Err(RuntimeError::Poisoned);
        }
        Ok(())
    }
    fn acquire(
        self: Arc<Self>,
        agent: String,
        cwd: PathBuf,
        takeover: Takeover,
        expected: Option<Arc<CancellationToken>>,
    ) -> Acquisition<E> {
        Box::pin(async move {
            let _gate = self.starting.lock().await;
            let (observed, replacing) = {
                let state = self.state()?;
                if state.closed
                    || expected
                        .as_ref()
                        .is_some_and(|scope| !Arc::ptr_eq(scope, &state.scope))
                {
                    return Err(E::from(RuntimeError::Gone));
                }
                let live = state.connection.as_ref().and_then(Connection::handle);
                if let Some(live) = live {
                    if live.agent_id == agent {
                        return Ok(live);
                    }
                    if takeover == Takeover::Preserve {
                        return Err(E::from(RuntimeError::Busy));
                    }
                    (Arc::clone(&state.scope), Some(live.agent_id))
                } else {
                    (Arc::clone(&state.scope), None)
                }
            };
            let request = LaunchRequest {
                agent_id: agent.clone(),
                cwd: cwd.clone(),
                replacing,
            };
            let spawn = tokio::select! {
                () = observed.cancelled() => return Err(E::from(RuntimeError::Gone)),
                result = (self.prepare)(request) => result?,
            };
            let desk = PermissionDesk::new();
            let questions = QuestionDesk::new();
            let AgentConnection {
                client,
                book,
                handshake,
                driver,
                mut events,
                stop,
            } = connect(spawn, RunSlot::new(), desk.clone(), questions.clone())
                .map_err(RuntimeError::Agent)
                .map_err(E::from)?;
            let lease = Arc::new(stop);
            let (scope, previous) = {
                let mut state = self.state()?;
                if state.closed || observed.is_cancelled() || !Arc::ptr_eq(&observed, &state.scope)
                {
                    return Err(E::from(RuntimeError::Gone));
                }
                if expected.is_none() {
                    state.scope.cancel();
                    state.scope = Arc::new(CancellationToken::new());
                }
                (Arc::clone(&state.scope), state.connection.take())
            };
            if let Some(previous) = previous {
                previous.retire();
                let draining = Arc::clone(&self);
                tokio::task::spawn_blocking(move || draining.join_retired())
                    .await
                    .map_err(|error| E::from(RuntimeError::Worker(error.to_string())))?
                    .map_err(E::from)?;
            }
            let mut attempt = Attempt {
                owner: Arc::clone(&self),
                lease: Arc::clone(&lease),
                committed: false,
            };
            let (ready, ready_receiver) = tokio::sync::oneshot::channel::<Handle>();
            {
                let mut workers = self
                    .workers
                    .lock()
                    .map_err(|_| E::from(RuntimeError::Poisoned))?;
                {
                    let mut state = self.state()?;
                    if state.closed || scope.is_cancelled() || !Arc::ptr_eq(&scope, &state.scope) {
                        return Err(E::from(RuntimeError::Gone));
                    }
                    state.connection = Some(Connection {
                        client: client.clone(),
                        agent_id: agent.clone(),
                        anchor: None,
                        desk: desk.clone(),
                        questions: questions.clone(),
                        book: book.clone(),
                        lease: Arc::clone(&lease),
                    });
                }
                let weak = Arc::downgrade(&self);
                let watched_agent = agent.clone();
                let watched_scope = Arc::clone(&scope);
                let watched_lease = Arc::clone(&lease);
                let event_stop = lease.as_ref().clone();
                let event_index = self.index.clone();
                let event_book = book.clone();
                let publish = Arc::clone(&self.publish);
                let maintenance_stop = lease.as_ref().clone();
                let maintenance_index = self.index.clone();
                let sessions = Arc::clone(&self.sessions);
                let journal = self.journal.clone();
                let attachments = self.attachments.clone();
                let thread = std::thread::Builder::new().name("poietica-conversation".to_owned()).spawn(move || {
                    let _worker_lifetime = watched_lease.as_ref().clone().drop_guard();
                    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()
                        .map_err(RuntimeError::Start)?;
                    let local = tokio::task::LocalSet::new();
                    let driver_lease = Arc::clone(&watched_lease);
                    let driving = local.spawn_local(async move {
                        let outcome = driver.await;
                        driver_lease.cancel();
                        outcome
                    });
                    let receiving = local.spawn_local(async move {
                        let _lifetime = event_stop.drop_guard();
                        while let Some(event) = events.next().await {
                            if let Err(error) = crate::events::record(&event_index, &event_book, &event).await {
                                log::warn!("could not persist an agent session event: {error}");
                            }
                            publish(event);
                        }
                    });
                    let maintaining = local.spawn_local(async move {
                        let live = tokio::select! {
                            () = maintenance_stop.cancelled() => return,
                            ready = ready_receiver => match ready { Ok(live) => live, Err(_) => return },
                        };
                        let work = async {
                            match crate::disposal::discharge(
                                &maintenance_index, &live.agent_id, &live.anchor,
                                |session| live.client.delete_session(session),
                                || !maintenance_stop.is_cancelled(),
                            ).await {
                                Ok(failures) => for failure in failures {
                                    log::warn!("session {} remains pending archive: {}", failure.session_id, failure.cause);
                                },
                                Err(error) => log::warn!("could not update the disposal ledger: {error}"),
                            }
                            let gateway = KapGateway { client: live.client.clone(), journal, attachments_root: attachments };
                            match crate::recover(&maintenance_index, gateway, &live.agent_id, &sessions).await {
                                Ok(failures) => for failure in failures {
                                    log::warn!("delivery {} remains unresolved: {}", failure.turn, failure.failure);
                                },
                                Err(error) => log::warn!("could not read pending deliveries: {error}"),
                            }
                        };
                        tokio::select! { () = maintenance_stop.cancelled() => {}, () = work => {} }
                    });
                    local.block_on(&rt, async move {
                        let (driving, receiving, maintaining) = tokio::join!(driving, receiving, maintaining);
                        receiving.map_err(|error| RuntimeError::Worker(error.to_string()))?;
                        maintaining.map_err(|error| RuntimeError::Worker(error.to_string()))?;
                        let outcome = driving.map_err(|error| RuntimeError::Worker(error.to_string()))?;
                        let reason = match outcome {
                            Ok(()) => "the local agent process exited".to_owned(),
                            Err(error) => error.to_string(),
                        };
                        if let Some(owner) = weak.upgrade() {
                            owner.after_exit(watched_lease, watched_scope, watched_agent, cwd, reason).await;
                        }
                        Ok(())
                    })
                }).map_err(RuntimeError::Start).map_err(E::from)?;
                workers.push(Worker {
                    lease: Arc::clone(&lease),
                    thread,
                });
            }
            let handshake = tokio::select! {
                () = scope.cancelled() => return Err(E::from(RuntimeError::Gone)),
                result = handshake => result.map_err(|_| E::from(RuntimeError::Gone))?
                    .map_err(RuntimeError::Agent).map_err(E::from)?,
            };
            let live = Handle {
                client,
                agent_id: agent,
                anchor: handshake.session_id,
                desk,
                questions,
                book,
            };
            ready
                .send(live.clone())
                .map_err(|_| E::from(RuntimeError::Gone))?;
            {
                let mut state = self.state()?;
                if state.closed
                    || scope.is_cancelled()
                    || lease.is_cancelled()
                    || !Arc::ptr_eq(&scope, &state.scope)
                {
                    return Err(E::from(RuntimeError::Gone));
                }
                let connection = state
                    .connection
                    .as_mut()
                    .filter(|connection| Arc::ptr_eq(&connection.lease, &lease))
                    .ok_or_else(|| E::from(RuntimeError::Gone))?;
                connection.anchor = Some(live.anchor.clone());
                state.daemon.note_started();
            }
            attempt.committed = true;
            Ok(live)
        })
    }
    async fn after_exit(
        self: Arc<Self>,
        lease: Arc<CancellationToken>,
        scope: Arc<CancellationToken>,
        agent: String,
        cwd: PathBuf,
        reason: String,
    ) {
        let reaction = {
            let mut state = match self.state() {
                Ok(state) => state,
                Err(error) => {
                    log::error!("could not retire an ended connection: {error}");
                    return;
                }
            };
            if !state
                .connection
                .as_ref()
                .is_some_and(|connection| Arc::ptr_eq(&connection.lease, &lease))
            {
                return;
            }
            let connection = state.connection.take();
            let ready = connection
                .as_ref()
                .is_some_and(|connection| connection.anchor.is_some());
            if let Some(connection) = connection {
                connection.retire();
            }
            if !ready || state.closed || scope.is_cancelled() || !Arc::ptr_eq(&scope, &state.scope)
            {
                return;
            }
            state.daemon.note_exited(&reason)
        };
        let Reaction::StartAfter(wait) = reaction else {
            return;
        };
        tokio::select! { () = scope.cancelled() => return, () = tokio::time::sleep(wait) => {} }
        let restarting = self.acquire(agent, cwd, Takeover::Preserve, Some(Arc::clone(&scope)));
        tokio::select! {
            () = scope.cancelled() => {},
            result = restarting => if let Err(error) = result {
                log::warn!("the agent daemon could not restart: {error}");
            },
        }
    }
}
