//! 这个应用暴露给渲染层的那一张 IPC 面。
//!
//! 清单只有一份，就在下面的 `surface`。它同时是两件事的产地：运行期交给 Tauri 的
//! `invoke_handler`，以及构建期导出的 TypeScript 绑定。
//!
//! 一份清单两用是 tauri-specta 的范式：手抄第二份没有东西校验它，漏抄不报错，
//! 只会安静地少一条绑定。

pub mod export_bindings;

use tauri::Wry;
use tauri_specta::{Builder, ErrorHandlingMode};

use crate::browser::{BrowserElementPicked, BrowserState};
use crate::commands::{
    agent::dto::{
        AgentAnswerQuestionsRequest, AgentArchiveThreadRequest, AgentCapabilitiesRequest,
        AgentConfigChoice, AgentConfigControl, AgentConfigPurpose, AgentDismissQuestionsRequest,
        AgentEarlierFramesRequest, AgentForkThreadRequest, AgentFramesUntilRequest, AgentGoal,
        AgentPinThreadRequest, AgentPromptConfiguration, AgentPromptRequest, AgentPromptResult,
        AgentPromptSkill, AgentQuestionAnswer, AgentQuestionChoice, AgentQuestionMethod,
        AgentRenameThreadRequest, AgentResolvePermissionRequest, AgentSelectConfigRequest,
        AgentSessionEvent, AgentThreadRequest, AgentTurnMark,
    },
    agent::toolkit::{AgentMcpServer, AgentMcpStatus, AgentSkill, AgentToolkit},
    agent_setup::cli::{AgentCliRequest, AgentCliResult},
    agent_setup::install::{AgentInstallState, AgentInstallStatus},
    agent_setup::probe::ProviderProbeOutcome,
    agent_setup::profile::AgentConfigSnapshot,
    custom_agents::{
        CustomAgentCatalog, CustomAgentFile, CustomAgentRemoveRequest, CustomAgentSaveRequest,
    },
    asset::{
        AssetFormat, AssetImportRequest, AssetRemoveRequest, AssetSessionCloseRequest,
        AssetSessionResult, AssetUploadRequest, AssetUploadResult,
    },
    automations::{
        Automation, AutomationCatalog, AutomationCatalogChanged, AutomationCreation, AutomationDue,
        AutomationReschedule, AutomationRun, AutomationRunRecord,
    },
    environment::EnvironmentFile,
    git::{
        GitBranches, GitChangeStatus, GitCommitIntent, GitCommitRequest, GitFileChange, GitReview,
    },
    plugins::{
        ForeignPluginLedger, ForeignPluginRecord, PluginCommitRequest, PluginFetch, PluginPayload,
        PluginStaged,
    },
    settings::{AppSettings, PrivacySettings},
    skills::{SkillCommitRequest, SkillRecord, SkillStaged},
    updates::{UpdateProgress, UpdateRelease},
    window::WindowMaximized,
};
use crate::diagnostics::NativeCrashReport;

/// 这个应用的全部 IPC 命令与 DTO。
///
/// Rust 侧的类型是权威，渲染层不得重新声明原生 DTO。
#[must_use]
pub fn surface() -> Builder<Wry> {
    Builder::<Wry>::new()
        .error_handling(ErrorHandlingMode::Throw)
        .commands(tauri_specta::collect_commands![
            crate::commands::agent::turn::agent_prompt,
            crate::commands::agent::turn::agent_cancel,
            crate::commands::agent::turn::agent_steer,
            crate::commands::agent::turn::agent_abort_prompt,
            crate::commands::agent::turn::agent_resolve_permission,
            crate::commands::agent::turn::agent_answer_questions,
            crate::commands::agent::turn::agent_dismiss_questions,
            crate::commands::agent::turn::agent_shutdown,
            crate::commands::agent::config::agent_set_config_option,
            crate::commands::agent::config::agent_capabilities,
            crate::commands::agent::toolkit::agent_toolkit,
            crate::commands::agent::thread::agent_threads,
            crate::commands::agent::thread::agent_thread_snapshot,
            crate::commands::agent::thread::agent_open_thread,
            crate::commands::agent::thread::agent_earlier_frames,
            crate::commands::agent::thread::agent_frames_until,
            crate::commands::agent::thread::agent_thread_outline,
            crate::commands::agent::thread::agent_rename_thread,
            crate::commands::agent::thread::agent_archive_thread,
            crate::commands::agent::thread::agent_delete_thread,
            crate::commands::agent::thread::agent_pin_thread,
            crate::commands::agent::thread::agent_fork_thread,
            crate::commands::asset::asset_formats,
            crate::commands::asset::asset_session_open,
            crate::commands::asset::asset_import,
            crate::commands::asset::asset_upload,
            crate::commands::asset::asset_remove,
            crate::commands::asset::asset_session_close,
            crate::commands::automations::automations_create,
            crate::commands::automations::automations_load,
            crate::commands::automations::automations_upsert,
            crate::commands::automations::automations_remove,
            crate::commands::automations::automations_record_run,
            crate::commands::automations::automations_sweep,
            crate::commands::environment::environment_mcp_config,
            crate::commands::environment::environment_mcp_config_write,
            crate::commands::launcher::launcher_resolve,
            crate::mcp::mcp_endpoint,
            crate::commands::plugins::plugins_catalog_read,
            crate::commands::plugins::plugins_catalog_refresh,
            crate::commands::plugins::plugins_commit,
            crate::commands::plugins::plugins_discard,
            crate::commands::plugins::plugins_foreign_list,
            crate::commands::plugins::plugins_list,
            crate::commands::plugins::plugins_remove,
            crate::commands::plugins::plugins_set_enabled,
            crate::commands::plugins::plugins_set_mcp_enabled,
            crate::commands::plugins::plugins_stage,
            crate::commands::skills::skills_commit,
            crate::commands::skills::skills_discard,
            crate::commands::skills::skills_list,
            crate::commands::skills::skills_remove,
            crate::commands::skills::skills_set_enabled,
            crate::commands::skills::skills_stage,
            crate::commands::custom_agents::custom_agents_list,
            crate::commands::custom_agents::custom_agents_save,
            crate::commands::custom_agents::custom_agents_remove,
            crate::commands::diagnostics::diagnostics_take_previous_crash,
            crate::commands::window::window_open_devtools,
            crate::commands::window::window_open_external_url,
            crate::commands::settings::settings_get,
            crate::commands::settings::settings_set,
            crate::commands::settings::settings_reset,
            crate::commands::agent_setup::profile::agent_config_get,
            crate::commands::agent_setup::profile::agent_default_model,
            crate::commands::agent_setup::profile::agent_set_default_model,
            crate::commands::agent_setup::profile::agent_key_tails,
            crate::commands::agent_setup::profile::agent_config_save_agents,
            crate::commands::agent_setup::cli::agent_cli_exec,
            crate::commands::agent_setup::install::agent_install_status,
            crate::commands::agent_setup::install::agent_install_run,
            crate::commands::agent_setup::probe::provider_probe_key,
            crate::commands::updates::update_check,
            crate::commands::updates::update_download,
            crate::commands::updates::update_relaunch,
            crate::commands::usage::usage_token_days,
            crate::commands::storage::storage_data_directory,
            crate::commands::table::table_export,
            crate::commands::workbench::workbench_session_load,
            crate::commands::workbench::workbench_session_save,
            crate::commands::workspace::workspace_pick_root,
            crate::commands::workspace::workspace_create_projectless_root,
            crate::commands::git::git_branches,
            crate::commands::git::git_switch_branch,
            crate::commands::git::git_create_branch,
            crate::commands::git::git_review,
            crate::commands::git::git_commit,
            crate::commands::git::git_await_change,
            crate::browser::browser_state,
            crate::browser::browser_open_tab,
            crate::browser::browser_close_tab,
            crate::browser::browser_select_tab,
            crate::browser::browser_navigate,
            crate::browser::browser_back,
            crate::browser::browser_forward,
            crate::browser::browser_reload,
            crate::browser::browser_print,
            crate::browser::browser_reopen_closed,
            crate::browser::browser_set_bounds,
            crate::browser::browser_set_visible,
            crate::browser::browser_devtools_endpoint,
            crate::browser::browser_set_element_picker,
        ])
        .events(tauri_specta::collect_events![
            AutomationCatalogChanged,
            AutomationDue,
            BrowserElementPicked,
            BrowserState,
            UpdateProgress,
            WindowMaximized
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
        .typ::<AgentSessionEvent>()
        .typ::<AgentCapabilitiesRequest>()
        .typ::<AgentSelectConfigRequest>()
        .typ::<AgentSkill>()
        .typ::<AgentMcpServer>()
        .typ::<AgentMcpStatus>()
        .typ::<AgentToolkit>()
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
        .typ::<crate::mcp::McpEndpoint>()
        .typ::<crate::commands::launcher::McpLauncher>()
        .typ::<EnvironmentFile>()
        .typ::<ForeignPluginLedger>()
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
        .typ::<UpdateRelease>()
        .typ::<GitBranches>()
        .typ::<GitChangeStatus>()
        .typ::<GitCommitIntent>()
        .typ::<GitCommitRequest>()
        .typ::<GitFileChange>()
        .typ::<GitReview>()
}
