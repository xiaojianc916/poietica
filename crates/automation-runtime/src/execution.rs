use crate::{CALL_LIMIT, Executor, Observation};
use poietica_automation::{AutomationRunOutcome as Outcome, Execution};
use poietica_conversation::{identity::TurnId, ports::ConversationLedger, turn::DeliveryState};
use poietica_ledger::{
    LedgerError,
    execution::{IndexError, LocalIndex, read_index, write_index},
};
use std::fmt::Display;

// Accepted writer jobs may outlive their awaiter; observe them behind a writer-lane barrier.
async fn unresolved<E>(index: &LocalIndex<E>, id: String) -> Result<(), E>
where
    E: From<IndexError> + From<LedgerError> + Send + 'static,
{
    let requested = id.clone();
    let (execution, delivery) = write_index(index, move |store| {
        let execution = store.automation_execution(&requested).map_err(E::from)?;
        Ok((execution, store.delivery_state(&TurnId::new(requested))))
    })
    .await?;
    let Some(execution) = execution else {
        return Ok(());
    };
    let outcome = match delivery {
        Ok(None | Some(DeliveryState::Failed)) => {
            if execution.cancel_requested {
                Outcome::Cancelled
            } else {
                Outcome::Failed
            }
        }
        Ok(Some(_)) | Err(_) => Outcome::Uncertain,
    };
    let message = match outcome {
        Outcome::Cancelled => "取消先于提交生效；未重新投递",
        Outcome::Failed => "未进入提交管线或已被明确拒绝；未重新投递",
        _ => "送达或官方终态尚未确认；保留同一身份核对，不会自动重发",
    };
    record(index, id, outcome, Some(message.to_owned())).await
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

pub(super) async fn advance<E, X>(
    index: &LocalIndex<E>,
    executor: &X,
    execution: Execution,
) -> Result<(), E>
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
        return unresolved(index, id).await;
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
        return unresolved(index, id).await;
    }
    let requested = id.clone();
    let Some(execution) = read_index(index, move |store| {
        store.automation_execution(&requested).map_err(E::from)
    })
    .await?
    else {
        return Ok(());
    };
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
    use std::future::Future;
    use std::sync::Mutex;

    async fn reconcile(index: &LocalIndex<IndexError>, executor: &Fake) -> Result<(), IndexError> {
        let state = read_index(index, |store| {
            store.automation_state().map_err(IndexError::from)
        })
        .await?;
        for execution in state.executions.into_values() {
            advance(index, executor, execution).await?;
        }
        Ok(())
    }
    use poietica_automation::{AutomationCreation, Command};
    use poietica_time::wall_clock::SystemWallClock;
    use std::collections::BTreeMap;
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
                session_config: BTreeMap::new(),
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
        reconcile(&index, &fake).await.expect("submit");
        assert_eq!(outcome(&index).await, Outcome::Running);
        drop(index);
        let index = LocalIndex::<IndexError>::open(&file, SystemWallClock).expect("reopen");
        fake.read_fails.store(true, Ordering::SeqCst);
        reconcile(&index, &fake)
            .await
            .expect("offline reconciliation");
        assert_eq!(outcome(&index).await, Outcome::Uncertain);
        assert_eq!(fake.submissions.load(Ordering::SeqCst), 1);
        fake.read_fails.store(false, Ordering::SeqCst);
        *fake.observation.lock().expect("observation") = Observation::Succeeded;
        reconcile(&index, &fake).await.expect("settlement");
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
        reconcile(&index, &fake).await.expect("submit");
        write_index(&index, move |store| {
            store
                .automation_command(Command::Cancel { run_id: run })
                .map_err(IndexError::from)
        })
        .await
        .expect("cancel intent");
        fake.cancel_fails.store(true, Ordering::SeqCst);
        reconcile(&index, &fake).await.expect("failed cancellation");
        assert_eq!(outcome(&index).await, Outcome::Uncertain);
        fake.cancel_fails.store(false, Ordering::SeqCst);
        reconcile(&index, &fake)
            .await
            .expect("delivered cancellation");
        assert_eq!(outcome(&index).await, Outcome::Cancelling);
        reconcile(&index, &fake)
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
        reconcile(&index, &fake).await.expect("recover");
        assert_eq!(outcome(&index).await, Outcome::Failed);
        assert_eq!(fake.submissions.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn cancelled_preparation_is_not_reported_as_a_failed_execution() {
        let directory = tempfile::tempdir().expect("directory");
        let index = LocalIndex::<IndexError>::open(
            &directory.path().join("index.sqlite3"),
            SystemWallClock,
        )
        .expect("index");
        let run = claimed(&index, directory.path().to_string_lossy().into_owned()).await;
        let requested = run.clone();
        write_index(&index, move |store| {
            store.automation_dispatch(&requested)?;
            store.automation_command(Command::Cancel { run_id: requested })?;
            Ok::<_, IndexError>(())
        })
        .await
        .expect("cancel before admission");
        unresolved(&index, run).await.expect("reconcile");
        assert_eq!(outcome(&index).await, Outcome::Cancelled);
    }

    #[tokio::test]
    async fn cancellation_arriving_after_the_execution_snapshot_is_observed() {
        let directory = tempfile::tempdir().expect("directory");
        let index = LocalIndex::<IndexError>::open(
            &directory.path().join("index.sqlite3"),
            SystemWallClock,
        )
        .expect("index");
        let run = claimed(&index, directory.path().to_string_lossy().into_owned()).await;
        let requested = run.clone();
        let snapshot = write_index(&index, move |store| {
            let owned = store.automation_dispatch(&requested)?.expect("execution");
            store.automation_command(Command::Cancel { run_id: requested })?;
            Ok::<_, IndexError>(owned)
        })
        .await
        .expect("intent");
        assert!(!snapshot.cancel_requested);
        let fake = Fake::active();
        advance(&index, &fake, snapshot)
            .await
            .expect("fresh cancellation");
        assert_eq!(outcome(&index).await, Outcome::Cancelling);
        assert_eq!(
            *fake.observation.lock().expect("observation"),
            Observation::Cancelled
        );
    }
}
