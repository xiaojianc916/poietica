//! Owns scheduling and reconciliation; the injected executor owns conversation access.
use futures::{StreamExt, stream};
use poietica_automation::{AutomationCatalog, AutomationRunOutcome as Outcome, Execution};
use poietica_conversation::{identity::TurnId, ports::ConversationLedger, turn::DeliveryState};
use poietica_ledger::{
    LedgerError,
    execution::{IndexError, LocalIndex, read_index, write_index},
};
use poietica_time::WallClock;
use std::fmt::Display;
use std::fs::File;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

const POLL: Duration = Duration::from_secs(2);
const CALL_LIMIT: Duration = Duration::from_secs(90);
const PARALLELISM: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Observation {
    Active,
    Succeeded,
    Failed,
    Cancelled,
    Missing,
}

pub trait Executor: Send + Sync + 'static {
    type Failure: Display + Send;
    fn default_agent(&self) -> Result<String, Self::Failure>;
    fn submit(
        &self,
        execution: &Execution,
    ) -> impl Future<Output = Result<String, Self::Failure>> + Send;
    fn inspect(
        &self,
        execution: &Execution,
    ) -> impl Future<Output = Result<Observation, Self::Failure>> + Send;
    fn cancel(
        &self,
        execution: &Execution,
    ) -> impl Future<Output = Result<(), Self::Failure>> + Send;
}

#[derive(Debug)]
pub struct Runtime {
    stopping: CancellationToken,
    wake: Arc<Notify>,
    worker: Mutex<Option<JoinHandle<()>>>,
}
impl Runtime {
    pub fn start<E, X, C, P>(
        index: LocalIndex<E>,
        executor: X,
        clock: C,
        publish: P,
        ownership: File,
    ) -> std::io::Result<Self>
    where
        E: From<IndexError> + From<LedgerError> + Display + Send + 'static,
        X: Executor,
        C: WallClock + 'static,
        P: Fn(AutomationCatalog) + Send + 'static,
    {
        let stopping = CancellationToken::new();
        let stop = stopping.clone();
        let wake = Arc::new(Notify::new());
        let notice = Arc::clone(&wake);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let worker = std::thread::Builder::new().name("poietica-automation".to_owned()).spawn(move || {
            let _ownership = ownership;
            runtime.block_on(async move {
                loop {
                    tokio::select! {
                        biased;
                        () = stop.cancelled() => break,
                        result = cycle(&index, &executor, &clock, &publish) => {
                            if let Err(error) = result { log::error!("automation reconciliation failed: {error}"); }
                        }
                    }
                    tokio::select! {
                        () = stop.cancelled() => break,
                        () = notice.notified() => {},
                        () = tokio::time::sleep(POLL) => {},
                    }
                }
            });
        })?;
        Ok(Self {
            stopping,
            wake,
            worker: Mutex::new(Some(worker)),
        })
    }
    pub fn wake(&self) {
        self.wake.notify_one();
    }
    pub fn stop(&self) -> std::io::Result<()> {
        self.stopping.cancel();
        let worker = self
            .worker
            .lock()
            .map_err(|_| std::io::Error::other("automation worker ownership poisoned"))?
            .take();
        if let Some(worker) = worker {
            worker
                .join()
                .map_err(|_| std::io::Error::other("automation worker panicked"))?;
        }
        Ok(())
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            log::error!("automation shutdown failed: {error}");
        }
    }
}

async fn cycle<E, X, C, P>(
    index: &LocalIndex<E>,
    executor: &X,
    clock: &C,
    publish: &P,
) -> Result<(), E>
where
    E: From<IndexError> + From<LedgerError> + Display + Send + 'static,
    X: Executor,
    C: WallClock,
    P: Fn(AutomationCatalog),
{
    let state = read_index(index, |store| store.automation_state().map_err(E::from)).await?;
    let revision = state.revision;
    let now = clock.now_unix_millis();
    let due = state.due(now).map_err(LedgerError::from).map_err(E::from)?;
    let mut failure = None;
    if !due.is_empty() {
        match executor.default_agent() {
            Ok(agent) => {
                if let Err(error) = write_index(index, move |store| {
                    store.automation_sweep(&agent, now).map_err(E::from)
                })
                .await
                {
                    failure = Some(error);
                }
            }
            Err(error) => log::warn!("automation schedule is waiting for an agent: {error}"),
        }
    }
    let state = read_index(index, |store| store.automation_state().map_err(E::from)).await?;
    let mut work = stream::iter(state.executions.into_values())
        .map(|execution| advance(index, executor, execution))
        .buffer_unordered(PARALLELISM);
    // One failed ledger operation must not cancel other admitted submissions.
    while let Some(result) = work.next().await {
        if let Err(error) = result {
            log::error!("automation execution reconciliation failed: {error}");
            if failure.is_none() {
                failure = Some(error);
            }
        }
    }
    let catalog = read_index(index, |store| store.automation_catalog().map_err(E::from)).await?;
    if catalog.revision != revision {
        publish(catalog);
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

async fn record<E>(
    index: &LocalIndex<E>,
    id: String,
    outcome: Outcome,
    message: Option<String>,
) -> Result<(), E>
where
    E: From<IndexError> + From<LedgerError> + Send + 'static,
{
    write_index(index, move |store| {
        store
            .automation_transition(&id, outcome, message)
            .map_err(E::from)
    })
    .await
}

async fn advance<E, X>(index: &LocalIndex<E>, executor: &X, execution: Execution) -> Result<(), E>
where
    E: From<IndexError> + From<LedgerError> + Display + Send + 'static,
    X: Executor,
{
    let id = execution.run.id.clone();
    if execution.run.outcome == Outcome::Queued {
        let requested = id.clone();
        let Some(owned) = write_index(index, move |store| {
            store.automation_dispatch(&requested).map_err(E::from)
        })
        .await?
        else {
            return Ok(());
        };
        let delivered = tokio::time::timeout(CALL_LIMIT, executor.submit(&owned)).await;
        match delivered {
            Ok(Ok(prompt)) if prompt == id => {
                return record(index, id, Outcome::Running, None).await;
            }
            Ok(Ok(prompt)) => {
                log::error!("automation {id} received a different prompt identity: {prompt}");
            }
            Ok(Err(error)) => {
                log::warn!("automation {id} submission failed: {error}");
            }
            Err(error) => {
                log::warn!("automation {id} submission receipt timed out: {error}");
            }
        }
        let turn = TurnId::new(id.clone());
        // A writer-lane barrier includes accepted admission writes whose waiter was dropped.
        // The delivery read keeps its domain error: a failed read settles Uncertain, never Failed.
        let delivery = write_index(index, move |store| Ok(store.delivery_state(&turn))).await?;
        let (outcome, message) = match delivery {
            Ok(None) | Ok(Some(DeliveryState::Failed)) => (
                Outcome::Failed,
                "提交前准备失败或代理明确拒绝；请查看诊断信息",
            ),
            Ok(Some(_)) => (
                Outcome::Uncertain,
                "投递结果未确认；保留原身份核对，不会自动重发",
            ),
            Err(_) => (
                Outcome::Uncertain,
                "投递状态读取失败；保留原身份核对，不会自动重发",
            ),
        };
        return record(index, id, outcome, Some(message.to_owned())).await;
    }
    let observed = tokio::time::timeout(CALL_LIMIT, executor.inspect(&execution)).await;
    let observation = match observed {
        Ok(Ok(observation)) => observation,
        Ok(Err(error)) => {
            log::warn!("automation {id} completion read failed: {error}");
            return record(
                index,
                id,
                Outcome::Uncertain,
                Some("官方完成状态暂不可用；未重发，也未伪造终态".to_owned()),
            )
            .await;
        }
        Err(error) => {
            log::warn!("automation {id} completion read timed out: {error}");
            return record(
                index,
                id,
                Outcome::Uncertain,
                Some("核对完成状态超时，稍后按同一身份继续核对".to_owned()),
            )
            .await;
        }
    };
    let terminal = match observation {
        Observation::Succeeded => Some(Outcome::Succeeded),
        Observation::Failed => Some(Outcome::Failed),
        Observation::Cancelled => Some(Outcome::Cancelled),
        Observation::Active | Observation::Missing => None,
    };
    if let Some(outcome) = terminal {
        return record(index, id, outcome, None).await;
    }
    if observation == Observation::Missing {
        let turn = TurnId::new(id.clone());
        let delivery = write_index(index, move |store| Ok(store.delivery_state(&turn))).await?;
        let (outcome, message) = match delivery {
            Ok(None) | Ok(Some(DeliveryState::Failed)) => (
                Outcome::Failed,
                "未进入提交管线或已被明确拒绝；本次运行未重新投递",
            ),
            Ok(Some(_)) | Err(_) => (
                Outcome::Uncertain,
                "官方记录尚未找到此提交；保留原身份，不会重新投递",
            ),
        };
        return record(index, id, outcome, Some(message.to_owned())).await;
    }
    if execution.cancel_requested {
        let (outcome, message) =
            match tokio::time::timeout(CALL_LIMIT, executor.cancel(&execution)).await {
                Ok(Ok(())) => (Outcome::Cancelling, "停止请求已送达，等待官方终态确认"),
                Ok(Err(error)) => {
                    log::warn!("automation {id} stop request failed: {error}");
                    (
                        Outcome::Uncertain,
                        "停止请求未确认，仍保留取消意图；稍后继续核对",
                    )
                }
                Err(error) => {
                    log::warn!("automation {id} stop request timed out: {error}");
                    (
                        Outcome::Uncertain,
                        "停止请求超时，不能宣称已取消；稍后继续核对",
                    )
                }
            };
        record(index, id, outcome, Some(message.to_owned())).await
    } else {
        record(index, id, Outcome::Running, None).await
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, reason = "fixture failures must fail the test")]
    use super::*;
    use poietica_automation::{AutomationCreation, Command};
    use poietica_time::wall_clock::SystemWallClock;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use uuid::Uuid;

    struct Fake {
        submissions: AtomicUsize,
        observation: Mutex<Observation>,
        read_fails: AtomicBool,
        cancel_fails: AtomicBool,
    }
    impl Fake {
        fn active() -> Self {
            Self {
                submissions: AtomicUsize::new(0),
                observation: Mutex::new(Observation::Active),
                read_fails: AtomicBool::new(false),
                cancel_fails: AtomicBool::new(false),
            }
        }
    }
    impl Executor for Fake {
        type Failure = &'static str;
        fn default_agent(&self) -> Result<String, Self::Failure> {
            Ok("agent".to_owned())
        }
        fn submit(
            &self,
            execution: &Execution,
        ) -> impl Future<Output = Result<String, Self::Failure>> + Send {
            self.submissions.fetch_add(1, Ordering::SeqCst);
            std::future::ready(Ok(execution.run.id.clone()))
        }
        fn inspect(
            &self,
            _: &Execution,
        ) -> impl Future<Output = Result<Observation, Self::Failure>> + Send {
            std::future::ready(if self.read_fails.load(Ordering::SeqCst) {
                Err("offline")
            } else {
                Ok(*self.observation.lock().expect("observation"))
            })
        }
        fn cancel(&self, _: &Execution) -> impl Future<Output = Result<(), Self::Failure>> + Send {
            let answer = if self.cancel_fails.load(Ordering::SeqCst) {
                Err("offline")
            } else {
                *self.observation.lock().expect("observation") = Observation::Cancelled;
                Ok(())
            };
            std::future::ready(answer)
        }
    }
    async fn claimed(index: &LocalIndex<IndexError>, root: String) -> String {
        let run = Uuid::new_v4().to_string();
        let request = run.clone();
        write_index(index, move |store| {
            store.import_automations(None, "UTC")?;
            let catalog = store.automation_command(Command::Create(AutomationCreation {
                title: "Run".to_owned(),
                prompt: "Work".to_owned(),
                schedule: None,
                session_config: Default::default(),
                workspace_root: root,
                time_zone: "UTC".to_owned(),
            }))?;
            let id = catalog.automations.first().expect("row").id.clone();
            store.automation_manual(&id, &request, "agent")?;
            Ok::<_, IndexError>(())
        })
        .await
        .expect("claim");
        run
    }
    async fn outcome(index: &LocalIndex<IndexError>) -> Outcome {
        read_index(index, |store| {
            Ok::<_, IndexError>(
                store
                    .automation_catalog()?
                    .automations
                    .first()
                    .expect("row")
                    .runs
                    .first()
                    .expect("run")
                    .outcome,
            )
        })
        .await
        .expect("outcome")
    }
    #[tokio::test]
    async fn reopening_the_real_database_reconciles_without_resubmission() {
        let directory = tempfile::tempdir().expect("directory");
        let file = directory.path().join("index.sqlite3");
        let index = LocalIndex::<IndexError>::open(&file, SystemWallClock).expect("index");
        claimed(&index, directory.path().to_string_lossy().into_owned()).await;
        let fake = Fake::active();
        cycle(&index, &fake, &SystemWallClock, &|_| {})
            .await
            .expect("submit");
        assert_eq!(outcome(&index).await, Outcome::Running);
        drop(index);
        let index = LocalIndex::<IndexError>::open(&file, SystemWallClock).expect("reopen");
        fake.read_fails.store(true, Ordering::SeqCst);
        cycle(&index, &fake, &SystemWallClock, &|_| {})
            .await
            .expect("offline reconciliation");
        assert_eq!(outcome(&index).await, Outcome::Uncertain);
        assert_eq!(fake.submissions.load(Ordering::SeqCst), 1);
        fake.read_fails.store(false, Ordering::SeqCst);
        *fake.observation.lock().expect("observation") = Observation::Succeeded;
        cycle(&index, &fake, &SystemWallClock, &|_| {})
            .await
            .expect("settlement");
        assert_eq!(outcome(&index).await, Outcome::Succeeded);
        assert_eq!(fake.submissions.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn cancellation_failure_is_not_reported_as_delivery_or_completion() {
        let directory = tempfile::tempdir().expect("directory");
        let index = LocalIndex::<IndexError>::open(
            &directory.path().join("index.sqlite3"),
            SystemWallClock,
        )
        .expect("index");
        let run = claimed(&index, directory.path().to_string_lossy().into_owned()).await;
        let fake = Fake::active();
        cycle(&index, &fake, &SystemWallClock, &|_| {})
            .await
            .expect("submit");
        write_index(&index, move |store| {
            store
                .automation_command(Command::Cancel { run_id: run })
                .map_err(IndexError::from)
        })
        .await
        .expect("cancel intent");
        fake.cancel_fails.store(true, Ordering::SeqCst);
        cycle(&index, &fake, &SystemWallClock, &|_| {})
            .await
            .expect("failed cancellation");
        assert_eq!(outcome(&index).await, Outcome::Uncertain);
        fake.cancel_fails.store(false, Ordering::SeqCst);
        cycle(&index, &fake, &SystemWallClock, &|_| {})
            .await
            .expect("delivered cancellation");
        assert_eq!(outcome(&index).await, Outcome::Cancelling);
        cycle(&index, &fake, &SystemWallClock, &|_| {})
            .await
            .expect("confirmed cancellation");
        assert_eq!(outcome(&index).await, Outcome::Cancelled);
    }
    #[tokio::test]
    async fn a_crash_before_admission_does_not_create_a_second_submission() {
        let directory = tempfile::tempdir().expect("directory");
        let file = directory.path().join("index.sqlite3");
        let index = LocalIndex::<IndexError>::open(&file, SystemWallClock).expect("index");
        let run = claimed(&index, directory.path().to_string_lossy().into_owned()).await;
        write_index(&index, move |store| {
            store.automation_dispatch(&run).map_err(IndexError::from)
        })
        .await
        .expect("durable dispatch");
        drop(index);
        let index = LocalIndex::<IndexError>::open(&file, SystemWallClock).expect("reopen");
        let fake = Fake::active();
        *fake.observation.lock().expect("observation") = Observation::Missing;
        cycle(&index, &fake, &SystemWallClock, &|_| {})
            .await
            .expect("recover");
        assert_eq!(outcome(&index).await, Outcome::Failed);
        assert_eq!(fake.submissions.load(Ordering::SeqCst), 0);
    }
}
