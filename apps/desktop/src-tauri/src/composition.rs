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
        /*
         * 必须是第一个注册的插件：它要在其余初始化发生之前判定本进程是不是多余
         * 的那一个。
         *
         * 一个带托盘的应用不做单实例，后果是确定的：第二次双击图标开出第二个
         * 进程、第二个托盘图标、两份互相覆写的窗口状态，以及两个互不知情的
         * DocumentRegistry —— 同一个文件可以在两个窗口里各改各的。
         */
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                tray::show_main(app);
            },
        ))
        .manage(asset_protocol)
        .manage(WindowSurface::default())
        .manage(crate::shutdown::ShutdownBarrier::default())
        .manage(crate::workspace::environment::McpConfigAccess::default())
        /*
         * A synchronous protocol handler is invoked by the platform webview on
         * its own thread, which is the UI thread on Windows and macOS. Building
         * a response takes the registry read lock and copies the asset, up to
         * MAX_ASSET_BYTES of it, so answering inline stalled painting and input
         * for the length of that copy on every cache miss.
         *
         * The copy cannot be removed. Tauri bounds a protocol response body by
         * Into<Cow<'static, [u8]>>, and an asset owned by the registry is not
         * 'static, so it can only be handed over as Cow::Owned. Sharing types
         * do not help. What can be fixed is which thread pays for it.
         *
         * The responder is Send, so the work moves to the blocking executor and
         * the webview thread returns immediately.
         */
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
        /*
         * 初始几何恢复由下面的 setup 显式驱动（window::lifecycle），插件不做。
         *
         * 插件默认在 on_window_ready 里 restore_state，那已经晚于窗口按
         * center: true 创建并显示的时刻，于是每次启动都能看见窗口从屏幕中央被磁盘
         * 上的坐标挪走。窗口现在以 visible: false 创建，恢复完位置和尺寸才呈现:
         * 一次定位，一次呈现。
         */
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
            /*
             * 库在窗口出现之前打开，迁移在这里跑完。
             *
             * 它不再是某个子系统的私产：工作台开着哪几格与对话索引同库，而
             * 渲染层在挂载 React 之前就要读它一次 —— 每一次启动都要读。所以
             * 「没打开助手的那一次启动不该为迁移付钱」这条旧理由不再成立，
             * 而放在这里的收益是确定的：前端那一次等待只是一条 SELECT，不是
             * 一次时长不可预测的迁移。
             */
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
            let runtime = crate::conversation::runtime::compose(
                handle, handle.path().home_dir()?, paths::attachments_root(handle)?,
                index.clone(), journal,
            );
            let _index = app.manage(index.clone());
            let _managed = app.manage(std::sync::Arc::clone(&runtime));
            let _browser = app.manage(crate::webview::BrowserHost::new());
            let _automation_mcp = app.manage(crate::automation::mcp_server::serve(handle)?);
            let automation = crate::automation::start(handle, index.clone(), runtime);
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
