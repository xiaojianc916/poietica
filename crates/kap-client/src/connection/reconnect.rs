//! 断线重连：有界重试 + 指数退避，判据与退避在 link.rs。

use std::collections::HashMap;

use futures::StreamExt;
use futures::channel::mpsc;
use futures::stream::SplitStream;
use serde_json::Value;

use crate::connection::handshake::{
    shake_hands, subscribe, subscribe_transcript, wait_subscribe_ack,
};
use crate::connection::socket::{WsSink, WsStream, dial_ws};
use crate::error::Result;
use crate::link::{RELINK_TRIES, backoff, recovered, retrying, severed};
use crate::session::Cursor;
use crate::session::SessionEvent;
use crate::session::book::SessionBook;

pub(crate) struct Relinked {
    pub(crate) stash: Vec<Value>,
    pub(crate) refused: Vec<String>,
}

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
            refused.push(session_id.clone());
        }

        /* transcript 流不带读点重挂：server 用 transcript.reset 从当前水位整发，续订的 seq 不归这一层记。 */
        subscribe_transcript(ws, &session_id, None).await?;
    }

    Ok(Relinked { stash, refused })
}

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

    let _sent = events_tx.unbounded_send(SessionEvent::Link(severed(RELINK_TRIES, &reason)));

    None
}

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
