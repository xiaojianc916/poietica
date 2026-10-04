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

    // 日志先于一切：从这里往下每一步都可能报错，而报错的第一现场必须留得下来。
    //
    // 级别那一格此刻还没有设置服务可问（它建在下面），所以直接读那一份文档 ——
    // 读不到就是默认 warn，与「文件还没写出来」是同一件事。
    let level = crate::settings::read_log_level(&crate::paths::settings_store()?);

    if let Err(error) = crate::log_file::install(&crate::paths::log_directory()?, &level) {
        #[allow(
            clippy::print_stderr,
            reason = "日志装不上时它自己还没有出口，stderr 是唯一还剩的那一个"
        )]
        {
            eprintln!("poietica: application log could not be opened: {error}");
        }
    }

    let opened = crate::ledger::LocalIndex::open(
        &crate::paths::ledger_database()?,
        poietica_time::wall_clock::SystemWallClock,
    )?;
    let index = Arc::new(opened);
    /*
     * journal 落盘，并把**本机判定、屏幕必须知道**的那几条顺路送出去。
     *
     * 屏幕经过照旧走 transcript，不发第二套对话正文 —— 但有一类事实不是正文，
     * 而且只有我们知道：『这一轮因为连接断了而终止』。它由 `book.fail_active` 判定，
     * 落进账本的是 `RunFailed`。从前这里是一个空回调（`|_, _| {}`），于是那句话只进
     * 账本、不回屏幕；而屏幕上的轮终只认 agent 的 transcript —— agent 都死了，
     * 那条通道再也不会有帧，那一轮就永远转下去（没有错误、没有发送键、只能重启）。
     *
     * 只挑 `RunFailed` 转出去：其余本机帧（准入、审批、提问、链路、终帧）要么已经由
     * 别的通道送到屏幕，要么是正文的一部分、由 transcript 负责。
     */
    let journal = poietica_conversation_runtime::journal::FrameJournal::new(
        (*index).clone(),
        |session_id, envelopes| {
            for envelope in envelopes {
                let poietica_conversation::event::ConversationEvent::RunFailed {
                    message,
                    degraded,
                    ..
                } = &envelope.event
                else {
                    continue;
                };

                match serde_json::to_value(crate::conversation::dto::AgentSessionEvent::RunFailed {
                    session_id: session_id.clone(),
                    message: message.clone(),
                    degraded: *degraded,
                }) {
                    Ok(payload) => crate::transport::emit("agent_session_event", &payload),
                    Err(error) => {
                        tracing::warn!("could not encode a local run failure: {error}");
                    }
                }
            }
        },
    )?;

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
            tracing::warn!(
                "workspace reclamation skipped because automation ownership could not be initialized"
            );
            return;
        }

        match crate::workspace::reconcile::run((*index).clone(), uuid::Uuid::now_v7()).await {
            Ok(()) => {}
            Err(error) => tracing::warn!("could not reconcile leftover conversation state: {error}"),
        }
    });

    // 设置里那些要落到活会话上的项：读失败不拦启动，退回默认值。
    handle.spawn(async move {
        if let Err(problem) = settings.apply_startup().await {
            tracing::warn!("could not apply persisted runtime settings: {problem:?}");
        }
    });

    Ok(())
}
