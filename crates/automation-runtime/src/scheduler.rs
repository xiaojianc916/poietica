use crate::{Executor, PARALLELISM, POLL, execution::advance};
use poietica_automation::{AutomationCatalog, AutomationState};
use poietica_ledger::{
    LedgerError,
    execution::{IndexError, LocalIndex, read_index, write_index},
};
use poietica_time::WallClock;
use std::{
    collections::HashMap,
    fmt::Display,
    fs::File,
    sync::{Arc, Mutex},
    thread::JoinHandle,
};
use tokio::{
    sync::Notify,
    task::{Id, JoinSet},
    time::{Instant, MissedTickBehavior},
};
use tokio_util::sync::CancellationToken;

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
        P: Fn(AutomationCatalog) -> bool + Send + 'static,
    {
        let stopping = CancellationToken::new();
        let stop = stopping.clone();
        let wake = Arc::new(Notify::new());
        let notice = Arc::clone(&wake);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let worker = std::thread::Builder::new()
            .name("poietica-automation".to_owned())
            .spawn(move || {
                let _ownership = ownership;
                runtime.block_on(drive(
                    index,
                    Arc::new(executor),
                    clock,
                    publish,
                    stop,
                    notice,
                ));
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
        // Retain the lock until join finishes so concurrent stop callers share the barrier.
        let mut worker = self
            .worker
            .lock()
            .map_err(|_| std::io::Error::other("automation worker ownership poisoned"))?;
        if let Some(worker) = worker.take() {
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

async fn schedule<E, X, C>(
    index: &LocalIndex<E>,
    executor: &X,
    clock: &C,
) -> Result<AutomationState, E>
where
    E: From<IndexError> + From<LedgerError> + Display + Send + 'static,
    X: Executor,
    C: WallClock,
{
    let now = clock.now_unix_millis();
    match executor.default_agent() {
        Ok(agent) => {
            if let Err(error) = write_index(index, move |store| {
                store.automation_sweep(&agent, now).map_err(E::from)
            })
            .await
            {
                log::error!("automation schedule could not commit: {error}");
            }
        }
        Err(error) => {
            let message = format!("计划正在等待默认代理：{error}");
            write_index(index, move |store| {
                store.automation_scheduler_issue(&message).map_err(E::from)
            })
            .await?;
        }
    }
    read_index(index, |store| store.automation_state().map_err(E::from)).await
}

async fn drive<E, X, C, P>(
    index: LocalIndex<E>,
    executor: Arc<X>,
    clock: C,
    publish: P,
    stopping: CancellationToken,
    wake: Arc<Notify>,
) where
    E: From<IndexError> + From<LedgerError> + Display + Send + 'static,
    X: Executor,
    C: WallClock,
    P: Fn(AutomationCatalog) -> bool,
{
    let mut tick = tokio::time::interval(POLL);
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut tasks = JoinSet::<Result<(), E>>::new();
    let mut owners = HashMap::<Id, String>::new();
    let mut attempted = HashMap::<String, Instant>::new();
    let mut published = None;
    loop {
        tokio::select! {
            biased;
            () = stopping.cancelled() => break,
            joined = tasks.join_next_with_id(), if !tasks.is_empty() => {
                if let Some(joined) = joined {
                    let id = match joined {
                        Ok((id, result)) => {
                            if let Err(error) = result { log::error!("automation execution could not commit: {error}"); }
                            id
                        }
                        Err(error) => {
                            log::error!("automation operation stopped without a terminal observation: {error}");
                            error.id()
                        }
                    };
                    if let Some(run) = owners.remove(&id) { attempted.insert(run, Instant::now()); }
                }
            }
            _instant = tick.tick() => {},
            () = wake.notified() => {},
        }
        let state = tokio::select! {
            biased;
            () = stopping.cancelled() => break,
            state = schedule(&index, executor.as_ref(), &clock) => state,
        };
        let state = match state {
            Ok(state) => state,
            Err(error) => {
                log::error!("automation catalog could not be reconciled: {error}");
                continue;
            }
        };
        if published != Some(state.revision) && publish(state.catalog()) {
            published = Some(state.revision);
        }
        let now = Instant::now();
        attempted.retain(|run, _| state.executions.values().any(|entry| &entry.run.id == run));
        let mut ready: Vec<_> = state
            .executions
            .into_values()
            .filter(|execution| {
                !owners.values().any(|run| run == &execution.run.id)
                    && attempted
                        .get(&execution.run.id)
                        .is_none_or(|at| now.duration_since(*at) >= POLL)
            })
            .collect();
        ready.sort_by_key(|execution| attempted.get(&execution.run.id).copied());
        for execution in ready
            .into_iter()
            .take(PARALLELISM.saturating_sub(owners.len()))
        {
            let run = execution.run.id.clone();
            let index = index.clone();
            let executor = Arc::clone(&executor);
            let task =
                tasks.spawn(async move { advance(&index, executor.as_ref(), execution).await });
            attempted.insert(run.clone(), now);
            owners.insert(task.id(), run);
        }
    }
    // Stopping observation is not evidence that an accepted remote prompt was cancelled.
    tasks.abort_all();
    while let Some(result) = tasks.join_next().await {
        if let Err(error) = result
            && !error.is_cancelled()
        {
            log::error!("automation operation shutdown failed: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Observation;
    use poietica_automation::{AutomationCreation, Command, Execution};
    use poietica_time::wall_clock::SystemWallClock;
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    struct HeldExecutor {
        started: Arc<AtomicUsize>,
    }
    impl Executor for HeldExecutor {
        type Failure = &'static str;
        fn default_agent(&self) -> Result<String, Self::Failure> {
            Ok("agent".to_owned())
        }
        async fn submit(&self, _: &Execution) -> Result<String, Self::Failure> {
            self.started.fetch_add(1, Ordering::SeqCst);
            std::future::pending().await
        }
        async fn inspect(&self, _: &Execution) -> Result<Observation, Self::Failure> {
            std::future::pending().await
        }
        async fn cancel(&self, _: &Execution) -> Result<(), Self::Failure> {
            std::future::pending().await
        }
    }

    #[tokio::test]
    async fn publication_and_shutdown_do_not_wait_for_slow_remote_operations()
    -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        let index = LocalIndex::<IndexError>::open(
            &directory.path().join("index.sqlite3"),
            SystemWallClock,
        )?;
        let root = directory.path().to_string_lossy().into_owned();
        write_index(&index, move |store| {
            store.import_automations(None, "UTC")?;
            for _ in 0..6 {
                let catalog = store.automation_command(Command::Create(AutomationCreation {
                    title: "Work".to_owned(), prompt: "Inspect".to_owned(), schedule: None,
                    session_config: BTreeMap::new(), workspace_root: root.clone(), time_zone: "UTC".to_owned(),
                }))?;
                #[allow(clippy::expect_used, reason = "fixture creates rows unconditionally; None means the command path broke")]
                let id = catalog.automations.first().expect("row").id.clone();
                store.automation_manual(&id, &uuid::Uuid::new_v4().to_string(), "agent")?;
            }
            Ok::<_, IndexError>(())
        }).await?;
        let started = Arc::new(AtomicUsize::new(0));
        let stop = CancellationToken::new();
        let wake = Arc::new(Notify::new());
        let (published, mut publications) = tokio::sync::mpsc::unbounded_channel();
        let worker = tokio::spawn(drive(
            index,
            Arc::new(HeldExecutor {
                started: Arc::clone(&started),
            }),
            SystemWallClock,
            move |catalog| published.send(catalog.revision).is_ok(),
            stop.clone(),
            Arc::clone(&wake),
        ));
        let revision = tokio::time::timeout(Duration::from_secs(5), publications.recv())
            .await?
            .ok_or("publisher ended")?;
        tokio::time::timeout(Duration::from_secs(5), async {
            while started.load(Ordering::SeqCst) < PARALLELISM {
                tokio::task::yield_now().await;
            }
        })
        .await?;
        assert_eq!(started.load(Ordering::SeqCst), PARALLELISM);
        wake.notify_one();
        let dispatch_revision = tokio::time::timeout(Duration::from_secs(5), publications.recv())
            .await?
            .ok_or("publisher ended")?;
        assert!(dispatch_revision > revision);
        stop.cancel();
        tokio::time::timeout(Duration::from_secs(5), worker).await??;
        Ok(())
    }
}
