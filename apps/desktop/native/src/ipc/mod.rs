//! 原生组合根的命令面，唯一一份。
//!
//! 契约的产地在这里，不在 TypeScript：命令清单是下面那张分发表，参数与返回值的形状是
//! 各命令自己的签名，导出的 `ipc-bindings.ts` 都从这一处生成。渲染层先写形状即为缺陷。
//!
//! 这里只留原生确实持有实现的命令。内置浏览器、窗口、开发者工具归主进程（Electron 的
//! WebContentsView / BrowserWindow），它们由主进程自己的表处理，不在这里留一个只会报错
//! 的空壳：空壳会让契约看起来有这条命令，实际上没有。

pub mod problem;

use poietica_problem::Problem;
use serde_json::Value;

use crate::transport::{argument, settle};

/// 命令面的类型清单。生成的 TypeScript 从这里取每一个 DTO；没挂上的类型会以裸名
/// 出现在 .d.ts 里，TypeScript 当场报错 —— 挂漏了瞒不过去。
#[must_use]
pub fn types() -> specta::TypeCollection {
    let mut types = specta::TypeCollection::default();
    types.register::<crate::conversation::dto::AgentPromptRequest>();
    types.register::<crate::conversation::dto::AgentPromptConfiguration>();
    types.register::<crate::conversation::dto::AgentPromptResult>();
    types.register::<crate::conversation::dto::AgentPromptSkill>();
    types.register::<crate::conversation::dto::AgentResolvePermissionRequest>();
    types.register::<crate::conversation::dto::AgentQuestionMethod>();
    types.register::<crate::conversation::dto::AgentQuestionChoice>();
    types.register::<crate::conversation::dto::AgentQuestionAnswer>();
    types.register::<crate::conversation::dto::AgentAnswerQuestionsRequest>();
    types.register::<crate::conversation::dto::AgentDismissQuestionsRequest>();
    types.register::<crate::conversation::dto::AgentConfigPurpose>();
    types.register::<crate::conversation::dto::AgentConfigChoice>();
    types.register::<crate::conversation::dto::AgentConfigControl>();
    types.register::<crate::conversation::dto::AgentGoal>();
    types.register::<crate::conversation::dto::AgentSessionEvent>();
    types.register::<crate::conversation::dto::AgentCapabilitiesRequest>();
    types.register::<crate::conversation::dto::AgentSelectConfigRequest>();
    types.register::<poietica_conversation_runtime::toolkit::AgentSkill>();
    types.register::<poietica_conversation_runtime::toolkit::AgentMcpServer>();
    types.register::<poietica_conversation_runtime::toolkit::AgentMcpStatus>();
    types.register::<poietica_conversation_runtime::toolkit::AgentToolkit>();
    types.register::<crate::conversation::capability::AgentCapabilityInstall>();
    types.register::<crate::conversation::capability::AgentCapabilityState>();
    types.register::<crate::conversation::capability::AgentCapability>();
    types.register::<crate::conversation::capability::AgentCapabilityInstallRequest>();
    types.register::<crate::conversation::capability::AgentBrowserSettings>();
    types.register::<crate::conversation::capability::AgentBrowserSettingsPatch>();
    types.register::<crate::conversation::settings::AgentSettingsCatalog>();
    types.register::<crate::conversation::settings::AgentSettingEntry>();
    types.register::<crate::conversation::settings::AgentSettingOption>();
    types.register::<crate::conversation::settings::AgentSettingWriteRequest>();
    types.register::<crate::conversation::dto::AgentRenameThreadRequest>();
    types.register::<crate::conversation::dto::AgentArchiveThreadRequest>();
    types.register::<crate::conversation::dto::AgentThreadRequest>();
    types.register::<crate::conversation::dto::AgentExportThreadRequest>();
    types.register::<crate::conversation::dto::AgentShareThreadRequest>();
    types.register::<crate::conversation::dto::AgentSharedThread>();
    types.register::<crate::conversation::dto::AgentForkThreadRequest>();
    types.register::<crate::conversation::dto::AgentPinThreadRequest>();
    types.register::<crate::conversation::dto::AgentTranscriptRequest>();
    types.register::<crate::conversation::dto::AgentTranscriptOpsRequest>();
    types.register::<crate::conversation::dto::AgentTranscriptJson>();
    types.register::<crate::conversation::dto::AgentSessionMediaRequest>();
    types.register::<crate::conversation::dto::AgentSessionMediaResult>();
    types.register::<crate::asset::AssetSessionResult>();
    types.register::<crate::asset::AssetImportRequest>();
    types.register::<crate::asset::AssetUploadRequest>();
    types.register::<crate::asset::AssetUploadResult>();
    types.register::<crate::asset::AssetReadRequest>();
    types.register::<crate::asset::AssetReadResult>();
    types.register::<crate::asset::AssetRemoveRequest>();
    types.register::<crate::automation::host::AutomationCatalogChanged>();
    types.register::<poietica_automation::AutomationCreation>();
    types.register::<poietica_automation::AutomationUpdate>();
    types.register::<poietica_automation::AutomationRunOutcome>();
    types.register::<poietica_automation::schedule::SchedulePreview>();
    types.register::<poietica_automation::schedule::ScheduleProblem>();
    types.register::<poietica_automation::AutomationRun>();
    types.register::<poietica_automation::Automation>();
    types.register::<poietica_automation::AutomationCatalog>();
    types.register::<crate::workspace::environment::EnvironmentFile>();
    types.register::<crate::extension::ForeignPluginInventory>();
    types.register::<crate::extension::ForeignPluginRecord>();
    types.register::<crate::extension::PluginFetch>();
    types.register::<crate::extension::PluginStaged>();
    types.register::<crate::extension::PluginCommitRequest>();
    types.register::<crate::extension::PluginPayload>();
    types.register::<crate::skills::SkillRecord>();
    types.register::<crate::skills::SkillStaged>();
    types.register::<crate::skills::SkillCommitRequest>();
    types.register::<crate::settings::AppSettings>();
    types.register::<crate::settings::PrivacySettings>();
    types.register::<crate::agent::profile::AgentConfigSnapshot>();
    types.register::<crate::agent::install::AgentInstallState>();
    types.register::<crate::agent::install::AgentInstallStatus>();
    types.register::<crate::terminal::TerminalChunk>();
    types.register::<crate::terminal::TerminalStreamed>();
    types.register::<crate::review::GitBranches>();
    types.register::<crate::review::GitChangeStatus>();
    types.register::<crate::review::GitCommitIntent>();
    types.register::<crate::review::GitCommitRequest>();
    types.register::<crate::review::GitFileChange>();
    types.register::<crate::review::GitReview>();
    types.register::<crate::review::GitWatchLease>();
    types.register::<crate::review::GitWorkingTreeChanged>();
    types.register::<crate::conversation::dto::AgentCancelRequest>();
    types.register::<crate::conversation::dto::AgentWithdrawnMessage>();
    types.register::<crate::conversation::dto::AgentDeliveryModesRequest>();
    types.register::<crate::conversation::dto::AgentAbortPromptRequest>();
    types.register::<crate::conversation::dto::AgentThread>();
    types.register::<crate::conversation::dto::AgentThreadSnapshot>();
    types.register::<crate::conversation::dto::AgentOpenThreadRequest>();
    types.register::<crate::conversation::dto::AgentOpenedThread>();
    types.register::<crate::conversation::toolkit::AgentToolkitRequest>();
    types.register::<crate::conversation::model_catalog::AgentModelCatalogRequest>();
    types.register::<crate::conversation::model_catalog::ModelCatalogSnapshotDto>();
    types.register::<crate::launcher::McpLauncher>();
    types.register::<crate::ledger::usage::UsageDay>();
    types.register::<crate::settings::SettingsWriteResult>();
    types.register::<crate::conversation::dto::AgentTranscriptEvent>();
    types.register::<crate::python::PythonKernelState>();
    types.register::<crate::python::PythonKernelInstall>();
    types.register::<crate::python::PythonKernelStatus>();
    types
}

/// 命令面的类型化函数清单：`collect_functions!` 逐个调各自 `#[specta::specta]` 展开出来
/// 的导出器，顺带把它们的依赖类型塞进同一份集合。
#[must_use]
pub fn functions() -> Vec<specta::datatype::Function> {
    specta::function::collect_functions![
        crate::conversation::turn::agent_prompt,
        crate::conversation::turn::agent_cancel,
        crate::conversation::turn::agent_queue,
        crate::conversation::turn::agent_withdraw,
        crate::conversation::turn::agent_set_delivery_modes,
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
        crate::conversation::capability::agent_browser_settings,
        crate::conversation::capability::agent_set_browser_settings,
        crate::conversation::settings::agent_settings_catalog,
        crate::conversation::settings::agent_set_setting,
        crate::conversation::thread::agent_threads,
        crate::conversation::thread::agent_thread_snapshot,
        crate::conversation::export::agent_export_thread,
        crate::conversation::share::agent_share_thread,
        crate::conversation::thread::agent_open_thread,
        crate::conversation::turn::agent_transcript,
        crate::conversation::turn::agent_transcript_ops,
        crate::conversation::turn::agent_session_media,
        crate::conversation::thread::agent_rename_thread,
        crate::conversation::thread::agent_archive_thread,
        crate::conversation::thread::agent_delete_thread,
        crate::conversation::thread::agent_pin_thread,
        crate::conversation::thread::agent_fork_thread,
        crate::asset::asset_session_open,
        crate::asset::asset_import,
        crate::asset::asset_upload,
        crate::asset::asset_read,
        crate::asset::asset_remove,
        crate::automation::commands::automations_create,
        crate::automation::commands::automations_update,
        crate::automation::commands::automations_enable,
        crate::automation::commands::automations_run,
        crate::automation::commands::automations_cancel,
        crate::automation::commands::automations_preview,
        crate::automation::commands::automations_load,
        crate::automation::commands::automations_remove,
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
        crate::settings::commands::settings_get,
        crate::settings::commands::settings_set,
        crate::settings::commands::settings_reset,
        crate::agent::profile::agent_config_get,
        crate::agent::profile::agent_config_save_agents,
        crate::agent::install::agent_install_status,
        crate::agent::install::agent_install_run,
        crate::ledger::usage::usage_token_days,
        crate::workspace::storage::storage_data_directory,
        crate::ledger::workbench::workbench_session_load,
        crate::ledger::workbench::workbench_session_save,
        crate::workspace::workspace_create_projectless_root,
        crate::review::git_branches,
        crate::review::git_switch_branch,
        crate::review::git_create_branch,
        crate::review::git_review,
        crate::review::git_file_patch,
        crate::review::git_commit,
        crate::review::git_watch_start,
        crate::review::git_watch_stop,
        crate::python::python_kernel_status,
        crate::python::python_kernel_install,
        crate::python::python_kernel_remove,
    ](&mut types())
}

/// 一次调用：命令名加参数，回结算后的信封。
///
/// 命令名不认识就是一次明确的失败，不是静默的空应答：渲染层拼错名字时必须当场看见。
pub async fn submit(command: &str, args: Value) -> napi::Result<String> {
    let outcome: Result<Value, Problem> = match command {
        "agent_prompt" => {
            let request: crate::conversation::dto::AgentPromptRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::turn::agent_prompt(request).await)
        }
        "agent_cancel" => {
            let request: crate::conversation::dto::AgentCancelRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::turn::agent_cancel(request).await)
        }
        "agent_queue" => crud(crate::conversation::turn::agent_queue().await),
        "agent_withdraw" => crud(crate::conversation::turn::agent_withdraw().await),
        "agent_set_delivery_modes" => {
            let request: crate::conversation::dto::AgentDeliveryModesRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::turn::agent_set_delivery_modes(request).await)
        }
        "agent_abort_prompt" => {
            let request: crate::conversation::dto::AgentAbortPromptRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::turn::agent_abort_prompt(request).await)
        }
        "agent_resolve_permission" => {
            let request: crate::conversation::dto::AgentResolvePermissionRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::turn::agent_resolve_permission(request))
        }
        "agent_answer_questions" => {
            let request: crate::conversation::dto::AgentAnswerQuestionsRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::turn::agent_answer_questions(request))
        }
        "agent_dismiss_questions" => {
            let request: crate::conversation::dto::AgentDismissQuestionsRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::turn::agent_dismiss_questions(request))
        }
        "agent_set_config_option" => {
            let request: crate::conversation::dto::AgentSelectConfigRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::config::agent_set_config_option(request).await)
        }
        "agent_capabilities" => {
            let request: crate::conversation::dto::AgentCapabilitiesRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::config::agent_capabilities(request).await)
        }
        "agent_toolkit" => {
            let request: crate::conversation::toolkit::AgentToolkitRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::toolkit::agent_toolkit(request).await)
        }
        "agent_model_catalog" => {
            let request: crate::conversation::model_catalog::AgentModelCatalogRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::model_catalog::agent_model_catalog(request).await)
        }
        "agent_capability_report" => {
            crud(crate::conversation::capability::agent_capability_report().await)
        }
        "agent_capability_install" => {
            let request: crate::conversation::capability::AgentCapabilityInstallRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::capability::agent_capability_install(request).await)
        }
        "agent_browser_settings" => {
            crud(crate::conversation::capability::agent_browser_settings().await)
        }
        "agent_set_browser_settings" => {
            let request: crate::conversation::capability::AgentBrowserSettingsPatch =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::capability::agent_set_browser_settings(request).await)
        }
        "agent_settings_catalog" => {
            crud(crate::conversation::settings::agent_settings_catalog().await)
        }
        "agent_set_setting" => {
            let request: crate::conversation::settings::AgentSettingWriteRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::settings::agent_set_setting(request).await)
        }
        "agent_threads" => crud(crate::conversation::thread::agent_threads().await),
        "agent_thread_snapshot" => {
            let request: crate::conversation::dto::AgentThreadRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::thread::agent_thread_snapshot(request).await)
        }
        "agent_export_thread" => {
            let request: crate::conversation::dto::AgentExportThreadRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::export::agent_export_thread(request).await)
        }
        "agent_share_thread" => {
            let request: crate::conversation::dto::AgentShareThreadRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::share::agent_share_thread(request).await)
        }
        "agent_open_thread" => {
            let request: crate::conversation::dto::AgentOpenThreadRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::thread::agent_open_thread(request).await)
        }
        "agent_transcript" => {
            let request: crate::conversation::dto::AgentTranscriptRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::turn::agent_transcript(request).await)
        }
        "agent_transcript_ops" => {
            let request: crate::conversation::dto::AgentTranscriptOpsRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::turn::agent_transcript_ops(request).await)
        }
        "agent_session_media" => {
            let request: crate::conversation::dto::AgentSessionMediaRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::turn::agent_session_media(request).await)
        }
        "agent_rename_thread" => {
            let request: crate::conversation::dto::AgentRenameThreadRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::thread::agent_rename_thread(request).await)
        }
        "agent_archive_thread" => {
            let request: crate::conversation::dto::AgentArchiveThreadRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::thread::agent_archive_thread(request).await)
        }
        "agent_delete_thread" => {
            let request: crate::conversation::dto::AgentThreadRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::thread::agent_delete_thread(request).await)
        }
        "agent_pin_thread" => {
            let request: crate::conversation::dto::AgentPinThreadRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::thread::agent_pin_thread(request).await)
        }
        "agent_fork_thread" => {
            let request: crate::conversation::dto::AgentForkThreadRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::conversation::thread::agent_fork_thread(request).await)
        }
        "asset_session_open" => crud(crate::asset::asset_session_open().await),
        "asset_import" => {
            let request: crate::asset::AssetImportRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::asset::asset_import(request).await)
        }
        "asset_upload" => {
            let request: crate::asset::AssetUploadRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::asset::asset_upload(request).await)
        }
        "asset_read" => {
            let request: crate::asset::AssetReadRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::asset::asset_read(request).await)
        }
        "asset_remove" => {
            let request: crate::asset::AssetRemoveRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::asset::asset_remove(request).await)
        }
        "automations_create" => {
            let creation: poietica_automation::AutomationCreation =
                argument(args.get("creation").unwrap_or(&Value::Null))?;
            crud(crate::automation::commands::automations_create(creation).await)
        }
        "automations_update" => {
            let update: poietica_automation::AutomationUpdate =
                argument(args.get("update").unwrap_or(&Value::Null))?;
            crud(crate::automation::commands::automations_update(update).await)
        }
        "automations_enable" => {
            let id: String = argument(args.get("id").unwrap_or(&Value::Null))?;
            let revision: u32 = argument(args.get("revision").unwrap_or(&Value::Null))?;
            let enabled: bool = argument(args.get("enabled").unwrap_or(&Value::Null))?;
            crud(crate::automation::commands::automations_enable(id, revision, enabled).await)
        }
        "automations_run" => {
            let id: String = argument(args.get("id").unwrap_or(&Value::Null))?;
            let request_id: String = argument(args.get("requestId").unwrap_or(&Value::Null))?;
            crud(crate::automation::commands::automations_run(id, request_id).await)
        }
        "automations_cancel" => {
            let run_id: String = argument(args.get("runId").unwrap_or(&Value::Null))?;
            crud(crate::automation::commands::automations_cancel(run_id).await)
        }
        "automations_preview" => {
            let schedule: Option<String> = argument(args.get("schedule").unwrap_or(&Value::Null))?;
            let time_zone: String = argument(args.get("timeZone").unwrap_or(&Value::Null))?;
            crud(Ok(crate::automation::commands::automations_preview(
                schedule, time_zone,
            )))
        }
        "automations_load" => crud(crate::automation::commands::automations_load().await),
        "automations_remove" => {
            let id: String = argument(args.get("id").unwrap_or(&Value::Null))?;
            crud(crate::automation::commands::automations_remove(id).await)
        }
        "environment_mcp_config" => {
            crud(crate::workspace::environment::environment_mcp_config().await)
        }
        "environment_mcp_config_write" => {
            let expected_contents: Option<String> =
                argument(args.get("expectedContents").unwrap_or(&Value::Null))?;
            let contents: String = argument(args.get("contents").unwrap_or(&Value::Null))?;
            crud(
                crate::workspace::environment::environment_mcp_config_write(
                    expected_contents,
                    contents,
                )
                .await,
            )
        }
        "launcher_resolve" => {
            let program: String = argument(args.get("program").unwrap_or(&Value::Null))?;
            crud(crate::launcher::launcher_resolve(program).await)
        }
        "plugins_catalog_read" => crud(crate::extension::plugins_catalog_read().await),
        "plugins_catalog_refresh" => {
            let url: String = argument(args.get("url").unwrap_or(&Value::Null))?;
            crud(crate::extension::plugins_catalog_refresh(url).await)
        }
        "plugins_commit" => {
            let request: crate::extension::PluginCommitRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::extension::plugins_commit(request).await)
        }
        "plugins_discard" => {
            let staging_id: String = argument(args.get("stagingId").unwrap_or(&Value::Null))?;
            crud(crate::extension::plugins_discard(staging_id).await)
        }
        "plugins_foreign_list" => crud(crate::extension::plugins_foreign_list().await),
        "plugins_list" => crud(crate::extension::plugins_list().await),
        "plugins_remove" => {
            let plugin_id: String = argument(args.get("pluginId").unwrap_or(&Value::Null))?;
            crud(crate::extension::plugins_remove(plugin_id).await)
        }
        "plugins_set_enabled" => {
            let plugin_id: String = argument(args.get("pluginId").unwrap_or(&Value::Null))?;
            let enabled: bool = argument(args.get("enabled").unwrap_or(&Value::Null))?;
            crud(crate::extension::plugins_set_enabled(plugin_id, enabled).await)
        }
        "plugins_set_mcp_enabled" => {
            let plugin_id: String = argument(args.get("pluginId").unwrap_or(&Value::Null))?;
            let server: String = argument(args.get("server").unwrap_or(&Value::Null))?;
            let enabled: bool = argument(args.get("enabled").unwrap_or(&Value::Null))?;
            crud(crate::extension::plugins_set_mcp_enabled(plugin_id, server, enabled).await)
        }
        "plugins_stage" => {
            let fetch: crate::extension::PluginFetch =
                argument(args.get("fetch").unwrap_or(&Value::Null))?;
            crud(crate::extension::plugins_stage(fetch).await)
        }
        "skills_commit" => {
            let request: crate::skills::SkillCommitRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::skills::skills_commit(request).await)
        }
        "skills_discard" => {
            let staging_id: String = argument(args.get("stagingId").unwrap_or(&Value::Null))?;
            crud(crate::skills::skills_discard(staging_id).await)
        }
        "skills_list" => crud(crate::skills::skills_list().await),
        "skills_trash" => {
            let name: String = argument(args.get("name").unwrap_or(&Value::Null))?;
            crud(crate::skills::skills_trash(name).await)
        }
        "skills_set_enabled" => {
            let name: String = argument(args.get("name").unwrap_or(&Value::Null))?;
            let enabled: bool = argument(args.get("enabled").unwrap_or(&Value::Null))?;
            crud(crate::skills::skills_set_enabled(name, enabled).await)
        }
        "skills_stage" => {
            let fetch: crate::extension::PluginFetch =
                argument(args.get("fetch").unwrap_or(&Value::Null))?;
            crud(crate::skills::skills_stage(fetch).await)
        }
        "terminal_attach" => {
            let root: String = argument(args.get("root").unwrap_or(&Value::Null))?;
            let cols: u16 = argument(args.get("cols").unwrap_or(&Value::Null))?;
            let rows: u16 = argument(args.get("rows").unwrap_or(&Value::Null))?;
            crud(crate::terminal::terminal_attach(root, cols, rows).await)
        }
        "terminal_write" => {
            let root: String = argument(args.get("root").unwrap_or(&Value::Null))?;
            let data: String = argument(args.get("data").unwrap_or(&Value::Null))?;
            crud(crate::terminal::terminal_write(root, data).await)
        }
        "terminal_resize" => {
            let root: String = argument(args.get("root").unwrap_or(&Value::Null))?;
            let cols: u16 = argument(args.get("cols").unwrap_or(&Value::Null))?;
            let rows: u16 = argument(args.get("rows").unwrap_or(&Value::Null))?;
            crud(crate::terminal::terminal_resize(root, cols, rows).await)
        }
        "terminal_close" => {
            let root: String = argument(args.get("root").unwrap_or(&Value::Null))?;
            crate::terminal::terminal_close(root).await;
            Ok(Value::Null)
        }
        "settings_get" => crud(crate::settings::commands::settings_get().await),
        "settings_set" => {
            let settings: crate::settings::AppSettings =
                argument(args.get("settings").unwrap_or(&Value::Null))?;
            crud(crate::settings::commands::settings_set(settings).await)
        }
        "settings_reset" => crud(crate::settings::commands::settings_reset().await),
        "agent_config_get" => crud(crate::agent::profile::agent_config_get().await),
        "agent_config_save_agents" => {
            let agents: Vec<Value> = argument(args.get("agents").unwrap_or(&Value::Null))?;
            let default_agent_id: String =
                argument(args.get("defaultAgentId").unwrap_or(&Value::Null))?;
            crud(crate::agent::profile::agent_config_save_agents(agents, default_agent_id).await)
        }
        "agent_install_status" => {
            let agent_id: String = argument(args.get("agentId").unwrap_or(&Value::Null))?;
            let force: bool = argument(args.get("force").unwrap_or(&Value::Null))?;
            crud(crate::agent::install::agent_install_status(agent_id, force).await)
        }
        "agent_install_run" => {
            let agent_id: String = argument(args.get("agentId").unwrap_or(&Value::Null))?;
            crud(crate::agent::install::agent_install_run(agent_id).await)
        }
        "usage_token_days" => {
            let span: u32 = argument(args.get("span").unwrap_or(&Value::Null))?;
            crud(crate::ledger::usage::usage_token_days(span).await)
        }
        "storage_data_directory" => crud(crate::workspace::storage::storage_data_directory().await),
        "workbench_session_load" => crud(crate::ledger::workbench::workbench_session_load().await),
        "workbench_session_save" => {
            let document: String = argument(args.get("document").unwrap_or(&Value::Null))?;
            crud(crate::ledger::workbench::workbench_session_save(document).await)
        }
        "workspace_create_projectless_root" => {
            crud(crate::workspace::workspace_create_projectless_root().await)
        }
        "git_branches" => {
            let root: String = argument(args.get("root").unwrap_or(&Value::Null))?;
            crud(crate::review::git_branches(root).await)
        }
        "git_switch_branch" => {
            let root: String = argument(args.get("root").unwrap_or(&Value::Null))?;
            let branch: String = argument(args.get("branch").unwrap_or(&Value::Null))?;
            crud(crate::review::git_switch_branch(root, branch).await)
        }
        "git_create_branch" => {
            let root: String = argument(args.get("root").unwrap_or(&Value::Null))?;
            let branch: String = argument(args.get("branch").unwrap_or(&Value::Null))?;
            crud(crate::review::git_create_branch(root, branch).await)
        }
        "git_review" => {
            let root: String = argument(args.get("root").unwrap_or(&Value::Null))?;
            let base: String = argument(args.get("base").unwrap_or(&Value::Null))?;
            let context: u32 = argument(args.get("context").unwrap_or(&Value::Null))?;
            let ignore_whitespace: bool =
                argument(args.get("ignoreWhitespace").unwrap_or(&Value::Null))?;
            crud(crate::review::git_review(root, base, context, ignore_whitespace).await)
        }
        "git_file_patch" => {
            let root: String = argument(args.get("root").unwrap_or(&Value::Null))?;
            let base: String = argument(args.get("base").unwrap_or(&Value::Null))?;
            let path: String = argument(args.get("path").unwrap_or(&Value::Null))?;
            let ignore_whitespace: bool =
                argument(args.get("ignoreWhitespace").unwrap_or(&Value::Null))?;
            crud(crate::review::git_file_patch(root, base, path, ignore_whitespace).await)
        }
        "git_commit" => {
            let request: crate::review::GitCommitRequest =
                argument(args.get("request").unwrap_or(&Value::Null))?;
            crud(crate::review::git_commit(request).await)
        }
        "git_watch_start" => {
            let root: String = argument(args.get("root").unwrap_or(&Value::Null))?;
            crud(crate::review::git_watch_start(root).await)
        }
        "git_watch_stop" => {
            let token: String = argument(args.get("token").unwrap_or(&Value::Null))?;
            crud(crate::review::git_watch_stop(token).await)
        }
        "python_kernel_status" => crud(crate::python::python_kernel_status().await),
        "python_kernel_install" => crud(crate::python::python_kernel_install().await),
        "python_kernel_remove" => crud(crate::python::python_kernel_remove().await),
        unknown => Err(Problem::from(crate::error::Error::NotFound(format!(
            "no such native command: {unknown}"
        )))),
    };

    settle(outcome)
}

/// 命令结果到线上形状的唯一一处转换：领域错误变 Problem，值变 JSON。
///
/// 没有它，每条命令都要自己写一遍这两步，而每一步的返回类型都取决于那条命令的签名。
fn crud<T: serde::Serialize>(outcome: Result<T, Problem>) -> Result<Value, Problem> {
    outcome.and_then(|value| {
        serde_json::to_value(value)
            .map_err(|error| Problem::from(crate::error::Error::SerdeJson(error)))
    })
}
