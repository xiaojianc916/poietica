//! 这个应用暴露给渲染层的那一张 IPC 面。
//!
//! 清单只有一份，就在下面的 `surface`。它同时是两件事的产地：运行期交给 Tauri 的
//! `invoke_handler`，以及构建期导出的 TypeScript 绑定。
//!
//! 一份清单两用是 tauri-specta 的范式：手抄第二份没有东西校验它，漏抄不报错，
//! 只会安静地少一条绑定。

pub mod commands;
pub mod export_bindings;
pub mod problem;

use tauri::Wry;
use tauri_specta::{Builder, ErrorHandlingMode};

use crate::diagnostics::crash_report::NativeCrashReport;
use crate::webview::{BrowserElementPicked, BrowserState};
use crate::window::{TerminationRequested, WindowMaximized};
use commands::{
    asset::{
        AssetFormat, AssetImportRequest, AssetRemoveRequest, AssetSessionCloseRequest,
        AssetSessionResult, AssetUploadRequest, AssetUploadResult,
    },
    automation::{
        Automation, AutomationCatalog, AutomationCatalogChanged, AutomationCreation, AutomationDue,
        AutomationReschedule, AutomationRun, AutomationRunRecord,
    },
    cli::exec::{AgentCliRequest, AgentCliResult},
    cli::install::{AgentInstallState, AgentInstallStatus},
    cli::probe::ProviderProbeOutcome,
    cli::profile::AgentConfigSnapshot,
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
        AgentEarlierFramesRequest, AgentForkThreadRequest, AgentFramesUntilRequest, AgentGoal,
        AgentPinThreadRequest, AgentPromptConfiguration, AgentPromptRequest, AgentPromptResult,
        AgentPromptSkill, AgentQuestionAnswer, AgentQuestionChoice, AgentQuestionMethod,
        AgentRenameThreadRequest, AgentResolvePermissionRequest, AgentRunBatch, AgentRunEvent,
        AgentSelectConfigRequest, AgentSessionEvent, AgentThreadRequest, AgentTurnMark,
    },
    conversation::toolkit::{AgentMcpServer, AgentMcpStatus, AgentSkill, AgentToolkit},
    extension::{
        ForeignPluginInventory, ForeignPluginRecord, PluginCommitRequest, PluginFetch,
        PluginPayload, PluginStaged,
    },
    git::{
        GitBranches, GitChangeStatus, GitCommitIntent, GitCommitRequest, GitFileChange, GitReview, GitWatchLease, GitWorkingTreeChanged,
    },
    settings::{AppSettings, PrivacySettings},
    skills::{SkillCommitRequest, SkillRecord, SkillStaged},
    terminal::{TerminalChunk, TerminalStreamed},
    updates::{UpdateProgress, UpdateRelease},
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
            commands::conversation::turn::agent_prompt,
            commands::conversation::turn::agent_cancel,
            commands::conversation::turn::agent_steer,
            commands::conversation::turn::agent_abort_prompt,
            commands::conversation::turn::agent_resolve_permission,
            commands::conversation::turn::agent_answer_questions,
            commands::conversation::turn::agent_dismiss_questions,
            commands::conversation::turn::agent_shutdown,
            commands::conversation::config::agent_set_config_option,
            commands::conversation::config::agent_capabilities,
            commands::conversation::toolkit::agent_toolkit,
            commands::conversation::capability::agent_capability_report,
            commands::conversation::capability::agent_capability_install,
            commands::conversation::thread::agent_threads,
            commands::conversation::thread::agent_thread_snapshot,
            commands::conversation::thread::agent_open_thread,
            commands::conversation::thread::agent_earlier_frames,
            commands::conversation::thread::agent_frames_until,
            commands::conversation::thread::agent_thread_outline,
            commands::conversation::thread::agent_rename_thread,
            commands::conversation::thread::agent_archive_thread,
            commands::conversation::thread::agent_delete_thread,
            commands::conversation::thread::agent_pin_thread,
            commands::conversation::thread::agent_fork_thread,
            commands::asset::asset_formats,
            commands::asset::asset_session_open,
            commands::asset::asset_import,
            commands::asset::asset_upload,
            commands::asset::asset_remove,
            commands::asset::asset_session_close,
            commands::automation::automations_create,
            commands::automation::automations_load,
            commands::automation::automations_upsert,
            commands::automation::automations_remove,
            commands::automation::automations_record_run,
            commands::automation::automations_sweep,
            commands::workspace::environment::environment_mcp_config,
            commands::workspace::environment::environment_mcp_config_write,
            commands::launcher::launcher_resolve,
            commands::automation::mcp_server::mcp_endpoint,
            commands::extension::plugins_catalog_read,
            commands::extension::plugins_catalog_refresh,
            commands::extension::plugins_commit,
            commands::extension::plugins_discard,
            commands::extension::plugins_foreign_list,
            commands::extension::plugins_list,
            commands::extension::plugins_remove,
            commands::extension::plugins_set_enabled,
            commands::extension::plugins_set_mcp_enabled,
            commands::extension::plugins_stage,
            commands::skills::skills_commit,
            commands::skills::skills_discard,
            commands::skills::skills_list,
            commands::skills::skills_trash,
            commands::skills::skills_set_enabled,
            commands::skills::skills_stage,
            commands::terminal::terminal_attach,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::conversation::custom_agents::custom_agents_list,
            commands::conversation::custom_agents::custom_agents_save,
            commands::conversation::custom_agents::custom_agents_remove,
            commands::diagnostics::diagnostics_take_previous_crash,
            crate::shutdown::application_quit,
            commands::window::window_open_devtools,
            commands::window::window_open_external_url,
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::settings::settings_reset,
            commands::cli::profile::agent_config_get,
            commands::cli::profile::agent_default_model,
            commands::cli::profile::agent_set_default_model,
            commands::cli::profile::agent_key_tails,
            commands::cli::profile::agent_config_save_agents,
            commands::cli::exec::agent_cli_exec,
            commands::cli::install::agent_install_status,
            commands::cli::install::agent_install_run,
            commands::cli::probe::provider_probe_key,
            commands::updates::update_check,
            commands::updates::update_download,
            commands::updates::update_relaunch,
            commands::ledger::usage::usage_token_days,
            commands::workspace::storage::storage_data_directory,
            commands::workspace::table::table_export,
            commands::ledger::workbench::workbench_session_load,
            commands::ledger::workbench::workbench_session_save,
            commands::workspace::workspace_pick_root,
            commands::workspace::workspace_create_projectless_root,
            commands::git::git_branches,
            commands::git::git_switch_branch,
            commands::git::git_create_branch,
            commands::git::git_review,
            commands::git::git_file_patch,
            commands::git::git_commit,
            commands::git::git_watch_start,
            commands::git::git_watch_stop,
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
            AutomationCatalogChanged,
            AutomationDue,
            BrowserElementPicked,
            BrowserState,
            TerminalStreamed,
            TerminationRequested,
            UpdateProgress,
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
        .typ::<AgentEarlierFramesRequest>()
        .typ::<AgentFramesUntilRequest>()
        .typ::<AgentTurnMark>()
        .typ::<AgentForkThreadRequest>()
        .typ::<AgentPinThreadRequest>()
        .typ::<AssetFormat>()
        .typ::<AssetSessionResult>()
        .typ::<AssetImportRequest>()
        .typ::<AssetUploadRequest>()
        .typ::<AssetUploadResult>()
        .typ::<AssetRemoveRequest>()
        .typ::<AssetSessionCloseRequest>()
        .typ::<AutomationCatalogChanged>()
        .typ::<AutomationCreation>()
        .typ::<AutomationDue>()
        .typ::<AutomationRun>()
        .typ::<Automation>()
        .typ::<AutomationCatalog>()
        .typ::<AutomationReschedule>()
        .typ::<AutomationRunRecord>()
        .typ::<commands::automation::mcp_server::McpEndpoint>()
        .typ::<commands::launcher::McpLauncher>()
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
        .typ::<AgentCliRequest>()
        .typ::<AgentInstallState>()
        .typ::<AgentInstallStatus>()
        .typ::<AgentCliResult>()
        .typ::<ProviderProbeOutcome>()
        .typ::<TerminalChunk>()
        .typ::<TerminalStreamed>()
        .typ::<UpdateRelease>()
        .typ::<GitBranches>()
        .typ::<GitChangeStatus>()
        .typ::<GitCommitIntent>()
        .typ::<GitCommitRequest>()
        .typ::<GitFileChange>()
        .typ::<GitReview>()
        .typ::<GitWatchLease>()
        .typ::<GitWorkingTreeChanged>()
}
