//! 唯一装配点：把 crate 与插件接成一个进程。这里只做接线，不裁决。

use tauri::{Manager, Wry, async_runtime};
use tauri_plugin_store::StoreExt;

use crate::asset_protocol::{ASSET_PROTOCOL_SCHEME, AssetProtocolRegistry};
use crate::diagnostics::structured_log;
use crate::ipc::commands;
use crate::paths;
use crate::window::{MAIN_WINDOW, WINDOW_STATE_FLAGS, tray};

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
        /* 暂存态归进程：谁创建谁负责，命令只借用，不摸全局静态。 */
        .manage(commands::updates::UpdateStaging::default())
        .invoke_handler(ipc.invoke_handler())
        .setup(move |app| {
            /* 日志比其余一切都早：出事时它是唯一的目击者，它只需要落点先算出来。 */
            let handle = app.handle();

            handle.plugin(structured_log::plugin(paths::log_directory(handle)?).build())?;

            /* 生成的事件面挂一次；命令面走 invoke_handler，两者同源。 */
            ipc.mount_events(app);

            app.store(paths::settings_store(handle)?)?;
            app.store(paths::agents_store(handle)?)?;
            app.store(paths::automations_store(handle)?)?;

            /*
             * 自动化的表在这里起，进程级：闹钟不该活在会被隐藏、会被整页重载的那
             * 一侧。谁创建谁负责 —— 这里创建，随进程结束。
             */
            commands::automation::watch(handle);
            commands::automation::mcp_server::serve(handle)?;

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
            let _index = app.manage(commands::ledger::local_index::LocalIndex::open(
                &database,
                poietica_time::wall_clock::SystemWallClock,
            )?);
            let _managed =
                app.manage(commands::conversation::runtime::AgentRuntime::new(app.handle())?);

            /*
             * 启动杂务，一条路径：抹 tmp、备好 cache、清换装残留、拍无主目录快照、收幽灵行、回收无主目录。
             * 顺序即不变量：快照先于名单、收割先于名单，否则幽灵行占着的目录要等下一次启动。
             * 边界在此签发 —— 库已开、webview 还没执行脚本，它晚于每条遗留行、早于用户开出的第一条。
             * 抹 tmp 也在这里：命令要等事件循环，而事件循环在 setup 返回之后才转。
             */
            let boundary = uuid::Uuid::now_v7();
            let sweeper = handle.clone();

            async_runtime::spawn(async move {
                let snapshotted = sweeper.clone();

                let outcome = async {
                    let snapshot = async_runtime::spawn_blocking(move || {
                        paths::reset_temp_directory(&snapshotted)?;
                        paths::cache_directory(&snapshotted)?;
                        commands::updates::sweep_binaries();

                        paths::projectless_workspaces(&snapshotted)
                    })
                    .await
                    .map_err(|_dropped| {
                        crate::error::Error::Internal(
                            "the start-up housekeeping did not finish".to_owned(),
                        )
                    })??;

                    let index = sweeper.state::<commands::ledger::local_index::LocalIndex>();

                    commands::ledger::local_index::on_index(&index, move |store| {
                        let harvested = store
                            .harvest_ghost_threads(boundary)
                            .map_err(commands::ledger::local_index::persistence)?;

                        if snapshot.is_empty() {
                            return Ok((harvested, 0));
                        }

                        let referenced = store
                            .workspace_roots()
                            .map_err(commands::ledger::local_index::persistence)?;

                        Ok((
                            harvested,
                            paths::sweep_projectless_workspaces(snapshot, &referenced),
                        ))
                    })
                    .await
                }
                .await;

                match outcome {
                    Ok((0, 0)) => {}
                    Ok((harvested, swept)) => {
                        log::info!(
                            "start-up reconciliation: harvested {harvested} ghost conversations, reclaimed {swept} projectless directories"
                        );
                    }
                    Err(error) => {
                        log::warn!("could not reconcile leftover conversation state: {error}");
                    }
                }
            });

            /*
             * 内置浏览器的标签宿主，进程级。new() 顺手抽好 CDP 端口；webview
             * 仍是懒创建的 —— 第一次导航或会话预热才碰内核。
             */
            let _browser = app.manage(crate::webview::BrowserHost::new());
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
