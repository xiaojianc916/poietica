//! Atomic automation state, durable command deduplication and conversation ownership.
mod import;

use crate::{LedgerError, index::AgentStore};
use poietica_automation::{
    AutomationCatalog, AutomationError, AutomationRunOutcome, AutomationState, ClaimOrigin,
    Command, Execution,
};
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use uuid::Uuid;

type Result<T> = std::result::Result<T, LedgerError>;

impl AgentStore {
    pub fn automation_initialized(&self) -> Result<bool> {
        Ok(self.connection.query_row(
            "SELECT document IS NOT NULL FROM automation_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?)
    }

    pub fn automation_state(&self) -> Result<AutomationState> {
        let document: Option<String> = self.connection.query_row(
            "SELECT document FROM automation_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        let state: AutomationState =
            serde_json::from_str(&document.ok_or(AutomationError::Uninitialized)?)?;
        state.validate()?;
        Ok(state)
    }

    pub fn automation_catalog(&self) -> Result<AutomationCatalog> {
        Ok(self.automation_state()?.catalog())
    }

    fn automation_transaction<T>(
        &self,
        edit: impl FnOnce(&mut AutomationState, &Self) -> Result<T>,
    ) -> Result<(T, AutomationCatalog)> {
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let mut state = self.automation_state()?;
        let before = state.clone();
        let result = edit(&mut state, self)?;
        state.validate()?;
        if state != before {
            state.revision = before
                .revision
                .checked_add(1)
                .ok_or(AutomationError::Conflict)?;
            self.connection.execute(
                "UPDATE automation_state SET document = ?1 WHERE singleton = 1",
                params![serde_json::to_string(&state)?],
            )?;
        }
        let catalog = state.catalog();
        transaction.commit()?;
        Ok((result, catalog))
    }

    pub fn automation_command(&self, command: Command) -> Result<AutomationCatalog> {
        let now = self.clock().now_unix_millis();
        self.automation_transaction(move |state, _| {
            state.apply(command, now, Uuid::new_v4().to_string())?;
            Ok(())
        })
        .map(|((), catalog)| catalog)
    }

    pub fn automation_manual(
        &self,
        id: &str,
        request_id: &str,
        agent_id: &str,
    ) -> Result<AutomationCatalog> {
        let request = Uuid::parse_str(request_id)
            .map_err(|error| AutomationError::Data(error.to_string()))?
            .to_string();
        let now = self.clock().now_unix_millis();
        self.automation_transaction(|state, store| {
            claim(
                store,
                state,
                id,
                ClaimOrigin::Manual,
                &request,
                agent_id,
                now,
            )?;
            Ok(())
        })
        .map(|((), catalog)| catalog)
    }

    pub fn automation_sweep(&self, agent_id: &str, now: i64) -> Result<AutomationCatalog> {
        self.automation_transaction(|state, store| {
            state.reconcile_schedules(now)?;
            for (id, at) in state.due(now)? {
                claim(
                    store,
                    state,
                    &id,
                    ClaimOrigin::Scheduled(at),
                    &Uuid::new_v4().to_string(),
                    agent_id,
                    now,
                )?;
            }
            Ok(())
        })
        .map(|((), catalog)| catalog)
    }

    pub fn automation_execution(&self, run_id: &str) -> Result<Option<Execution>> {
        Ok(self
            .automation_state()?
            .executions
            .into_values()
            .find(|entry| entry.run.id == run_id))
    }

    pub fn automation_scheduler_issue(&self, message: &str) -> Result<()> {
        let now = self.clock().now_unix_millis();
        self.automation_transaction(|state, _| {
            state.reconcile_schedules(now)?;
            for row in state.automations.iter_mut().filter(|row| row.enabled) {
                row.issue = Some(message.to_owned());
            }
            Ok(())
        })
        .map(|_| ())
    }

    pub fn automation_dispatch(&self, run_id: &str) -> Result<Option<Execution>> {
        self.automation_transaction(|state, _| Ok(state.dispatch(run_id)))
            .map(|(execution, _)| execution)
    }

    pub fn automation_transition(
        &self,
        run_id: &str,
        outcome: AutomationRunOutcome,
        message: Option<String>,
    ) -> Result<()> {
        let now = self.clock().now_unix_millis();
        self.automation_transaction(|state, _| {
            state.transition(run_id, outcome, message, now)?;
            Ok(())
        })
        .map(|_| ())
    }

    pub fn automation_thread_busy(&self, thread_id: Uuid) -> Result<bool> {
        if !self.automation_initialized()? {
            return Ok(false);
        }
        let id = thread_id.to_string();
        Ok(self
            .automation_state()?
            .executions
            .values()
            .any(|entry| entry.run.thread_id.as_deref() == Some(id.as_str())))
    }
}

fn claim(
    store: &AgentStore,
    state: &mut AutomationState,
    id: &str,
    origin: ClaimOrigin,
    proposed: &str,
    agent_id: &str,
    now: i64,
) -> Result<()> {
    let request_id = matches!(&origin, ClaimOrigin::Manual).then(|| proposed.to_owned());
    let key = match &origin {
        ClaimOrigin::Manual => format!("manual:{id}:{proposed}"),
        ClaimOrigin::Scheduled(at) => format!("schedule:{id}:{at}"),
    };
    let recorded: Option<String> = store
        .connection
        .query_row(
            "SELECT run_id FROM automation_claims WHERE command_key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()?;
    if recorded.is_some() {
        if let ClaimOrigin::Scheduled(at) = origin {
            state.advance_due(id, &at, now)?;
        }
        return Ok(());
    }
    let reused: bool = store.connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM automation_claims WHERE run_id = ?1 OR request_id = ?1)",
        params![proposed],
        |row| row.get(0),
    )?;
    if reused {
        return Err(AutomationError::Conflict.into());
    }
    let thread = Uuid::now_v7();
    let Some(execution) = state.claim(
        id,
        origin,
        proposed.to_owned(),
        thread.to_string(),
        agent_id.to_owned(),
        now,
    )?
    else {
        return Ok(());
    };
    if execution.run.id == proposed {
        let title: String = execution.title.chars().take(60).collect();
        store.create_thread(thread, &title, Some(&execution.workspace_root))?;
        store.name_by_user(thread, &title)?;
    }
    store.connection.execute(
        "INSERT INTO automation_claims(command_key, run_id, request_id) VALUES (?1, ?2, ?3)",
        params![key, execution.run.id, request_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "failed persistence fixtures must fail the test"
    )]
    use super::*;
    use poietica_automation::AutomationCreation;
    use poietica_time::test_clock::TestClock;
    use std::collections::BTreeMap;

    fn open(path: &std::path::Path) -> AgentStore {
        let store = AgentStore::open(path, TestClock::at_unix_millis(0)).expect("store");
        store.import_automations(None, "UTC").expect("initialize");
        store
    }
    fn definition(store: &AgentStore, root: &std::path::Path) -> String {
        store
            .automation_command(Command::Create(AutomationCreation {
                title: "Review".to_owned(),
                prompt: "Inspect".to_owned(),
                schedule: Some("* * * * *".to_owned()),
                session_config: BTreeMap::new(),
                workspace_root: root.to_string_lossy().into_owned(),
                time_zone: "UTC".to_owned(),
            }))
            .expect("create")
            .automations
            .first()
            .expect("row")
            .id
            .clone()
    }
    #[test]
    fn claim_and_thread_survive_reopen_without_duplicate_dispatch() {
        let directory = tempfile::tempdir().expect("directory");
        let file = directory.path().join("ledger.sqlite3");
        let store = open(&file);
        let id = definition(&store, directory.path());
        let request = Uuid::new_v4().to_string();
        let scheduled = store
            .automation_catalog()
            .expect("catalog")
            .automations
            .first()
            .expect("row")
            .next_run_at
            .clone();
        store
            .automation_manual(&id, &request, "agent")
            .expect("claim");
        let dispatch = store
            .automation_dispatch(&request)
            .expect("dispatch")
            .expect("owner");
        let thread = Uuid::parse_str(dispatch.thread_id().expect("thread")).expect("uuid");
        assert!(store.thread(thread).expect("thread record").is_some());
        assert!(
            store
                .automation_dispatch(&request)
                .expect("duplicate")
                .is_none()
        );
        drop(store);
        let store = open(&file);
        store
            .automation_manual(&id, &request, "agent")
            .expect("repeat command");
        let state = store.automation_state().expect("state");
        assert_eq!(state.executions.len(), 1);
        assert_eq!(
            state.automations.first().expect("row").next_run_at,
            scheduled
        );
        assert!(
            store
                .automation_command(Command::Remove { id: id.clone() })
                .is_err()
        );
        assert!(store.delete_thread(thread).is_err());
        store
            .automation_transition(&request, AutomationRunOutcome::Succeeded, None)
            .expect("settle");
        store
            .automation_transition(&request, AutomationRunOutcome::Failed, None)
            .expect("late result");
        store
            .automation_manual(&id, &request, "agent")
            .expect("repeat settled command");
        assert!(
            store
                .automation_state()
                .expect("state")
                .executions
                .is_empty()
        );
        assert_eq!(
            store
                .automation_catalog()
                .expect("catalog")
                .automations
                .first()
                .expect("row")
                .runs
                .first()
                .expect("run")
                .outcome,
            AutomationRunOutcome::Succeeded
        );
    }
    #[test]
    fn schedules_coalesce_and_cancelled_queued_work_never_dispatches() {
        let directory = tempfile::tempdir().expect("directory");
        let store = open(&directory.path().join("ledger.sqlite3"));
        definition(&store, directory.path());
        store.automation_sweep("agent", 600_000).expect("sweep");
        store
            .automation_sweep("agent", 600_000)
            .expect("repeat sweep");
        let state = store.automation_state().expect("state");
        assert_eq!(state.executions.len(), 1);
        let run = state
            .executions
            .values()
            .next()
            .expect("execution")
            .run
            .id
            .clone();
        store
            .automation_command(Command::Cancel {
                run_id: run.clone(),
            })
            .expect("cancel");
        assert!(store.automation_dispatch(&run).expect("dispatch").is_none());
        assert!(
            store
                .automation_state()
                .expect("state")
                .due(600_000)
                .expect("due")
                .is_empty()
        );
    }
    #[test]
    fn transactions_roll_back_and_revision_is_a_commit_order() {
        let directory = tempfile::tempdir().expect("directory");
        let store = open(&directory.path().join("ledger.sqlite3"));
        let id = definition(&store, directory.path());
        let before = store.automation_catalog().expect("before");
        let failed: Result<((), AutomationCatalog)> = store.automation_transaction(|state, _| {
            state.automations.clear();
            Err(AutomationError::Conflict.into())
        });
        assert!(failed.is_err());
        assert_eq!(store.automation_catalog().expect("after rollback"), before);
        let enabled = store
            .automation_command(Command::Enable {
                id: id.clone(),
                revision: 1,
                enabled: false,
            })
            .expect("disable");
        assert!(enabled.revision > before.revision);
        assert!(
            store
                .automation_command(Command::Enable {
                    id,
                    revision: 1,
                    enabled: true
                })
                .is_err()
        );
    }
    #[test]
    fn a_request_identity_cannot_be_reassigned_to_another_automation() {
        let directory = tempfile::tempdir().expect("directory");
        let store = open(&directory.path().join("ledger.sqlite3"));
        let first = definition(&store, directory.path());
        let second = definition(&store, directory.path());
        let request = Uuid::new_v4().to_string();
        store
            .automation_manual(&first, &request, "agent")
            .expect("claim");
        assert!(store.automation_manual(&second, &request, "agent").is_err());
        assert_eq!(store.automation_state().expect("state").executions.len(), 1);
    }

    #[test]
    fn automation_definitions_keep_their_workspace_alive_without_a_thread() {
        let directory = tempfile::tempdir().expect("directory");
        let store = open(&directory.path().join("ledger.sqlite3"));
        let id = definition(&store, directory.path());
        let root = directory.path().to_string_lossy().into_owned();
        assert!(store.workspace_root_in_use(&root).expect("ownership"));
        assert!(store.workspace_roots().expect("roots").contains(&root));
        store
            .automation_command(Command::Remove { id })
            .expect("remove definition");
        assert!(!store.workspace_root_in_use(&root).expect("released"));
    }

    #[test]
    fn dispatch_cannot_be_reopened_after_admission() {
        let directory = tempfile::tempdir().expect("directory");
        let store = open(&directory.path().join("ledger.sqlite3"));
        let id = definition(&store, directory.path());
        let request = Uuid::new_v4().to_string();
        store
            .automation_manual(&id, &request, "agent")
            .expect("claim");
        store.automation_dispatch(&request).expect("dispatch");
        store
            .automation_transition(&request, AutomationRunOutcome::Running, None)
            .expect("running");
        assert!(
            store
                .automation_transition(&request, AutomationRunOutcome::Dispatching, None)
                .is_err()
        );
        assert!(
            store
                .automation_transition(&request, AutomationRunOutcome::Queued, None)
                .is_err()
        );
    }

    #[test]
    fn coalesced_request_identities_remain_owned_after_reopening() {
        let directory = tempfile::tempdir().expect("directory");
        let file = directory.path().join("index.sqlite3");
        let store = open(&file);
        let first = definition(&store, directory.path());
        let second = definition(&store, directory.path());
        let run = Uuid::new_v4().to_string();
        let coalesced = Uuid::new_v4().to_string();
        store
            .automation_manual(&first, &run, "agent")
            .expect("claim");
        store
            .automation_manual(&first, &coalesced, "agent")
            .expect("coalesce");
        drop(store);
        let store = open(&file);
        store
            .automation_manual(&first, &coalesced, "agent")
            .expect("same command");
        assert!(
            store
                .automation_manual(&second, &coalesced, "agent")
                .is_err()
        );
        assert_eq!(store.automation_state().expect("state").executions.len(), 1);
    }

    #[test]
    fn an_invalid_schedule_does_not_starve_an_independent_definition() {
        let directory = tempfile::tempdir().expect("directory");
        let store = open(&directory.path().join("index.sqlite3"));
        let broken = definition(&store, directory.path());
        let healthy = definition(&store, directory.path());
        store
            .automation_transaction(|state, _| {
                state
                    .automations
                    .iter_mut()
                    .find(|row| row.id == broken)
                    .expect("row")
                    .next_run_at = Some("not a timestamp".to_owned());
                Ok(())
            })
            .expect("stored corruption");
        store
            .automation_sweep("agent", 60_000)
            .expect("independent progress");
        let state = store.automation_state().expect("state");
        assert!(state.executions.contains_key(&healthy));
        assert!(!state.executions.contains_key(&broken));
        let row = state
            .automations
            .iter()
            .find(|row| row.id == broken)
            .expect("broken row");
        assert!(!row.enabled);
        assert!(row.issue.is_some());
    }

    #[test]
    fn cancellation_before_admission_is_a_durable_barrier() {
        use poietica_conversation::{
            identity::{ThreadId, TurnId},
            ports::ConversationLedger,
            turn::Admission,
        };
        let directory = tempfile::tempdir().expect("directory");
        let store = open(&directory.path().join("index.sqlite3"));
        let id = definition(&store, directory.path());
        let run = Uuid::new_v4().to_string();
        store.automation_manual(&id, &run, "agent").expect("claim");
        let execution = store
            .automation_dispatch(&run)
            .expect("dispatch")
            .expect("owner");
        store
            .automation_command(Command::Cancel {
                run_id: run.clone(),
            })
            .expect("cancel intent");
        let admission = Admission {
            thread: ThreadId::new(execution.thread_id().expect("thread").to_owned()),
            turn: TurnId::new(run.clone()),
            prompt: "Work".to_owned(),
            model: String::new(),
            attachments: Vec::new(),
            skills: Vec::new(),
            submitted_at_unix_millis: 0,
        };
        assert!(store.admit(&admission).is_err());
        assert!(
            store
                .delivery_state(&TurnId::new(run))
                .expect("outbox")
                .is_none()
        );
    }
}
