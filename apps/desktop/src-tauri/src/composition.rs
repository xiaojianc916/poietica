//! 唯一装配点：把 crate 与插件接成一个进程。这里只做接线，不裁决。

use tauri::{Manager, Wry, async_runtime};
use tauri_plugin_store::StoreExt;
use tauri_specta::Event as _;

use crate::asset_protocol::{ASSET_PROTOCOL_SCHEME, AssetProtocolRegistry};
use crate::diagnostics::structured_log;
use crate::paths;
use crate::window::{MAIN_WINDOW, WINDOW_STATE_FLAGS, WindowSurface, tray};

pub fn build() -> tauri::Builder<Wry> {
    let started = std::time::Instant::now();
    let asset_protocol = AssetProtocolRegistry::default();
    let protocol_registry = asset_protocol.clone();

    /* 命令清单在 crate::ipc::surface，与导出 TypeScript 绑定的是同一份。 */
    let ipc = crate::ipc::surface();

    tauri::Builder::<Wry>::default()

        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                tray::show_main(app);
            },
        ))
        .manage(asset_protocol)
        .manage(WindowSurface::default())
        .manage(crate::shutdown::ShutdownBarrier::default())
        .manage(crate::workspace::environment::McpConfigAccess::default())

        .register_asynchronous_uri_scheme_protocol(
            ASSET_PROTOCOL_SCHEME,
            move |_context, request, responder| {
                let registry = protocol_registry.clone();

                async_runtime::spawn_blocking(move || {
                    responder.respond(crate::asset_protocol::respond(&registry, &request));
                });
            },
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())

        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(WINDOW_STATE_FLAGS)
                .skip_initial_state(MAIN_WINDOW)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        /* 终端会话表归进程：谁创建谁负责，命令只借用。 */
        .manage(crate::terminal::TerminalHost::default())
        .manage(poietica_git_adapter_native::WatchRegistry::default())
        .invoke_handler(ipc.invoke_handler())
        .setup(move |app| {
            /* 日志比其余一切都早：出事时它是唯一的目击者，它只需要落点先算出来。 */
            let handle = app.handle();

            handle.plugin(structured_log::plugin(paths::log_directory(handle)?).build())?;

            /* 生成的事件面挂一次；命令面走 invoke_handler，两者同源。 */
            ipc.mount_events(app);

            app.store(paths::settings_store(handle)?)?;
            app.store(paths::agents_store(handle)?)?;

            let database = paths::ledger_database(handle)?;
            let index = crate::ledger::LocalIndex::open(
                &database,
                poietica_time::wall_clock::SystemWallClock,
            )?;
            let publisher = handle.clone();
            let journal = poietica_conversation_runtime::journal::FrameJournal::new(
                index.clone(),
                move |session_id, envelopes| {
                    let events = envelopes
                        .into_iter()
                        .map(crate::conversation::dto::AgentRunEvent::from)
                        .collect();
                    if let Err(error) =
                        (crate::conversation::dto::AgentRunBatch { session_id, events })
                            .emit(&publisher)
                    {
                        log::warn!("emit agent event failed after persistence: {error}");
                    }
                },
            )?;
            let runtime = crate::conversation::composition::compose(
                handle, handle.path().home_dir()?, paths::attachments_root(handle)?,
                index.clone(), journal,
            );
            let _index = app.manage(index.clone());
            let _managed = app.manage(std::sync::Arc::clone(&runtime));
            let _browser = app.manage(crate::webview::BrowserHost::new());
            let _automation_mcp = app.manage(crate::automation::mcp_server::serve(handle)?);
            let automation = crate::automation::host::start(handle, index.clone(), runtime);
            let may_reclaim = automation.available().is_ok();
            let _automations = app.manage(automation);

            let settings_app = handle.clone();
            async_runtime::spawn(async move {
                crate::settings::apply_startup_settings(&settings_app).await;
            });

            // This boundary precedes the first conversation created by the renderer.
            let boundary = uuid::Uuid::now_v7();
            let sweeper = handle.clone();
            async_runtime::spawn(async move {
                if !may_reclaim {
                    log::warn!("workspace reclamation skipped because automation ownership could not be initialized");
                    return;
                }
                if let Err(error) = crate::workspace::reconcile::run(sweeper, index, boundary).await
                {
                    log::warn!("could not reconcile leftover conversation state: {error}");
                }
            });

            crate::diagnostics::crash_report::install(app.handle())?;
            tray::install(app.handle())?;

            /* 恢复几何、播报最大化态、挂呈现看门狗 —— 都归 window::lifecycle。 */
            let main_window = app
                .get_webview_window(MAIN_WINDOW)
                .ok_or("tauri.conf.json 未声明 main 窗口")?;

            crate::window::lifecycle::restore_initial_geometry(&main_window)?;
            crate::window::lifecycle::watch_maximized(&main_window);
            crate::window::lifecycle::present_watchdog(main_window.clone());

            log::info!(
                "native setup finished {} ms after build start",
                started.elapsed().as_millis()
            );

            Ok(())
        })
}
