//! Automation policy and durable aggregate. No UI, executor or filesystem access.
pub mod schedule;

use std::collections::BTreeMap;
use std::path::Path;
use serde::{Deserialize, Serialize};
use specta::Type;
use thiserror::Error;

pub const HISTORY_LIMIT: usize = 50;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AutomationRunOutcome {
    Queued, Dispatching, Running, Cancelling, Uncertain,
    Succeeded, Failed, Cancelled,
}
impl AutomationRunOutcome {
    #[must_use]
    pub const fn terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub id: String,
    pub thread_id: Option<String>,
    pub scheduled_for: Option<String>,
    pub started_at: String,
    pub settled_at: Option<String>,
    pub outcome: AutomationRunOutcome,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub schedule: Option<String>,
    pub enabled: bool,
    pub created_at: String,
    pub next_run_at: Option<String>,
    pub session_config: BTreeMap<String, String>,
    pub runs: Vec<AutomationRun>,
    pub revision: u32,
    pub workspace_root: Option<String>,
    pub time_zone: String,
    pub issue: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationCatalog {
    pub revision: u32,
    pub automations: Vec<Automation>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationCreation {
    pub title: String,
    pub prompt: String,
    pub schedule: Option<String>,
    pub session_config: BTreeMap<String, String>,
    pub workspace_root: String,
    pub time_zone: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationUpdate {
    pub id: String,
    pub expected_revision: u32,
    pub creation: AutomationCreation,
    pub enabled: bool,
}

#[derive(Debug, Error)]
pub enum AutomationError {
    #[error("任务标题和指令不能为空")]
    Empty,
    #[error("请为任务选择一个明确的绝对工作目录")]
    Workspace,
    #[error("没有这条自动化或运行记录")]
    Missing,
    #[error("任务已被其他操作修改，请刷新后保存")]
    Conflict,
    #[error("任务仍在执行或结果未确认，请先停止并核对终态")]
    Busy,
    #[error("自动化目录尚未完成导入")]
    Uninitialized,
    #[error("无法识别的自动化数据：{0}")]
    Data(String),
    #[error(transparent)]
    Schedule(#[from] schedule::ScheduleProblem),
}

#[derive(Clone, Debug)]
pub enum Command {
    Create(AutomationCreation),
    Update(AutomationUpdate),
    Enable { id: String, revision: u32, enabled: bool },
    Remove { id: String },
    Cancel { run_id: String },
}

#[derive(Clone, Debug)]
pub enum ClaimOrigin { Manual, Scheduled(String) }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    pub automation_id: String,
    pub run: AutomationRun,
    pub title: String,
    pub prompt: String,
    pub session_config: BTreeMap<String, String>,
    pub workspace_root: String,
    pub time_zone: String,
    pub agent_id: String,
    pub submitted_at_unix_millis: i64,
    pub cancel_requested: bool,
}
impl Execution {
    pub fn thread_id(&self) -> Result<&str, AutomationError> {
        self.run.thread_id.as_deref().ok_or_else(|| AutomationError::Data("活动运行没有对话身份".to_owned()))
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationState {
    pub revision: u32,
    pub automations: Vec<Automation>,
    pub executions: BTreeMap<String, Execution>,
}

impl AutomationCreation {
    pub fn validate(&self, now: i64) -> Result<(), AutomationError> {
        if self.title.trim().is_empty() || self.prompt.trim().is_empty() { return Err(AutomationError::Empty); }
        if !Path::new(&self.workspace_root).is_absolute() { return Err(AutomationError::Workspace); }
        let preview = schedule::preview(self.schedule.as_deref(), &self.time_zone, now);
        if let Some(problem) = preview.problem { return Err(problem.into()); }
        Ok(())
    }
}

impl Automation {
    #[must_use]
    pub fn creation(&self) -> AutomationCreation {
        AutomationCreation {
            title: self.title.clone(), prompt: self.prompt.clone(), schedule: self.schedule.clone(),
            session_config: self.session_config.clone(), workspace_root: self.workspace_root.clone().unwrap_or_default(),
            time_zone: self.time_zone.clone(),
        }
    }
}

impl AutomationState {
    #[must_use]
    pub fn catalog(&self) -> AutomationCatalog {
        let mut automations = self.automations.clone();
        for row in &mut automations {
            if let Some(execution) = self.executions.get(&row.id) { row.runs.insert(0, execution.run.clone()); }
            row.runs.truncate(HISTORY_LIMIT);
        }
        AutomationCatalog { revision: self.revision, automations }
    }

    pub fn validate(&self) -> Result<(), AutomationError> {
        let mut ids = std::collections::BTreeSet::new();
        for row in &self.automations {
            if !ids.insert(&row.id) || uuid::Uuid::parse_str(&row.id).is_err() {
                return Err(AutomationError::Data("任务身份重复或无效".to_owned()));
            }
            if row.runs.iter().any(|run| !run.outcome.terminal()) {
                return Err(AutomationError::Data("历史中含有无所有者的活动运行".to_owned()));
            }
        }
        for (owner, execution) in &self.executions {
            if owner != &execution.automation_id || !ids.contains(owner) || execution.run.outcome.terminal() {
                return Err(AutomationError::Data("执行所有权无效".to_owned()));
            }
            uuid::Uuid::parse_str(&execution.run.id).map_err(|error| AutomationError::Data(error.to_string()))?;
            uuid::Uuid::parse_str(execution.thread_id()?).map_err(|error| AutomationError::Data(error.to_string()))?;
        }
        Ok(())
    }

    pub fn apply(&mut self, command: Command, now: i64, identity: String) -> Result<(), AutomationError> {
        match command {
            Command::Create(creation) => {
                creation.validate(now)?;
                let next_run_at = schedule::next_after(creation.schedule.as_deref(), &creation.time_zone, now)?;
                self.automations.insert(0, Automation {
                    id: identity, title: creation.title.trim().to_owned(), prompt: creation.prompt.trim().to_owned(),
                    enabled: creation.schedule.is_some(), schedule: creation.schedule,
                    created_at: schedule::stamp(now)?, next_run_at, session_config: creation.session_config,
                    runs: Vec::new(), revision: 1, workspace_root: Some(creation.workspace_root),
                    time_zone: creation.time_zone, issue: None,
                });
            }
            Command::Update(update) => {
                update.creation.validate(now)?;
                let row = self.automations.iter_mut().find(|row| row.id == update.id).ok_or(AutomationError::Missing)?;
                if row.revision != update.expected_revision { return Err(AutomationError::Conflict); }
                let enabled = update.enabled && update.creation.schedule.is_some();
                if row.schedule != update.creation.schedule || row.time_zone != update.creation.time_zone || row.enabled != enabled {
                    row.next_run_at = if enabled { schedule::next_after(update.creation.schedule.as_deref(), &update.creation.time_zone, now)? } else { None };
                }
                row.title = update.creation.title.trim().to_owned();
                row.prompt = update.creation.prompt.trim().to_owned();
                row.schedule = update.creation.schedule;
                row.session_config = update.creation.session_config;
                row.workspace_root = Some(update.creation.workspace_root);
                row.time_zone = update.creation.time_zone;
                row.enabled = enabled;
                row.issue = None;
                row.revision = row.revision.checked_add(1).ok_or(AutomationError::Conflict)?;
            }
            Command::Enable { id, revision, enabled } => {
                let row = self.automations.iter_mut().find(|row| row.id == id).ok_or(AutomationError::Missing)?;
                if row.revision != revision { return Err(AutomationError::Conflict); }
                if enabled {
                    row.creation().validate(now)?;
                    if row.schedule.is_none() { return Err(AutomationError::Data("这是仅手动运行的任务".to_owned())); }
                }
                if row.enabled != enabled {
                    row.next_run_at = if enabled { schedule::next_after(row.schedule.as_deref(), &row.time_zone, now)? } else { None };
                    row.enabled = enabled;
                    row.revision = row.revision.checked_add(1).ok_or(AutomationError::Conflict)?;
                }
            }
            Command::Remove { id } => {
                if self.executions.contains_key(&id) { return Err(AutomationError::Busy); }
                self.automations.retain(|row| row.id != id);
            }
            Command::Cancel { run_id } => {
                let Some(execution) = self.executions.values_mut().find(|entry| entry.run.id == run_id) else {
                    return Ok(());
                };
                if execution.run.outcome == AutomationRunOutcome::Queued {
                    self.transition(&run_id, AutomationRunOutcome::Cancelled, None, now)?;
                } else {
                    execution.cancel_requested = true;
                    execution.run.outcome = AutomationRunOutcome::Cancelling;
                    execution.run.message = Some("已请求停止，等待官方终态确认".to_owned());
                }
            }
        }
        Ok(())
    }

    pub fn due(&self, now: i64) -> Result<Vec<(String, String)>, AutomationError> {
        let mut due = Vec::new();
        for row in &self.automations {
            if row.enabled && let Some(at) = &row.next_run_at && schedule::millis(at)? <= now {
                due.push((row.id.clone(), at.clone()));
            }
        }
        Ok(due)
    }

    pub fn advance_due(&mut self, id: &str, at: &str, now: i64) -> Result<bool, AutomationError> {
        let row = self.automations.iter_mut().find(|row| row.id == id).ok_or(AutomationError::Missing)?;
        if !row.enabled || row.next_run_at.as_deref() != Some(at) || schedule::millis(at)? > now { return Ok(false); }
        row.next_run_at = schedule::next_after(row.schedule.as_deref(), &row.time_zone, now)?;
        Ok(true)
    }

    pub fn claim(&mut self, id: &str, origin: ClaimOrigin, run_id: String, thread_id: String, agent_id: String, now: i64) -> Result<Option<Execution>, AutomationError> {
        let scheduled_for = match origin {
            ClaimOrigin::Manual => None,
            ClaimOrigin::Scheduled(at) => {
                if !self.advance_due(id, &at, now)? { return Ok(None); }
                Some(at)
            }
        };
        if let Some(execution) = self.executions.get(id) { return Ok(Some(execution.clone())); }
        let row = self.automations.iter().find(|row| row.id == id).ok_or(AutomationError::Missing)?;
        let workspace_root = row.workspace_root.clone().filter(|root| Path::new(root).is_absolute()).ok_or(AutomationError::Workspace)?;
        if row.title.trim().is_empty() || row.prompt.trim().is_empty() { return Err(AutomationError::Empty); }
        let execution = Execution {
            automation_id: id.to_owned(), title: row.title.clone(), prompt: row.prompt.clone(),
            session_config: row.session_config.clone(), workspace_root, time_zone: row.time_zone.clone(), agent_id,
            submitted_at_unix_millis: now, cancel_requested: false,
            run: AutomationRun { id: run_id, thread_id: Some(thread_id), scheduled_for,
                started_at: schedule::stamp(now)?, settled_at: None, outcome: AutomationRunOutcome::Queued, message: None },
        };
        self.executions.insert(id.to_owned(), execution.clone());
        Ok(Some(execution))
    }

    pub fn dispatch(&mut self, run_id: &str) -> Option<Execution> {
        let execution = self.executions.values_mut().find(|entry| entry.run.id == run_id)?;
        if execution.run.outcome != AutomationRunOutcome::Queued || execution.cancel_requested { return None; }
        execution.run.outcome = AutomationRunOutcome::Dispatching;
        Some(execution.clone())
    }

    pub fn transition(&mut self, run_id: &str, outcome: AutomationRunOutcome, message: Option<String>, now: i64) -> Result<(), AutomationError> {
        let Some(owner) = self.executions.iter().find(|(_, entry)| entry.run.id == run_id).map(|(id, _)| id.clone()) else { return Ok(()); };
        if outcome.terminal() {
            let mut execution = self.executions.remove(&owner).ok_or(AutomationError::Missing)?;
            execution.run.outcome = outcome;
            execution.run.message = message;
            execution.run.settled_at = Some(schedule::stamp(now)?);
            let row = self.automations.iter_mut().find(|row| row.id == owner).ok_or(AutomationError::Missing)?;
            row.runs.insert(0, execution.run);
            row.runs.truncate(HISTORY_LIMIT);
        } else {
            let execution = self.executions.get_mut(&owner).ok_or(AutomationError::Missing)?;
            execution.run.outcome = if execution.cancel_requested && outcome == AutomationRunOutcome::Running { AutomationRunOutcome::Cancelling } else { outcome };
            execution.run.message = message;
        }
        Ok(())
    }
}
