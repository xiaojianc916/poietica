//! 这个应用暴露给渲染层的那一张 IPC 面。
//!
//! 清单只有一份，就在下面的 `surface`。它同时是两件事的产地：运行期交给 Tauri 的
//! `invoke_handler`，以及构建期导出的 TypeScript 绑定。
//!
//! 一份清单两用是 tauri-specta 的范式：手抄第二份没有东西校验它，漏抄不报错，
//! 只会安静地少一条绑定。

pub mod export_bindings;
pub mod problem;

use poietica_automation::{
    Automation, AutomationCatalog, AutomationCreation, AutomationRun, AutomationRunOutcome,
    AutomationUpdate,
    schedule::{SchedulePreview, ScheduleProblem},
};
use tauri::Wry;
use tauri_specta::{Builder, ErrorHandlingMode};

use crate::diagnostics::crash_report::NativeCrashReport;
use crate::webview::{BrowserElementPicked, BrowserState};
use crate::window::{TerminationRequested, WindowMaximized};
use crate::{
    agent::install::{AgentInstallState, AgentInstallStatus},
    agent::profile::AgentConfigSnapshot,
    asset::{
        AssetFormat, AssetImportRequest, AssetRemoveRequest, AssetSessionCloseRequest,
        AssetSessionResult, AssetUploadRequest, AssetUploadResult,
    },
    automation::AutomationCatalogChanged,
    conversation::capability::{
        AgentCapability, AgentCapabilityInstall, AgentCapabilityInstallRequest,
        AgentCapabilityState,
    },
    conversation::custom_agents::{
        CustomAgentCatalog, CustomAgentFile, CustomAgentRemoveRequest, CustomAgentSaveRequest,
    },
    conversation::dto::{
        AgentAnswerQuestionsRequest, AgentArchiveThreadRequest, AgentCapabilitiesRequest,
        AgentConfigChoice, AgentConfigControl, AgentConfigPurpose, AgentDismissQuestionsRequest,
        AgentExportThreadRequest, AgentForkThreadRequest, AgentGoal, AgentPinThreadRequest,
        AgentPromptConfiguration, AgentPromptRequest, AgentPromptResult, AgentPromptSkill,
        AgentQuestionAnswer, AgentQuestionChoice, AgentQuestionMethod, AgentRenameThreadRequest,
        AgentResolvePermissionRequest, AgentRunBatch, AgentRunEvent, AgentSelectConfigRequest,
        AgentSessionEvent, AgentThreadRequest, AgentTranscriptEvent, AgentTranscriptJson,
        AgentTranscriptOpsRequest, AgentTranscriptRequest,
    },
    conversation::toolkit::{AgentMcpServer, AgentMcpStatus, AgentSkill, AgentToolkit},
    extension::{
        ForeignPluginInventory, ForeignPluginRecord, PluginCommitRequest, PluginFetch,
        PluginPayload, PluginStaged,
    },
    review::{
        GitBranches, GitChangeStatus, GitCommitIntent, GitCommitRequest, GitFileChange, GitReview,
        GitWatchLease, GitWorkingTreeChanged,
    },
    settings::{AppSettings, PrivacySettings},
    skills::{SkillCommitRequest, SkillRecord, SkillStaged},
    terminal::{TerminalChunk, TerminalStreamed},
    workspace::environment::EnvironmentFile,
};

/// 这个应用的全部 IPC 命令与 DTO。
///
/// Rust 侧的类型是权威，渲染层不得重新声明原生 DTO。
#[must_use]
pub fn surface() -> Builder<Wry> {
    Builder::<Wry>::new()
        .error_handling(ErrorHandlingMode::Throw)
        .commands(tauri_specta::collect_commands![
            crate::conversation::turn::agent_prompt,
            crate::conversation::turn::agent_cancel,
            crate::conversation::turn::agent_steer,
            crate::conversation::turn::agent_abort_prompt,
            crate::conversation::turn::agent_resolve_permission,
            crate::conversation::turn::agent_answer_questions,
            crate::conversation::turn::agent_dismiss_questions,
            crate::conversation::config::agent_set_config_option,
            crate::conversation::config::agent_capabilities,
            crate::conversation::toolkit::agent_toolkit,
            crate::conversation::model_catalog::agent_model_catalog,
            crate::conversation::capability::agent_capability_report,
            crate::conversation::capability::agent_capability_install,
            crate::conversation::thread::agent_threads,
            crate::conversation::thread::agent_thread_snapshot,
            crate::conversation::export::agent_export_thread,
            crate::conversation::thread::agent_open_thread,
            crate::conversation::turn::agent_transcript,
            crate::conversation::turn::agent_transcript_ops,
            crate::conversation::thread::agent_rename_thread,
            crate::conversation::thread::agent_archive_thread,
            crate::conversation::thread::agent_delete_thread,
            crate::conversation::thread::agent_pin_thread,
            crate::conversation::thread::agent_fork_thread,
            crate::asset::asset_formats,
            crate::asset::asset_session_open,
            crate::asset::asset_import,
            crate::asset::asset_upload,
            crate::asset::asset_remove,
            crate::asset::asset_session_close,
            crate::automation::automations_create,
            crate::automation::automations_update,
            crate::automation::automations_enable,
            crate::automation::automations_run,
            crate::automation::automations_cancel,
            crate::automation::automations_preview,
            crate::automation::automations_load,
            crate::automation::automations_remove,
            crate::workspace::environment::environment_mcp_config,
            crate::workspace::environment::environment_mcp_config_write,
            crate::launcher::launcher_resolve,
            crate::extension::plugins_catalog_read,
            crate::extension::plugins_catalog_refresh,
            crate::extension::plugins_commit,
            crate::extension::plugins_discard,
            crate::extension::plugins_foreign_list,
            crate::extension::plugins_list,
            crate::extension::plugins_remove,
            crate::extension::plugins_set_enabled,
            crate::extension::plugins_set_mcp_enabled,
            crate::extension::plugins_stage,
            crate::skills::skills_commit,
            crate::skills::skills_discard,
            crate::skills::skills_list,
            crate::skills::skills_trash,
            crate::skills::skills_set_enabled,
            crate::skills::skills_stage,
            crate::terminal::terminal_attach,
            crate::terminal::terminal_write,
            crate::terminal::terminal_resize,
            crate::terminal::terminal_close,
            crate::conversation::custom_agents::custom_agents_list,
            crate::conversation::custom_agents::custom_agents_save,
            crate::conversation::custom_agents::custom_agents_remove,
            crate::diagnostics::commands::diagnostics_take_previous_crash,
            crate::shutdown::application_quit,
            crate::window::commands::window_open_devtools,
            crate::window::commands::window_set_surface,
            crate::window::commands::window_open_external_url,
            crate::settings::settings_get,
            crate::settings::settings_set,
            crate::settings::settings_reset,
            crate::agent::profile::agent_config_get,
            crate::agent::profile::agent_config_save_agents,
            crate::agent::install::agent_install_status,
            crate::agent::install::agent_install_run,
            crate::ledger::usage::usage_token_days,
            crate::workspace::storage::storage_data_directory,
            crate::workspace::table::table_export,
            crate::ledger::workbench::workbench_session_load,
            crate::ledger::workbench::workbench_session_save,
            crate::workspace::workspace_pick_root,
            crate::workspace::workspace_create_projectless_root,
            crate::review::git_branches,
            crate::review::git_switch_branch,
            crate::review::git_create_branch,
            crate::review::git_review,
            crate::review::git_file_patch,
            crate::review::git_commit,
            crate::review::git_watch_start,
            crate::review::git_watch_stop,
            crate::webview::bridge::browser_state,
            crate::webview::bridge::browser_open_tab,
            crate::webview::bridge::browser_close_tab,
            crate::webview::bridge::browser_select_tab,
            crate::webview::bridge::browser_navigate,
            crate::webview::bridge::browser_back,
            crate::webview::bridge::browser_forward,
            crate::webview::bridge::browser_reload,
            crate::webview::bridge::browser_print,
            crate::webview::bridge::browser_reopen_closed,
            crate::webview::bridge::browser_set_bounds,
            crate::webview::bridge::browser_set_visible,
            crate::webview::bridge::browser_devtools_endpoint,
            crate::webview::bridge::browser_set_element_picker,
        ])
        .events(tauri_specta::collect_events![
            AgentRunBatch,
            AgentSessionEvent,
            AgentTranscriptEvent,
            AutomationCatalogChanged,
            BrowserElementPicked,
            BrowserState,
            TerminalStreamed,
            TerminationRequested,
            WindowMaximized,
            GitWorkingTreeChanged
        ])
        .typ::<AgentPromptRequest>()
        .typ::<AgentPromptConfiguration>()
        .typ::<AgentPromptResult>()
        .typ::<AgentPromptSkill>()
        .typ::<AgentResolvePermissionRequest>()
        .typ::<AgentQuestionMethod>()
        .typ::<AgentQuestionChoice>()
        .typ::<AgentQuestionAnswer>()
        .typ::<AgentAnswerQuestionsRequest>()
        .typ::<AgentDismissQuestionsRequest>()
        .typ::<AgentConfigPurpose>()
        .typ::<AgentConfigChoice>()
        .typ::<AgentConfigControl>()
        .typ::<AgentGoal>()
        .typ::<AgentRunBatch>()
        .typ::<AgentRunEvent>()
        .typ::<AgentSessionEvent>()
        .typ::<AgentCapabilitiesRequest>()
        .typ::<AgentSelectConfigRequest>()
        .typ::<AgentSkill>()
        .typ::<AgentMcpServer>()
        .typ::<AgentMcpStatus>()
        .typ::<AgentToolkit>()
        .typ::<AgentCapabilityInstall>()
        .typ::<AgentCapabilityState>()
        .typ::<AgentCapability>()
        .typ::<AgentCapabilityInstallRequest>()
        .typ::<AgentRenameThreadRequest>()
        .typ::<AgentArchiveThreadRequest>()
        .typ::<AgentThreadRequest>()
        .typ::<AgentExportThreadRequest>()
        .typ::<AgentForkThreadRequest>()
        .typ::<AgentPinThreadRequest>()
        .typ::<AgentTranscriptRequest>()
        .typ::<AgentTranscriptOpsRequest>()
        .typ::<AgentTranscriptJson>()
        .typ::<AssetFormat>()
        .typ::<AssetSessionResult>()
        .typ::<AssetImportRequest>()
        .typ::<AssetUploadRequest>()
        .typ::<AssetUploadResult>()
        .typ::<AssetRemoveRequest>()
        .typ::<AssetSessionCloseRequest>()
        .typ::<AutomationCatalogChanged>()
        .typ::<AutomationCreation>()
        .typ::<AutomationUpdate>()
        .typ::<AutomationRunOutcome>()
        .typ::<SchedulePreview>()
        .typ::<ScheduleProblem>()
        .typ::<AutomationRun>()
        .typ::<Automation>()
        .typ::<AutomationCatalog>()
        .typ::<crate::launcher::McpLauncher>()
        .typ::<EnvironmentFile>()
        .typ::<ForeignPluginInventory>()
        .typ::<ForeignPluginRecord>()
        .typ::<PluginFetch>()
        .typ::<PluginStaged>()
        .typ::<PluginCommitRequest>()
        .typ::<PluginPayload>()
        .typ::<SkillRecord>()
        .typ::<SkillStaged>()
        .typ::<SkillCommitRequest>()
        .typ::<CustomAgentCatalog>()
        .typ::<CustomAgentFile>()
        .typ::<CustomAgentSaveRequest>()
        .typ::<CustomAgentRemoveRequest>()
        .typ::<NativeCrashReport>()
        .typ::<AppSettings>()
        .typ::<PrivacySettings>()
        .typ::<AgentConfigSnapshot>()
        .typ::<AgentInstallState>()
        .typ::<AgentInstallStatus>()
        .typ::<TerminalChunk>()
        .typ::<TerminalStreamed>()
        .typ::<GitBranches>()
        .typ::<GitChangeStatus>()
        .typ::<GitCommitIntent>()
        .typ::<GitCommitRequest>()
        .typ::<GitFileChange>()
        .typ::<GitReview>()
        .typ::<GitWatchLease>()
        .typ::<GitWorkingTreeChanged>()
}
