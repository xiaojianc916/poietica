//! 断线重连：有界重试 + 指数退避，判据与退避在 link.rs。

use std::collections::HashMap;

use futures::StreamExt;
use futures::channel::mpsc;
use futures::stream::SplitStream;
use serde_json::Value;

use crate::connection::handshake::{shake_hands, subscribe, wait_subscribe_ack};
use crate::connection::socket::{WsSink, WsStream, dial_ws};
use crate::error::Result;
use crate::link::{RELINK_TRIES, backoff, recovered, retrying, severed};
use crate::session::Cursor;
use crate::session::SessionEvent;
use crate::session::book::SessionBook;

/// 一次重连接回来的东西：补投的帧，以及 server 不再认的那几条会话。
pub(crate) struct Relinked {
    pub(crate) stash: Vec<Value>,
    pub(crate) refused: Vec<String>,
}

/// 一次重连：拨、握手、把册子上每条会话按它读到的位置挂回去。
///
/// 单条会话没订上不是链路的事（归档、换纪元、server 侧已不在）：它进 refused，
/// 链路照活；传输错才向上报。
async fn redial(
    ws: &WsSink,
    ws_rx: &mut SplitStream<WsStream>,
    ws_url: &str,
    auth: &reqwest::header::HeaderValue,
    book: &SessionBook,
    cursors: &HashMap<String, Cursor>,
) -> Result<Relinked> {
    let (sink, rx) = dial_ws(ws_url, auth).await?.split();

    /* 写端在锁后面，换的是锁里那一个：已经拿着 Arc 的那些任务不必知道链路换过。 */
    *ws.lock().await = sink;
    *ws_rx = rx;

    let mut stash: Vec<Value> = Vec::new();

    shake_hands(ws, ws_rx, &mut stash).await?;

    let mut refused: Vec<String> = Vec::new();

    for session_id in book.ids()? {
        let again = subscribe(ws, &session_id, cursors.get(&session_id)).await?;

        if !wait_subscribe_ack(ws_rx, &again, &session_id, &mut stash).await? {
            refused.push(session_id);
        }
    }

    Ok(Relinked { stash, refused })
}

/// 把断了的链路接回来，并把进度报上去。
///
/// 有界重试 + 指数退避，判据与退避都在 link.rs。交回 Some 是接上了（里面是重连
/// 期间到达的帧，以及 server 不再认的那几条会话），None 是到顶了 —— 那时链路态
/// 封成 Severed，这一轮的结局仍由调用者按帧记下。
pub(crate) async fn relink(
    ws: &WsSink,
    ws_rx: &mut SplitStream<WsStream>,
    ws_url: &str,
    auth: &reqwest::header::HeaderValue,
    book: &SessionBook,
    cursors: &HashMap<String, Cursor>,
    events_tx: &mpsc::UnboundedSender<SessionEvent>,
    cause: &str,
) -> Option<Relinked> {
    let mut reason = cause.to_owned();

    for attempt in 1..=RELINK_TRIES {
        /* 第一次立刻拨：退避是失败之间的间隔，不是第一次的入场费。 */
        let wait = if attempt == 1 {
            std::time::Duration::ZERO
        } else {
            backoff(attempt - 1)
        };

        let _sent = events_tx.unbounded_send(SessionEvent::Link(retrying(attempt, wait, &reason)));

        tokio::time::sleep(wait).await;

        match redial(ws, ws_rx, ws_url, auth, book, cursors).await {
            Ok(relinked) => {
                let _sent = events_tx.unbounded_send(SessionEvent::Link(recovered(&reason)));

                return Some(relinked);
            }
            Err(error) => {
                log::warn!("kap WS relink {attempt}/{RELINK_TRIES} failed: {error}");
                reason = error.to_string();
            }
        }
    }

    /* 这一轮就此封版：屏幕上那一行不再许诺下一次。 */
    let _sent = events_tx.unbounded_send(SessionEvent::Link(severed(RELINK_TRIES, &reason)));

    None
}

/// 链路接不回来了：在飞的每一轮按帧判死，屏幕上那个纺锤才停得下来。
pub(crate) fn fail_in_flight(book: &SessionBook, reason: &str) {
    let Ok(ids) = book.ids() else {
        log::error!("the session book is poisoned, so no turn could be closed");
        return;
    };

    let message = format!("the link went down and could not be brought back: {reason}");

    for id in ids {
        if let Err(error) = book.fail_turn(&id, &message) {
            log::error!("could not close the turn of a severed session: {error}");
        }
    }
}
