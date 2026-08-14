//! 一条对话此刻持有哪个会话。
//!
//! ACP 的 sessionId 只在一条连接内有意义，库里存的号可能是上一次运行留下的。这里
//! 把「对话」翻成「本次连接认得的会话」，认不出就重开或装载。

use crate::error::Result;
use crate::local_index::{LocalIndex, conversation, on_index, persistence};
use poietica_agent_runtime_native::ConfigControl;
use serde_json::Value;
use std::path::PathBuf;
use tauri::State;
use uuid::Uuid;

use super::dto::{AgentHistory, AgentHistoryLoss};
use super::failure::translate;
use super::runtime::{AgentRuntime, Handle};

/// 这一次寻址，要的是什么。
///
/// 两个问题此前挤在一个函数里：「这条对话该发往哪个会话」每一轮提问都要问,
/// 「把它的经过取回来」只有打开的时候才要。挤在一起就只能二选一 —— 为了不让
/// 每一轮提问都付一次重放的代价，打开时也就拿不到经过，于是原生侧改去猜屏幕
/// 上还有没有东西。分开问，两边都对，也没什么可猜的了。
#[derive(Clone, Copy, Debug)]
pub(super) enum Wanted {
    /// 只要一个能把东西发过去的会话号。
    Address,
    /// 还要这条对话的经过：屏幕上现在什么都没有。
    History,
}

/// 一条对话所持有的活会话，以及装载它时 agent 交回来的东西。
pub(super) struct Held {
    pub(super) thread_id: Uuid,
    pub(super) session_id: String,
    /// 只有刚开出来的会话有：agent 在同一个答复里报了它。
    pub(super) offered: Option<Vec<ConfigControl>>,
    /// 装载一条旧会话时，agent 用 session/update 重放的那一整段。
    ///
    /// 与上面那格同一条规矩：只有真的开或装载了一条，才有东西可带。只要地址
    /// 的那一路这里是空的 —— 它压根没问。
    pub(super) events: Vec<Value>,
    /// 上面那格为什么是它现在的样子。
    pub(super) history: AgentHistory,
}

/// 这条对话所持有的、本次连接认得的会话。
///
/// 整个模块只有这一条寻址规则，没有兜底。对话持有会话，`attach_session` 是写下
/// 来的地方——但写下来的那一个只在开它的那条连接里有意义：ACP 的会话号随连接
/// 生灭，进程重启之后 agent 不认识它。此前它被当成持久主键直接用于寻址，于是
/// 一条上次运行留下的对话，它的选择器和它的每一轮提问都发往一个早已不存在的
/// 会话：前者是屏幕上那句"会话设置读取失败"，后者是一轮永远不会开始的回答。
///
/// 认不得的那一个不是废号，是一条还在 agent 那侧的会话。ACP 为它准备了
/// `session/load`：号原样交回去，agent 把它重新装载起来，历史因此还在。此前
/// 这里直接重开一条空会话并用它覆盖掉旧号 —— 屏幕上的历史来自本地日志，所以
/// 看起来一切正常，而 agent 手里什么都没有；被覆盖掉的那个号从此也再找不回来。
///
/// 只有 agent 自己在握手时说了它不装载旧会话，才开一条新的。那一刻旧号确实
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
/// 这一刻屏幕上是空的，而且只能是空的：那段历史在原来那个 agent 手里，这一侧
/// 没有副本可拿。空本身不是问题，不作声才是 —— 所以每一条返回路径都带一个
/// `history`，说清这一次的空是"刚建"、"本来就在"，还是"打不开，以及为什么"。
///
/// 会话的工作目录由这条对话自己那一行说了算（迁移 0013 的 workspace_root）。
/// 空的才回落到平台给的那个 home —— 那是迁移之前写下的行，那时候只有一个工作
/// 目录，所以回落是一条事实，不是兜底。取进程的当前目录回答的是另一个问题：
/// 开发运行时它是 Rust 的构建目录。
/* 名册按值收下：只有走到最下面新开一条会话那一路才用得到它。装载回来的那条
会话不该重挂 —— session/load 恢复的是它原来那一条，连同它原来那几台。 */
pub(super) async fn session_for(
    state: &State<'_, AgentRuntime>,
    index: &State<'_, LocalIndex>,
    live: &Handle,
    named: &str,
    wanted: Wanted,
    mcp: Vec<Value>,
) -> Result<Held> {
    let thread_id = conversation(named)?;

    let stored = on_index(index, move |store| {
        store.thread(thread_id).map_err(persistence)
    })
    .await?;

    /* 号和持有者分开拿。此前它们被 and_then + filter 折成一个 Option，于是
    "这条对话属于别的 agent"与"这条对话还没有会话"在类型上不可分辨 —— 那正是
    这一路说不出话的原因：折叠丢掉的不是数据，是问句的答案。 */
    let (session_id, owner, recorded) = match stored {
        Some(thread) => (thread.session_id, thread.agent_id, thread.workspace_root),
        None => (None, None, None),
    };

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
    任何人引用 —— 而它在 agent 的存档里还占着一整条会话。号与主人成对（迁
    移 0012 的触发器），所以 zip 折不掉一笔真实的账。 */
    let previous_session = session_id.clone().zip(owner.clone());

    if let Some(session_id) = session_id {
        /* 本次连接开出来的号，agent 此刻就认得它。
        它认得，不等于屏幕上还有东西：渲染层可以在连接活着的时候整个重来
        （Ctrl+R、第二个窗口），那一刻它手里一片空白。「有没有经过可看」是
        那一侧的事实，这一侧猜不出来，所以不猜 —— 要经过的那一路照样去装载。 */
        let known = live.book.slot(&session_id).map_err(translate)?.is_some();

        if !mine {
            /* 号发出去只会换回 UnknownSession，所以不发。 */
            lost = Some(AgentHistory::Unavailable {
                reason: AgentHistoryLoss::OtherAgent,
                owner,
            });
        } else if known && matches!(wanted, Wanted::Address) {
            /* 只要一个地址，那就是它，不必惊动 agent。 */
            return Ok(Held {
                thread_id,
                session_id,
                offered: None,
                events: Vec::new(),
                history: AgentHistory::Live,
            });
        } else if let Some(loading) = live.loading {
            /* 上次运行留下的。号不变，让 agent 把它装载回来。 */
            match live
                .client
                .load_session(loading, session_id.clone(), workspace.clone())
                .await
            {
                Ok(loaded) => {
                    /* 不补记：驱动器在发出装载请求之前就 ledger.open 了这条会话，
                    否则重放期到达的帧没有去处（driver.rs 的 load_session）。 */

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
                        events: loaded.events,
                        offered: Some(loaded.selectors),
                        history: AgentHistory::Loaded,
                    });
                }
                /* agent 自己也不再留着这条会话了。往下仍然开一条新的，但这一次
                不装作无事发生：拿不到就是拿不到，说出来。 */
                Err(error) => {
                    log::warn!("could not reload the stored session: {error}");

                    /* 号还活着，只是这一次没能把它重放出来。绝不能顺势重开一
                    条：那会把一条正在用的会话丢掉，而人可能还在里面说话。 */
                    if known {
                        return Ok(Held {
                            thread_id,
                            session_id,
                            offered: None,
                            events: Vec::new(),
                            history: AgentHistory::Unavailable {
                                reason: AgentHistoryLoss::Forgotten,
                                owner,
                            },
                        });
                    }

                    lost = Some(AgentHistory::Unavailable {
                        reason: AgentHistoryLoss::Forgotten,
                        owner,
                    });
                }
            }
        } else if known {
            /* 它不装载旧会话，可这一条本来就还在这条连接上：经过取不回来，会话
            得留着。重开一条只会把它也赔进去。 */
            return Ok(Held {
                thread_id,
                session_id,
                offered: None,
                events: Vec::new(),
                history: AgentHistory::Unavailable {
                    reason: AgentHistoryLoss::NotSupported,
                    owner,
                },
            });
        } else {
            /* 它握手时就说了它不做这件事。 */
            lost = Some(AgentHistory::Unavailable {
                reason: AgentHistoryLoss::NotSupported,
                owner,
            });
        }
    }

    let opened = live
        .client
        .new_session(workspace, mcp)
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
        events: Vec::new(),
        history: lost.unwrap_or(AgentHistory::Fresh),
    })
}
