//! Automation definitions and catalog mutations; no host, filesystem, timer, or UI.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const RUN_HISTORY_LIMIT: usize = 50;

#[derive(Debug, Deserialize, Serialize, Type, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AutomationRunOutcome {
    Succeeded,
    Failed,
}

#[derive(Debug, Deserialize, Serialize, Type, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub thread_id: Option<String>,
    pub started_at: String,
    pub outcome: AutomationRunOutcome,
}

#[derive(Debug, Deserialize, Serialize, Type, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub schedule: Option<String>,
    pub enabled: bool,
    pub created_at: String,
    pub next_run_at: Option<String>,
    #[serde(default)]
    pub session_config: BTreeMap<String, String>,
    pub runs: Vec<AutomationRun>,
}

#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct AutomationCatalog {
    pub version: u32,
    pub automations: Vec<Automation>,
}

impl Default for AutomationCatalog {
    fn default() -> Self {
        Self {
            version: 1,
            automations: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AutomationReschedule {
    Keep,
    #[serde(rename_all = "camelCase")]
    Advance {
        from: String,
        to: Option<String>,
    },
}

#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunRecord {
    pub id: String,
    pub run: AutomationRun,
    pub reschedule: AutomationReschedule,
}

#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AutomationCreation {
    pub title: String,
    pub prompt: String,
    pub schedule: Option<String>,
    #[serde(default)]
    pub session_config: BTreeMap<String, String>,
    pub next_run_at: Option<String>,
}

impl Automation {
    pub fn is_due(&self, now: OffsetDateTime) -> Result<bool, time::error::Parse> {
        if !self.enabled {
            return Ok(false);
        }
        match self.next_run_at.as_deref() {
            None => Ok(false),
            Some(next) => Ok(OffsetDateTime::parse(next, &Rfc3339)? <= now),
        }
    }
}

impl AutomationCatalog {
    pub fn create(&mut self, creation: AutomationCreation, id: String, created_at: String) {
        self.automations.insert(
            0,
            Automation {
                id,
                created_at,
                title: creation.title,
                prompt: creation.prompt,
                enabled: creation.schedule.is_some(),
                schedule: creation.schedule,
                next_run_at: creation.next_run_at,
                session_config: creation.session_config,
                runs: Vec::new(),
            },
        );
    }

    pub fn upsert(&mut self, mut incoming: Automation) {
        if let Some(existing) = self
            .automations
            .iter_mut()
            .find(|row| row.id == incoming.id)
        {
            incoming.runs.clone_from(&existing.runs);
            incoming.created_at.clone_from(&existing.created_at);
            *existing = incoming;
        } else {
            incoming.runs.clear();
            self.automations.insert(0, incoming);
        }
    }

    pub fn remove(&mut self, id: &str) {
        self.automations.retain(|row| row.id != id);
    }

    pub fn record_run(&mut self, record: AutomationRunRecord) {
        let Some(existing) = self.automations.iter_mut().find(|row| row.id == record.id) else {
            return;
        };
        existing.runs.insert(0, record.run);
        existing.runs.truncate(RUN_HISTORY_LIMIT);
        if let AutomationReschedule::Advance { from, to } = record.reschedule
            && existing.next_run_at.as_deref() == Some(from.as_str())
        {
            existing.next_run_at = to;
        }
    }

    pub fn edit_definition(
        &mut self,
        id: &str,
        title: String,
        prompt: String,
        schedule: Option<String>,
        enabled: bool,
    ) -> Option<Automation> {
        let existing = self.automations.iter_mut().find(|row| row.id == id)?;
        if existing.schedule != schedule || existing.enabled != enabled {
            existing.next_run_at = None;
        }
        existing.title = title;
        existing.prompt = prompt;
        existing.schedule = schedule;
        existing.enabled = enabled;
        Some(existing.clone())
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "catalog fixtures must exist for invariant tests"
    )]
    use super::{
        AutomationCatalog, AutomationCreation, AutomationReschedule, AutomationRun,
        AutomationRunOutcome, AutomationRunRecord,
    };
    use std::collections::BTreeMap;

    fn catalog() -> AutomationCatalog {
        let mut catalog = AutomationCatalog::default();
        catalog.create(
            AutomationCreation {
                title: "task".to_owned(),
                prompt: "prompt".to_owned(),
                schedule: Some("0 9 * * *".to_owned()),
                session_config: BTreeMap::default(),
                next_run_at: Some("2026-09-05T09:00:00Z".to_owned()),
            },
            "task-id".to_owned(),
            "created".to_owned(),
        );
        catalog
    }

    fn record(reschedule: AutomationReschedule) -> AutomationRunRecord {
        AutomationRunRecord {
            id: "task-id".to_owned(),
            reschedule,
            run: AutomationRun {
                thread_id: Some("thread".to_owned()),
                started_at: "started".to_owned(),
                outcome: AutomationRunOutcome::Succeeded,
            },
        }
    }

    #[test]
    fn editing_cannot_replace_owned_history_or_creation_time() {
        let mut catalog = catalog();
        catalog.record_run(record(AutomationReschedule::Keep));
        let mut incoming = catalog.automations.first().expect("row").clone();
        incoming.runs.clear();
        incoming.created_at = "forged".to_owned();
        incoming.title = "edited".to_owned();
        catalog.upsert(incoming);
        let row = catalog.automations.first().expect("row");
        assert_eq!(row.runs.len(), 1);
        assert_eq!(row.created_at, "created");
        assert_eq!(row.title, "edited");
    }

    #[test]
    fn stale_schedule_completion_cannot_advance_an_edited_schedule() {
        let mut catalog = catalog();
        catalog.record_run(record(AutomationReschedule::Advance {
            from: "unrelated".to_owned(),
            to: None,
        }));
        assert_eq!(
            catalog
                .automations
                .first()
                .expect("row")
                .next_run_at
                .as_deref(),
            Some("2026-09-05T09:00:00Z")
        );
    }

    #[test]
    fn completing_a_deleted_definition_does_not_recreate_it() {
        let mut catalog = catalog();
        catalog.remove("task-id");
        catalog.record_run(record(AutomationReschedule::Keep));
        assert!(catalog.automations.is_empty());
    }

    #[test]
    fn history_is_bounded_and_manual_runs_keep_the_schedule() {
        let mut catalog = catalog();
        for _ in 0..75 {
            catalog.record_run(record(AutomationReschedule::Keep));
        }
        let row = catalog.automations.first().expect("row");
        assert_eq!(row.runs.len(), 50);
        assert_eq!(row.next_run_at.as_deref(), Some("2026-09-05T09:00:00Z"));
    }
}
