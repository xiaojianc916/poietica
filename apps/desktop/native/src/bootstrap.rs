//! 原生侧的启动：把 crate 接成进程里的一份状态。
//!
//! Tauri 时代这段住在 composition.rs 的 setup 闭包里 —— 那段代码同时在建窗、注册
//! 命令、装插件，没法单测。Electron 时代建窗归 TypeScript 主进程，这里只剩「开库、
//! 起调度、装退出屏障」，于是它可以是一个普通函数。
//!
//! 顺序即不变量：账本先于一切（设置服务与工作区对账都要它），退出屏障最后
//! （它引用的东西必须先存在）。
//!
//! 这一段跑在**阻塞线程**上（开库会阻塞），所以它要 spawn 的东西必须显式用调用方交进来
//! 的 Handle —— 阻塞线程上没有「当前 runtime」可问。

use std::sync::Arc;

use crate::error::Result;

pub(crate) fn install(
    paths: crate::paths::HostPaths,
    handle: &tokio::runtime::Handle,
) -> Result<()> {
    crate::paths::install_host_facts(paths)?;

    let opened = crate::ledger::LocalIndex::open(
        &crate::paths::ledger_database()?,
        poietica_time::wall_clock::SystemWallClock,
    )?;
    let index = Arc::new(opened);
    // journal 只负责落盘；屏幕经过走 transcript，不发第二套对话正文。
    let journal =
        poietica_conversation_runtime::journal::FrameJournal::new((*index).clone(), |_, _| {})?;

    let runtime = crate::conversation::composition::compose(
        crate::paths::projectless_root()?,
        crate::paths::attachments_root()?,
        (*index).clone(),
        journal,
    );

    let settings = Arc::new(crate::settings::SettingsService::new(
        crate::settings::FileSettingsRepository::new(crate::paths::settings_store()?),
        {
            let runtime = Arc::clone(&runtime);
            move |intent| {
                let runtime = Arc::clone(&runtime);
                async move {
                    runtime
                        .apply_daemon_intent(intent)
                        .await
                        .map_err(poietica_problem::Problem::from)
                }
            }
        },
    ));

    crate::ledger::open_index(Arc::clone(&index))?;
    crate::conversation::open_runtime(runtime)?;
    crate::settings::open_settings(Arc::clone(&settings))?;

    // 调度器与它的 MCP 面：两者互指，所以先起 MCP 再把它交给调度器。
    let mcp = Arc::new(crate::automation::mcp_server::serve()?);
    crate::automation::open_mcp(Arc::clone(&mcp))?;
    let automation = Arc::new(crate::automation::host::start(
        (*index).clone(),
        crate::conversation::runtime()?,
    ));
    crate::automation::open_automation(Arc::clone(&automation))?;

    // 退出屏障引用上面每一个，所以放最后；它自己去 host 里取。
    // 上回留下的无主工作区与暂存目录：清账归这一趟，清字节归 workspace::reconcile。
    let reclaim = automation.available().is_ok();
    handle.spawn(async move {
        if !reclaim {
            log::warn!(
                "workspace reclamation skipped because automation ownership could not be initialized"
            );
            return;
        }

        match crate::workspace::reconcile::run((*index).clone(), uuid::Uuid::now_v7()).await {
            Ok(()) => {}
            Err(error) => log::warn!("could not reconcile leftover conversation state: {error}"),
        }
    });

    // 设置里那些要落到活会话上的项：读失败不拦启动，退回默认值。
    handle.spawn(async move {
        if let Err(problem) = settings.apply_startup().await {
            log::warn!("could not apply persisted runtime settings: {problem:?}");
        }
    });

    Ok(())
}
