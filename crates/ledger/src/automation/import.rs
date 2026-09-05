//! One transactional import; the input is never rewritten or treated as live state.
use crate::{LedgerError, index::AgentStore};
use poietica_automation::{
    Automation, AutomationError, AutomationRun, AutomationRunOutcome, AutomationState, schedule,
};
use rusqlite::{Transaction, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceCatalog {
    version: u32,
    automations: Vec<SourceAutomation>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceAutomation {
    id: String,
    title: String,
    prompt: String,
    schedule: Option<String>,
    enabled: bool,
    created_at: String,
    next_run_at: Option<String>,
    #[serde(default)]
    session_config: BTreeMap<String, String>,
    runs: Vec<SourceRun>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceRun {
    thread_id: Option<String>,
    started_at: String,
    outcome: AutomationRunOutcome,
}

impl AgentStore {
    pub fn import_automations(
        &self,
        source: Option<Value>,
        time_zone: &str,
    ) -> Result<(), LedgerError> {
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        if self.automation_initialized()? {
            transaction.commit()?;
            return Ok(());
        }
        let input = match source {
            Some(value) => serde_json::from_value::<SourceCatalog>(value)?,
            None => SourceCatalog {
                version: 1,
                automations: Vec::new(),
            },
        };
        if input.version != 1 {
            return Err(
                AutomationError::Data(format!("目录格式 {} 不受支持", input.version)).into(),
            );
        }
        let mut state = AutomationState {
            revision: 1,
            ..AutomationState::default()
        };
        let now = self.clock().now_unix_millis();
        for row in input.automations {
            let mut root = None;
            for run in &row.runs {
                if let Some(id) = run
                    .thread_id
                    .as_deref()
                    .and_then(|id| Uuid::parse_str(id).ok())
                    && let Some(thread) = self.thread(id)?
                    && let Some(candidate) = thread.workspace_root
                    && Path::new(&candidate).is_absolute()
                {
                    root = Some(candidate);
                    break;
                }
            }
            let preview = schedule::preview(row.schedule.as_deref(), time_zone, now);
            let mut issues = Vec::new();
            if root.is_none() {
                issues.push("历史任务没有可确认的工作目录，请编辑补全".to_owned());
            }
            if let Some(problem) = preview.problem {
                issues.push(problem.to_string());
            }
            if row.title.trim().is_empty() || row.prompt.trim().is_empty() {
                issues.push("标题或指令为空".to_owned());
            }
            let enabled = row.enabled && row.schedule.is_some() && issues.is_empty();
            let next_run_at = if enabled {
                match row.next_run_at {
                    Some(at) => Some(schedule::stamp(schedule::millis(&at)?)?),
                    None => preview.next_run_at,
                }
            } else {
                None
            };
            let runs = row
                .runs
                .into_iter()
                .map(|run| AutomationRun {
                    id: Uuid::new_v4().to_string(),
                    thread_id: run.thread_id,
                    started_at: run.started_at,
                    scheduled_for: None,
                    settled_at: None,
                    outcome: run.outcome,
                    message: None,
                })
                .collect();
            state.automations.push(Automation {
                id: row.id,
                title: row.title,
                prompt: row.prompt,
                schedule: row.schedule,
                enabled,
                created_at: row.created_at,
                next_run_at,
                session_config: row.session_config,
                runs,
                revision: 1,
                workspace_root: root,
                time_zone: time_zone.to_owned(),
                issue: if issues.is_empty() {
                    None
                } else {
                    Some(issues.join("；"))
                },
            });
        }
        state.validate()?;
        self.connection.execute(
            "UPDATE automation_state SET document = ?1 WHERE singleton = 1",
            params![serde_json::to_string(&state)?],
        )?;
        transaction.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "failed import fixtures must fail the test"
    )]
    use super::*;
    use poietica_time::test_clock::TestClock;
    #[test]
    fn corrupt_input_is_not_an_empty_catalog_and_missing_context_stays_visible() {
        let directory = tempfile::tempdir().expect("directory");
        let store = AgentStore::open(
            &directory.path().join("index.sqlite3"),
            TestClock::at_unix_millis(0),
        )
        .expect("store");
        assert!(
            store
                .import_automations(
                    Some(serde_json::json!({"version":1,"automations":"broken"})),
                    "UTC"
                )
                .is_err()
        );
        assert!(!store.automation_initialized().expect("import marker"));
        let id = Uuid::new_v4().to_string();
        let source = serde_json::json!({"version":1,"automations":[{
            "id":id,"title":"Keep","prompt":"Keep body","schedule":"* * * * *","enabled":true,
            "createdAt":"1970-01-01T00:00:00Z","nextRunAt":null,"sessionConfig":{},"runs":[]
        }]});
        store
            .import_automations(Some(source.clone()), "UTC")
            .expect("import");
        store
            .import_automations(Some(source), "UTC")
            .expect("repeat");
        let catalog = store.automation_catalog().expect("catalog");
        assert_eq!(catalog.automations.len(), 1);
        let row = catalog.automations.first().expect("row");
        assert_eq!(row.prompt, "Keep body");
        assert!(!row.enabled);
        assert!(row.issue.is_some());
    }
}
