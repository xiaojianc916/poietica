//! 一条对话此刻持有哪个会话。
//!
//! 库里存的号可能是上一次运行留下的，而册子随连接生灭。这里把「对话」翻成
//! 「本次连接认得的会话」，认不出就装载回来或重开。

use crate::error::{Error, Result};
use crate::local_index::{LocalIndex, conversation, on_index, persistence};
use poietica_agent_runtime_native::ConfigControl;
use std::path::PathBuf;
use tauri::State;
use uuid::Uuid;

use super::NO_SUCH_CONVERSATION;
use super::dto::{AgentHistory, AgentHistoryLoss};
use super::failure::translate;
use super::runtime::{AgentRuntime, Handle};

/// 一条对话所持有的活会话。
pub(super) struct Held {
    pub(super) thread_id: Uuid,
    pub(super) session_id: String,
    /// 只有刚开出来的会话有：agent 在同一个答复里报了它。
    pub(super) offered: Option<Vec<ConfigControl>>,
    /// agent 那侧的上下文这一次恢复成了什么样。屏幕上那条经过与它无关 ——
    /// 那一份由本机日志重放（见 run_events.rs）。
    pub(super) history: AgentHistory,
}

/// 这条对话所持有的、本次连接认得的会话。
///
/// 整个模块只有这一条寻址规则，没有兜底。对话持有会话，`attach_session` 是写下
/// 来的地方——但写下来的号要先装回本次连接才认得：册子随连接生灭，而 kap 的
/// 会话在 server 侧持久。此前这个号被当成持久主键直接用于寻址，于是
/// 一条上次运行留下的对话，它的选择器和它的每一轮提问都发往一个早已不存在的
/// 会话：前者是屏幕上那句"会话设置读取失败"，后者是一轮永远不会开始的回答。
///
/// 认不得的那一个不是废号，是一条还在 server 侧的会话：装载就是把它重新订阅
/// 回来（driver 的 load_kap_session），号不变，历史因此还在 agent 手里。此前
/// 这里直接重开一条空会话并用它覆盖掉旧号 —— 屏幕上的历史来自本地日志，所以
/// 看起来一切正常，而 agent 手里什么都没有；被覆盖掉的那个号从此也再找不回来。
///
/// 只有装载失败（号在 server 侧也不在了），才开一条新的。那一刻旧号确实
/// 不再指向任何东西，所以这不是兜底，是另一种事实。
///
/// 两条会话路径都由 agent 在同一个答复里报回整张选择器表，所以第三个字段只在
/// 「这次真的开或装载了一条」时有值：这不是缓存，是省掉一次多余的往返。
///
/// 号本身还要认人。sessionId 活在 agent 自己的命名空间里，B 不认识 A 开的
/// 号：换一个 agent 再点开旧对话，发出去的是一个对面从没见过的名字，回来的
/// 是 UnknownSession。所以持有者跟着号一起存，对不上就根本不装载，这条对话
/// 在新 agent 这里从一条空会话开始。
///
/// 那一刻屏幕上仍是本机日志重放出来的那一份，而 agent 手里没有上下文：它接
/// 不下去。接不下去本身不是问题，不作声才是 —— 所以每一条返回路径都带一个
/// `history`，说清这一次是"刚建"、"本来就在"，还是"打不开，以及为什么"。
///
/// 会话的工作目录由这条对话自己那一行说了算（threads.workspace_root）。
/// 空的才回落到平台给的那个 home —— 那是早于这一列写下的行，那时候只有一个工
/// 作目录，所以回落是一条事实，不是兜底。取进程的当前目录回答的是另一个问题：
/// 开发运行时它是 Rust 的构建目录。
pub(super) async fn session_for(
    state: &State<'_, AgentRuntime>,
    index: &State<'_, LocalIndex>,
    live: &Handle,
    named: &str,
) -> Result<Held> {
    let thread_id = conversation(named)?;

    let stored = on_index(index, move |store| {
        store.thread(thread_id).map_err(persistence)
    })
    .await?;

    /* 「这条对话不存在」与「它还没有会话」是两个答案：折成一个，前者会一路
    走到 record_prompt 的 RETURNING 上，以一句「文件操作失败」收场。 */
    let Some(thread) = stored else {
        return Err(Error::NotFound(NO_SUCH_CONVERSATION.to_owned()));
    };

    let (session_id, owner, recorded) = (thread.session_id, thread.agent_id, thread.workspace_root);

    /* 目录是对话的属性，不是这一刻的选择：从项目 A 的一条旧对话里说话，不该
    跑到项目 B 的目录里去。此前这两处都写死 state.root，也就是家目录 —— 于是
    人选的那个工作目录只影响起进程那一次，agent 实际在哪里读写与它无关。 */
    let workspace = match recorded {
        Some(path) => PathBuf::from(path),
        None => state.root.clone(),
    };

    /* 空的持有者是这一列存在之前写下的行：那时候只装得下一个 agent，所以按
    本次这个算，装载成功时在下面记实。 */
    let mine = owner.as_deref().is_none_or(|id| id == live.agent_id);

    /* 走到下面新开一条时，这里说得出刚才为什么没能装载回来。 */
    let mut lost: Option<AgentHistory> = None;

    /* 旧号先抄一份。往下若真的换了号，库里这一行一改指新号，旧号就再没有
    任何人引用 —— 而它在 agent 的存档里还占着一整条会话。号与主人成对由库上
    的 threads_session_needs_owner 保着，所以 zip 折不掉一笔真实的账。 */
    let previous_session = session_id.clone().zip(owner.clone());

    if let Some(session_id) = session_id {
        /* 这个号本次连接认不认得。认得的是活地址；认不得的那一个还在 agent
        的存档里，得请它装载回来。判一次，下面三条路都照它走。 */
        let known = live.book.slot(&session_id).map_err(translate)?.is_some();

        if !mine {
            /* 号发出去只会换回 UnknownSession，所以不发。 */
            lost = Some(AgentHistory::Unavailable {
                reason: AgentHistoryLoss::OtherAgent,
                owner,
            });
        } else if known {
            /* 活地址就是它，不必惊动 agent：上下文已经在它手里，经过在本机
            日志里。 */
            return Ok(Held {
                thread_id,
                session_id,
                offered: None,
                history: AgentHistory::Live,
            });
        } else if let Some(loading) = live.loading {
            /* 上次运行留下的。号不变，让 agent 把它装载回来。 */
            match live.client.load_session(loading, session_id.clone()).await {
                Ok(loaded) => {
                    /* 序号线接上日志。号没变，日志里那些位置照样占着，而这条
                    会话的槽是本次连接新建的、从 1 开始 —— 不接上去，下一轮的
                    帧会撞上旧位置，被 run_events 的唯一键静默丢掉。 */
                    let resumed = session_id.clone();
                    let last_seq = on_index(index, move |store| {
                        store.last_seq(thread_id, &resumed).map_err(persistence)
                    })
                    .await?;

                    if let Some(slot) = live.book.slot(&session_id).map_err(translate)? {
                        slot.seq().resume(last_seq);
                    }

                    /* 装载成功，这条会话确实是这个 agent 的。空的那一格在这里
                    记实，所以补写只发生一次，不是每次开对话都写一遍。 */
                    {
                        // 交给线程池的活得自己拥有它读的东西：号下面还要用，
                        // 而 agent_id 借的是调用者的 Handle。
                        let attached = session_id.clone();
                        let owner = live.agent_id.clone();

                        on_index(index, move |store| {
                            store
                                .attach_session(thread_id, &attached, &owner)
                                .map_err(persistence)
                        })
                        .await?;
                    }

                    return Ok(Held {
                        thread_id,
                        session_id,
                        offered: Some(loaded.selectors),
                        history: AgentHistory::Loaded,
                    });
                }
                /* agent 自己也不再留着这条会话了。往下仍然开一条新的，但这一次
                不装作无事发生：拿不到就是拿不到，说出来。 */
                Err(error) => {
                    log::warn!("could not reload the stored session: {error}");

                    lost = Some(AgentHistory::Unavailable {
                        reason: AgentHistoryLoss::Forgotten,
                        owner,
                    });
                }
            }
        } else {
            /* 它握手时就说了它不装载旧会话。 */
            lost = Some(AgentHistory::Unavailable {
                reason: AgentHistoryLoss::NotSupported,
                owner,
            });
        }
    }

    let opened = live
        .client
        .new_session(workspace)
        .await
        .map_err(translate)?;

    {
        let attached = opened.session_id.clone();
        let owner = live.agent_id.clone();

        on_index(index, move |store| {
            store
                .attach_session(thread_id, &attached, &owner)
                .map_err(persistence)
        })
        .await?;
    }

    /* 同样不补记：驱动器开完会话先 ledger.open，才把号交出来。 */

    /* 换了号，旧号的账在这里清。判据是 lost：只有装载失败与不支持装载那几
    条路走到这里时它才有值，而那时库里这一行已经改指新号，旧号从此没有任何
    人引用。主人对得上、能力也在，就当场送达；其余情形（别人的号、没有能
    力、送达被拒）进处置账，由下一次对上那个 agent 的连接冲销（runtime.rs
    的 record_and_flush_disposals）。记账失败只写日志：打开对话是人此刻要
    的事，一笔没记上的账最坏的结果是一个目录多活到手动清理。 */
    if let Some((stale_id, stale_owner)) = previous_session
        && lost.is_some()
    {
        let owed = if stale_owner == live.agent_id
            && let Some(deleting) = live.deleting
        {
            match live.client.delete_session(deleting, stale_id.clone()).await {
                Ok(()) => None,
                Err(error) => {
                    log::warn!("could not delete the replaced session: {error}");

                    Some((stale_id, stale_owner))
                }
            }
        } else {
            Some((stale_id, stale_owner))
        };

        if let Some((debtor, holder)) = owed {
            let recorded = on_index(index, move |store| {
                store
                    .record_session_disposal(&debtor, &holder)
                    .map_err(persistence)
            })
            .await;

            if let Err(error) = recorded {
                log::warn!("could not record the replaced session for disposal: {error}");
            }
        }
    }

    Ok(Held {
        thread_id,
        session_id: opened.session_id,
        offered: Some(opened.selectors),
        history: lost.unwrap_or(AgentHistory::Fresh),
    })
}
