//! Automation policy and durable aggregate. No UI, executor or filesystem access.
pub mod schedule;

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::Path;
use thiserror::Error;

pub const HISTORY_LIMIT: usize = 50;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AutomationRunOutcome {
    Queued,
    Dispatching,
    Running,
    Cancelling,
    Uncertain,
    Succeeded,
    Failed,
    Cancelled,
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

#[derive(Clone, Debug, Deserialize, Serialize, Type, PartialEq, Eq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutomationCreation {
    pub title: String,
    pub prompt: String,
    pub schedule: Option<String>,
    pub session_config: BTreeMap<String, String>,
    pub workspace_root: String,
    pub time_zone: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Type, PartialEq, Eq, schemars::JsonSchema)]
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
    Enable {
        id: String,
        revision: u32,
        enabled: bool,
    },
    Remove {
        id: String,
    },
    Cancel {
        run_id: String,
    },
}

#[derive(Clone, Debug)]
pub enum ClaimOrigin {
    Manual,
    Scheduled(String),
}

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
        self.run
            .thread_id
            .as_deref()
            .ok_or_else(|| AutomationError::Data("活动运行没有对话身份".to_owned()))
    }
}

/// 工作目录必须是绝对路径：相对路径由谁解释取决于谁启动进程，这里定不了。
#[must_use]
pub fn is_absolute_root(root: &str) -> bool {
    Path::new(root).is_absolute()
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
        if self.title.trim().is_empty() || self.prompt.trim().is_empty() {
            return Err(AutomationError::Empty);
        }
        if !is_absolute_root(&self.workspace_root) {
            return Err(AutomationError::Workspace);
        }
        let preview = schedule::preview(self.schedule.as_deref(), &self.time_zone, now);
        if let Some(problem) = preview.problem {
            return Err(problem.into());
        }
        Ok(())
    }
}

impl Automation {
    /// 每次写入推一格版本；到顶是冲突，不是回绕。
    fn bump(&mut self) -> Result<(), AutomationError> {
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or(AutomationError::Conflict)?;
        Ok(())
    }

    #[must_use]
    pub fn creation(&self) -> AutomationCreation {
        AutomationCreation {
            title: self.title.clone(),
            prompt: self.prompt.clone(),
            schedule: self.schedule.clone(),
            session_config: self.session_config.clone(),
            workspace_root: self.workspace_root.clone().unwrap_or_default(),
            time_zone: self.time_zone.clone(),
        }
    }
}

impl AutomationState {
    #[must_use]
    pub fn catalog(&self) -> AutomationCatalog {
        let mut automations = self.automations.clone();
        for row in &mut automations {
            if let Some(execution) = self.executions.get(&row.id) {
                row.runs.insert(0, execution.run.clone());
            }
            row.runs.truncate(HISTORY_LIMIT);
        }
        AutomationCatalog {
            revision: self.revision,
            automations,
        }
    }

    pub fn validate(&self) -> Result<(), AutomationError> {
        let mut owners = std::collections::BTreeSet::new();
        let mut runs = std::collections::BTreeSet::new();
        let mut active_threads = std::collections::BTreeSet::new();
        let identity = |value: &str| -> Result<(), AutomationError> {
            let parsed = uuid::Uuid::parse_str(value)
                .map_err(|error| AutomationError::Data(error.to_string()))?;
            if parsed.to_string() != value {
                return Err(AutomationError::Data(
                    "identity is not canonical".to_owned(),
                ));
            }
            Ok(())
        };
        for automation in &self.automations {
            identity(&automation.id)?;
            if !owners.insert(automation.id.as_str()) {
                return Err(AutomationError::Data(
                    "duplicate automation identity".to_owned(),
                ));
            }
            for run in &automation.runs {
                identity(&run.id)?;
                if !run.outcome.terminal() || !runs.insert(run.id.as_str()) {
                    return Err(AutomationError::Data(
                        "invalid or duplicate settled run".to_owned(),
                    ));
                }
                if let Some(thread) = &run.thread_id {
                    identity(thread)?;
                }
            }
        }
        for (owner, execution) in &self.executions {
            if owner != &execution.automation_id || !owners.contains(owner.as_str()) {
                return Err(AutomationError::Data(
                    "execution has no definition owner".to_owned(),
                ));
            }
            identity(&execution.run.id)?;
            let thread = execution.thread_id()?;
            identity(thread)?;
            if execution.run.outcome.terminal()
                || execution.run.settled_at.is_some()
                || !runs.insert(execution.run.id.as_str())
                || !active_threads.insert(thread)
                || execution.agent_id.trim().is_empty()
                || !is_absolute_root(&execution.workspace_root)
            {
                return Err(AutomationError::Data(
                    "invalid execution ownership".to_owned(),
                ));
            }
            if execution.run.outcome == AutomationRunOutcome::Cancelling
                && !execution.cancel_requested
            {
                return Err(AutomationError::Data(
                    "cancelling execution has no cancellation intent".to_owned(),
                ));
            }
        }
        Ok(())
    }

    pub fn apply(
        &mut self,
        command: Command,
        now: i64,
        identity: String,
    ) -> Result<(), AutomationError> {
        match command {
            Command::Create(creation) => {
                creation.validate(now)?;
                let next_run_at =
                    schedule::next_after(creation.schedule.as_deref(), &creation.time_zone, now)?;
                self.automations.insert(
                    0,
                    Automation {
                        id: identity,
                        title: creation.title.trim().to_owned(),
                        prompt: creation.prompt.trim().to_owned(),
                        enabled: creation.schedule.is_some(),
                        schedule: creation.schedule,
                        created_at: schedule::stamp(now)?,
                        next_run_at,
                        session_config: creation.session_config,
                        runs: Vec::new(),
                        revision: 1,
                        workspace_root: Some(creation.workspace_root),
                        time_zone: creation.time_zone,
                        issue: None,
                    },
                );
            }
            Command::Update(update) => {
                update.creation.validate(now)?;
                let row = self
                    .automations
                    .iter_mut()
                    .find(|row| row.id == update.id)
                    .ok_or(AutomationError::Missing)?;
                if row.revision != update.expected_revision {
                    return Err(AutomationError::Conflict);
                }
                let enabled = update.enabled && update.creation.schedule.is_some();
                if row.schedule != update.creation.schedule
                    || row.time_zone != update.creation.time_zone
                    || row.enabled != enabled
                {
                    row.next_run_at = if enabled {
                        schedule::next_after(
                            update.creation.schedule.as_deref(),
                            &update.creation.time_zone,
                            now,
                        )?
                    } else {
                        None
                    };
                }
                update.creation.title.trim().clone_into(&mut row.title);
                update.creation.prompt.trim().clone_into(&mut row.prompt);
                row.schedule = update.creation.schedule;
                row.session_config = update.creation.session_config;
                row.workspace_root = Some(update.creation.workspace_root);
                row.time_zone = update.creation.time_zone;
                row.enabled = enabled;
                row.issue = None;
                row.bump()?;
            }
            Command::Enable {
                id,
                revision,
                enabled,
            } => {
                let row = self
                    .automations
                    .iter_mut()
                    .find(|row| row.id == id)
                    .ok_or(AutomationError::Missing)?;
                if row.revision != revision {
                    return Err(AutomationError::Conflict);
                }
                if enabled {
                    row.creation().validate(now)?;
                    if row.schedule.is_none() {
                        return Err(AutomationError::Data("这是仅手动运行的任务".to_owned()));
                    }
                }
                if row.enabled != enabled {
                    row.next_run_at = if enabled {
                        schedule::next_after(row.schedule.as_deref(), &row.time_zone, now)?
                    } else {
                        None
                    };
                    row.enabled = enabled;
                    row.bump()?;
                }
            }
            Command::Remove { id } => {
                /* 拦两种：结果不确定的，那一刻必须由人核对终端；还没有停止意图的，
                删掉定义会让重开后的协调既查不到记录、也不会再发停止请求。
                停止了却还没落终态的（排队、在跑、正在取消）随定义一起走：删除就是取消，
                记录必须同一次删掉 —— AutomationState::validate 要求每条 execution
                都有定义主人，留下它就是孤儿记录，整个事务都提交不了。 */
                if self.executions.get(&id).is_some_and(|execution| {
                    execution.run.outcome == AutomationRunOutcome::Uncertain
                        || !execution.cancel_requested
                }) {
                    return Err(AutomationError::Busy);
                }
                self.automations.retain(|row| row.id != id);
                self.executions.remove(&id);
            }
            Command::Cancel { run_id } => {
                let Some(execution) = self
                    .executions
                    .values_mut()
                    .find(|entry| entry.run.id == run_id)
                else {
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

    pub fn reconcile_schedules(&mut self, now: i64) -> Result<(), AutomationError> {
        for row in self.automations.iter_mut().filter(|row| row.enabled) {
            let valid = (|| -> Result<(), AutomationError> {
                if row.schedule.is_none() {
                    return Err(AutomationError::Data("手动任务不能启用周期计划".to_owned()));
                }
                let at = row.next_run_at.as_deref().ok_or_else(|| {
                    AutomationError::Data("计划没有下一次运行，请重新保存日程".to_owned())
                })?;
                schedule::millis(at)?;
                schedule::next_after(row.schedule.as_deref(), &row.time_zone, now)?;
                if !row.workspace_root.as_deref().is_some_and(is_absolute_root) {
                    return Err(AutomationError::Workspace);
                }
                if row.title.trim().is_empty() || row.prompt.trim().is_empty() {
                    return Err(AutomationError::Empty);
                }
                Ok(())
            })();
            if let Err(error) = valid {
                row.enabled = false;
                row.next_run_at = None;
                row.issue = Some(error.to_string());
                row.bump()?;
            }
        }
        Ok(())
    }

    pub fn due(&self, now: i64) -> Result<Vec<(String, String)>, AutomationError> {
        let mut due = Vec::new();
        for row in &self.automations {
            if row.enabled
                && let Some(at) = &row.next_run_at
                && schedule::millis(at)? <= now
            {
                due.push((row.id.clone(), at.clone()));
            }
        }
        Ok(due)
    }

    pub fn advance_due(&mut self, id: &str, at: &str, now: i64) -> Result<bool, AutomationError> {
        let row = self
            .automations
            .iter_mut()
            .find(|row| row.id == id)
            .ok_or(AutomationError::Missing)?;
        if !row.enabled || row.next_run_at.as_deref() != Some(at) || schedule::millis(at)? > now {
            return Ok(false);
        }
        row.next_run_at = schedule::next_after(row.schedule.as_deref(), &row.time_zone, now)?;
        row.issue = None;
        if row.next_run_at.is_none() {
            row.enabled = false;
            row.issue = Some("日程已耗尽，没有后续运行时间".to_owned());
            row.bump()?;
        }
        Ok(true)
    }

    pub fn claim(
        &mut self,
        id: &str,
        origin: ClaimOrigin,
        run_id: String,
        thread_id: String,
        agent_id: String,
        now: i64,
    ) -> Result<Option<Execution>, AutomationError> {
        let scheduled_for = match origin {
            ClaimOrigin::Manual => None,
            ClaimOrigin::Scheduled(at) => {
                if !self.advance_due(id, &at, now)? {
                    return Ok(None);
                }
                Some(at)
            }
        };
        if let Some(execution) = self.executions.get(id) {
            return Ok(Some(execution.clone()));
        }
        let row = self
            .automations
            .iter()
            .find(|row| row.id == id)
            .ok_or(AutomationError::Missing)?;
        let workspace_root = row
            .workspace_root
            .clone()
            .filter(|root| is_absolute_root(root))
            .ok_or(AutomationError::Workspace)?;
        if row.title.trim().is_empty() || row.prompt.trim().is_empty() {
            return Err(AutomationError::Empty);
        }
        let execution = Execution {
            automation_id: id.to_owned(),
            title: row.title.clone(),
            prompt: row.prompt.clone(),
            session_config: row.session_config.clone(),
            workspace_root,
            time_zone: row.time_zone.clone(),
            agent_id,
            submitted_at_unix_millis: now,
            cancel_requested: false,
            run: AutomationRun {
                id: run_id,
                thread_id: Some(thread_id),
                scheduled_for,
                started_at: schedule::stamp(now)?,
                settled_at: None,
                outcome: AutomationRunOutcome::Queued,
                message: None,
            },
        };
        self.executions.insert(id.to_owned(), execution.clone());
        Ok(Some(execution))
    }

    pub fn dispatch(&mut self, run_id: &str) -> Option<Execution> {
        let execution = self
            .executions
            .values_mut()
            .find(|entry| entry.run.id == run_id)?;
        if execution.run.outcome != AutomationRunOutcome::Queued || execution.cancel_requested {
            return None;
        }
        execution.run.outcome = AutomationRunOutcome::Dispatching;
        Some(execution.clone())
    }

    pub fn transition(
        &mut self,
        run_id: &str,
        outcome: AutomationRunOutcome,
        message: Option<String>,
        now: i64,
    ) -> Result<(), AutomationError> {
        use AutomationRunOutcome::{
            Cancelled, Cancelling, Dispatching, Failed, Queued, Running, Succeeded, Uncertain,
        };
        let Some(owner) = self
            .executions
            .iter()
            .find_map(|(owner, execution)| (execution.run.id == run_id).then(|| owner.clone()))
        else {
            return Ok(());
        };
        let execution = self
            .executions
            .get(&owner)
            .ok_or(AutomationError::Missing)?;
        let outcome = if execution.cancel_requested && outcome == Running {
            Cancelling
        } else {
            outcome
        };
        let current = execution.run.outcome;
        let allowed = current == outcome
            || match current {
                Queued => matches!(outcome, Cancelled | Failed),
                Dispatching | Running | Cancelling | Uncertain => matches!(
                    outcome,
                    Running | Cancelling | Uncertain | Succeeded | Failed | Cancelled
                ),
                Succeeded | Failed | Cancelled => false,
            };
        if !allowed || matches!(outcome, Queued | Dispatching) {
            return Err(AutomationError::Data(format!(
                "invalid execution transition: {current:?} -> {outcome:?}"
            )));
        }
        if outcome == Cancelling && !execution.cancel_requested {
            return Err(AutomationError::Data(
                "stop intent must be recorded before cancellation".to_owned(),
            ));
        }
        if outcome.terminal() {
            let settled_at = schedule::stamp(now)?;
            let mut execution = self
                .executions
                .remove(&owner)
                .ok_or(AutomationError::Missing)?;
            execution.run.outcome = outcome;
            execution.run.message = message;
            execution.run.settled_at = Some(settled_at);
            /* 历史属于定义：没有定义就没有地方安放这条记录。Remove 已经连同执行记录
            一起删掉，所以正常路径根本走不到这里 —— 这条守的是不变量本身，
            不是某条已知路径；写成 Missing 会让一次合法结算回滚成卡住的中间态。 */
            if let Some(definition) = self.automations.iter_mut().find(|row| row.id == owner) {
                definition.runs.insert(0, execution.run);
                definition.runs.truncate(HISTORY_LIMIT);
            }
        } else {
            let execution = self
                .executions
                .get_mut(&owner)
                .ok_or(AutomationError::Missing)?;
            execution.run.outcome = outcome;
            execution.run.message = message;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, reason = "fixture failures must fail the test")]
    use super::*;

    const NOW: i64 = 1_767_225_600_000;
    const FIRST: &str = "018f2c1e-1111-7000-8000-000000000001";
    const SECOND: &str = "018f2c1e-1111-7000-8000-000000000002";
    const FIRST_RUN: &str = "018f2c1e-2222-7000-8000-000000000001";
    const FIRST_THREAD: &str = "018f2c1e-3333-7000-8000-000000000001";
    const SECOND_RUN: &str = "018f2c1e-2222-7000-8000-000000000002";
    const SECOND_THREAD: &str = "018f2c1e-3333-7000-8000-000000000002";

    /// 绝对路径的形式是平台的，两套写法只在各自平台上成立。
    fn root() -> String {
        if cfg!(windows) {
            "C:\\automation-test".to_owned()
        } else {
            "/automation-test".to_owned()
        }
    }
    fn creation() -> AutomationCreation {
        AutomationCreation {
            title: "Review".to_owned(),
            prompt: "Inspect".to_owned(),
            schedule: None,
            session_config: BTreeMap::new(),
            workspace_root: root(),
            time_zone: "UTC".to_owned(),
        }
    }
    /// 一条已进入 Running 的执行：创建、认领、准入。
    fn running(
        state: &mut AutomationState,
        id: &str,
        run: &str,
        thread: &str,
    ) -> Result<(), AutomationError> {
        state.apply(Command::Create(creation()), NOW, id.to_owned())?;
        state.claim(
            id,
            ClaimOrigin::Manual,
            run.to_owned(),
            thread.to_owned(),
            "agent".to_owned(),
            NOW,
        )?;
        assert!(state.dispatch(run).is_some());
        state.transition(run, AutomationRunOutcome::Running, None, NOW)
    }

    #[test]
    fn update_compares_the_row_revision_not_the_catalog_revision() -> Result<(), AutomationError> {
        let mut state = AutomationState::default();
        state.apply(Command::Create(creation()), NOW, FIRST.to_owned())?;
        /* 目录级版本是提交序号，与某一条自动化的版本无关；这里手动推到 7 只为把两者分开。 */
        state.revision = 7;
        let row_revision = state.automations.first().expect("row").revision;
        let mut update = AutomationUpdate {
            id: FIRST.to_owned(),
            expected_revision: state.catalog().revision,
            creation: creation(),
            enabled: true,
        };
        assert_eq!(state.catalog().revision, 7);
        assert_ne!(state.catalog().revision, row_revision);
        assert!(matches!(
            state.apply(Command::Update(update.clone()), NOW, String::new()),
            Err(AutomationError::Conflict)
        ));
        update.expected_revision = row_revision;
        state.apply(Command::Update(update), NOW, String::new())?;
        assert_eq!(
            state.automations.first().expect("row").revision,
            row_revision + 1
        );
        Ok(())
    }

    #[test]
    fn remove_needs_a_recorded_stop_intent_and_no_uncertain_outcome() -> Result<(), AutomationError>
    {
        let mut state = AutomationState::default();
        /* 在跑而没有任何停止意图：不许删，否则这一轮会在无人知晓的情况下跑完。 */
        running(&mut state, FIRST, FIRST_RUN, FIRST_THREAD)?;
        let remove_first = || Command::Remove {
            id: FIRST.to_owned(),
        };
        assert!(matches!(
            state.apply(remove_first(), NOW, String::new()),
            Err(AutomationError::Busy)
        ));
        assert!(state.executions.contains_key(FIRST));
        /* 记下停止意图后就放行：删除即取消，记录与定义同一次消失。 */
        state.apply(
            Command::Cancel {
                run_id: FIRST_RUN.to_owned(),
            },
            NOW,
            String::new(),
        )?;
        state.apply(remove_first(), NOW, String::new())?;
        state.validate()?;
        assert!(state.executions.is_empty());
        assert!(state.automations.is_empty());

        /* 结果不确定：即便停止意图已记，也仍然不许删 —— 那是唯一还能核对终端的线索。 */
        running(&mut state, SECOND, SECOND_RUN, SECOND_THREAD)?;
        state.apply(
            Command::Cancel {
                run_id: SECOND_RUN.to_owned(),
            },
            NOW,
            String::new(),
        )?;
        state.transition(SECOND_RUN, AutomationRunOutcome::Uncertain, None, NOW)?;
        assert!(matches!(
            state.apply(
                Command::Remove {
                    id: SECOND.to_owned(),
                },
                NOW,
                String::new(),
            ),
            Err(AutomationError::Busy)
        ));
        assert!(state.executions.contains_key(SECOND));
        assert!(state.automations.iter().any(|row| row.id == SECOND));
        state.validate()
    }

    #[test]
    fn a_cancelling_execution_leaves_with_its_definition_and_a_late_result_is_discarded()
    -> Result<(), AutomationError> {
        let mut state = AutomationState::default();
        running(&mut state, FIRST, FIRST_RUN, FIRST_THREAD)?;
        state.apply(
            Command::Cancel {
                run_id: FIRST_RUN.to_owned(),
            },
            NOW,
            String::new(),
        )?;
        assert_eq!(
            state.executions.get(FIRST).expect("execution").run.outcome,
            AutomationRunOutcome::Cancelling
        );
        state.apply(
            Command::Remove {
                id: FIRST.to_owned(),
            },
            NOW,
            String::new(),
        )?;
        state.validate()?;
        assert!(state.executions.is_empty());
        /* 迟到的官方终态没有定义可以安放它：丢掉，且不许把状态写成孤儿记录。 */
        state.transition(FIRST_RUN, AutomationRunOutcome::Cancelled, None, NOW)?;
        state.validate()?;
        assert!(state.executions.is_empty());
        assert!(state.automations.is_empty());
        Ok(())
    }
}
