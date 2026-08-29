use tauri::{Manager, Wry, async_runtime};
use tauri_plugin_store::StoreExt;
use tauri_plugin_window_state::{StateFlags, WindowExt};

use super::{logging, tray};
use crate::asset_protocol::{ASSET_PROTOCOL_SCHEME, AssetProtocolRegistry};
use crate::commands;
use crate::paths;

/// Label of the only window this application declares. Matches tauri.conf.json.
pub const MAIN_WINDOW: &str = "main";

/// 被持久化、也被恢复的那一份窗口几何。
///
/// 保存与恢复必须用同一个集合，否则磁盘上会留下没人读的字段，或者读到没人写的
/// 字段。这个常量是唯一的声明处：托盘与窗口命令都消费它，不再各写一遍 `all()`。
///
/// 刻意不含 VISIBLE：可见性归托盘状态机。隐藏到托盘时存下的 visible: false 若被
/// 当成恢复目标，下一次启动窗口就打不开了。
///
/// 刻意不含 DECORATIONS：边框归 tauri.conf.json（decorations: false + 自绘标题
/// 栏）。让磁盘上的旧值有机会把原生边框装回来，收益为零。
pub const WINDOW_STATE_FLAGS: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED)
    .union(StateFlags::FULLSCREEN);

/// 渲染层没能呈现时的兜底期限。
const PRESENT_WATCHDOG: std::time::Duration = std::time::Duration::from_secs(8);

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
                    responder.respond(registry.response(&request));
                });
            },
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        /*
         * 初始几何恢复由下面的 setup 显式驱动，插件不做。
         *
         * 插件默认在 on_window_ready 里 restore_state，那已经晚于窗口按
         * center: true 创建并显示的时刻，于是每次启动都能看见窗口从屏幕中央被磁盘
         * 上的坐标挪走。窗口现在以 visible: false 创建，恢复完位置和尺寸才呈现:
         * 一次定位，一次呈现。
         *
         * 首次启动没有状态文件，恢复是空操作，此时生效的正是 center: true。
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

            handle.plugin(logging::plugin(paths::log_directory(handle)?).build())?;

            /* 生成的事件面挂一次；命令面走 invoke_handler，两者同源。 */
            ipc.mount_events(app);

            app.store(paths::settings_store(handle)?)?;
            app.store(paths::agents_store(handle)?)?;
            app.store(paths::automations_store(handle)?)?;

            /*
             * 自动化的表在这里起，进程级：闹钟不该活在会被隐藏、会被整页重载的那
             * 一侧。谁创建谁负责 —— 这里创建，随进程结束。
             */
            commands::automations::watch(handle);
            crate::mcp::serve(handle)?;

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
            let _index = app.manage(crate::local_index::LocalIndex::open(
                &database,
                &poietica_time::wall_clock::SystemWallClock,
            )?);
            let _managed = app.manage(commands::agent::runtime::AgentRuntime::new(app.handle())?);

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

                    let index = sweeper.state::<crate::local_index::LocalIndex>();

                    crate::local_index::on_index(&index, move |store| {
                        let harvested = store
                            .harvest_ghost_threads(boundary)
                            .map_err(crate::local_index::persistence)?;

                        if snapshot.is_empty() {
                            return Ok((harvested, 0));
                        }

                        let referenced = store
                            .workspace_roots()
                            .map_err(crate::local_index::persistence)?;

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
            let _browser = app.manage(crate::browser::BrowserHost::new());
            crate::diagnostics::install(app.handle())?;
            tray::install(app.handle())?;

            /*
             * 承接 skip_initial_state：初始几何恢复的责任在这里，不在插件。
             *
             * 窗口此刻还不可见（tauri.conf.json 的 visible: false），所以恢复位置和
             * 尺寸不会被看到，用户第一次看见它时它已经在正确的地方。restore_state
             * 期间插件持有恢复锁，其间产生的 Moved / Resized 不会被当成用户操作写
             * 回缓存 —— 这也是宁可调插件自己的恢复、而不是手写 set_position 的原因。
             *
             * 首次启动没有状态文件，恢复是空操作，此时生效的正是 center: true。
             */
            let main_window = app
                .get_webview_window(MAIN_WINDOW)
                .ok_or("tauri.conf.json 未声明 main 窗口")?;

            main_window.restore_state(WINDOW_STATE_FLAGS)?;
            constrain_to_visible_area(&main_window);

            /* 最大化态由窗口自己播报，渲染层不轮询。 */
            commands::window::watch_maximized(&main_window);

            /*
             * 呈现权归渲染层：窗口在 React 首帧提交后由前端 present()。这里是唯一兜底 ——
             * webview 若根本没跑起来（脚本 404、CSP 拦截、渲染进程启动失败），没有它窗口
             * 会永远不可见，进程只存在于任务管理器里。
             */
            let watchdog = main_window.clone();

            async_runtime::spawn(async move {
                tokio::time::sleep(PRESENT_WATCHDOG).await;

                if watchdog.is_visible().unwrap_or(false) {
                    return;
                }

                log::warn!("frontend did not present within {PRESENT_WATCHDOG:?}; showing the window anyway");

                commands::window::activate(&watchdog);
            });

            log::info!(
                "native setup finished {} ms after build start",
                started.elapsed().as_millis()
            );

            Ok(())
        })
}

/// 把窗口约束回它所在显示器的可视范围内。
///
/// 几何有两个来源。磁盘上的状态文件由 window-state 插件负责，它自己会把恢复出
/// 的位置约束回显示器，那条路径是安全的。没有被任何人检查过的是另一条：
/// tauri.conf.json 里的默认值。1400x900 在一台 1366x768 的笔记本上放不下，而
/// 居中会把它摆在 y = -86，标题栏落到工作区上方 —— 窗口是 decorations: false，
/// 没有原生系统菜单可以用键盘把它拖回来，于是首次启动就是一个拖不动的窗口。
///
/// 这里只做约束，不做决定：几何本来就成立时它是空操作。最大化与全屏跳过，
/// 那两种状态下的尺寸本来就等于显示器。
fn constrain_to_visible_area(window: &tauri::WebviewWindow) {
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return;
    }

    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };

    let monitor_size = *monitor.size();
    let monitor_position = *monitor.position();

    /*
     * 95% 是任务栏的替代品，不是它的测量值。work_area 的语义各平台不一致，而
     * 这里要的只是"别铺满整块屏、别顶到边缘之外"，不需要像素级贴合。
     */
    let max_width = monitor_size.width.saturating_mul(95) / 100;
    let max_height = monitor_size.height.saturating_mul(95) / 100;

    let Ok(size) = window.outer_size() else {
        return;
    };

    let width = size.width.min(max_width);
    let height = size.height.min(max_height);

    if (width, height) != (size.width, size.height)
        && let Err(error) = window.set_size(tauri::PhysicalSize::new(width, height))
    {
        log::warn!("could not clamp the window to its monitor: {error}");
        return;
    }

    let Ok(position) = window.outer_position() else {
        return;
    };

    let monitor_left = i64::from(monitor_position.x);
    let monitor_top = i64::from(monitor_position.y);
    let monitor_right = monitor_left + i64::from(monitor_size.width);
    let monitor_bottom = monitor_top + i64::from(monitor_size.height);

    let left = i64::from(position.x);
    let top = i64::from(position.y);

    let fits = left >= monitor_left
        && top >= monitor_top
        && left + i64::from(width) <= monitor_right
        && top + i64::from(height) <= monitor_bottom;

    if fits {
        return;
    }

    if let Err(error) = window.center() {
        log::warn!("could not recentre the window on its monitor: {error}");
    }
}
