//! 握手与订阅：server_hello → client_hello → ack，以及把一条会话挂上事件流。

use std::time::Duration;

use futures::StreamExt;
use futures::stream::SplitStream;
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

use crate::connection::socket::{WsSink, WsStream, send_frame};
use crate::error::{KapError, Result};
use crate::generated::events::{
    ClientFrame, ClientHelloCursorsValueStruct, ClientHelloStruct, ServerFrame,
    SubscribeAckPayloadStruct, SubscribeStruct,
};
use crate::server_frame;

/// 一帧控制帧的 ack 最多等多久。
///
/// 对端接下 TCP 却不说话时，裸等会让首连的握手与每一次重连各自永远停住 ——
/// 屏幕上那一行既不 Recovered 也不 Severed。
pub(crate) const ACK_TIMEOUT: Duration = Duration::from_secs(10);

/// server_hello → client_hello → ack。首连与重连共用这一条。
pub(crate) async fn shake_hands(
    ws: &WsSink,
    ws_rx: &mut SplitStream<WsStream>,
    stash: &mut Vec<Value>,
) -> Result<()> {
    let deadline = tokio::time::Instant::now() + ACK_TIMEOUT;

    loop {
        match tokio::time::timeout_at(deadline, ws_rx.next()).await {
            Ok(Some(Ok(Message::Text(raw)))) => {
                if matches!(server_frame(&raw), Ok(ServerFrame::ServerHello { .. })) {
                    break;
                }
            }
            Ok(Some(Err(error))) => {
                return Err(KapError::Handshake {
                    message: error.to_string(),
                });
            }
            Ok(None) => {
                return Err(KapError::Handshake {
                    message: "WS closed before server_hello".to_owned(),
                });
            }
            Err(_elapsed) => {
                return Err(KapError::Handshake {
                    message: "no server_hello arrived in time".to_owned(),
                });
            }
            Ok(_) => {}
        }
    }

    let hello = send_frame(
        ws,
        ClientFrame::ClientHello {
            id: Uuid::new_v4().to_string(),
            payload: ClientHelloStruct {
                client_id: Uuid::new_v4().to_string(),
                subscriptions: None,
                cursors: None,
                agent_filter: None,
            },
        },
    )
    .await?;

    let _accepted = wait_ack(ws_rx, &hello, stash).await?;

    Ok(())
}

/// 等某帧的 ack，返回它的载荷；等待期间到达的其它帧收进 stash。
///
/// 不能丢：ack 是 sendImmediateFrame 发的，它把整条出队队列一次冲干净
/// （wsConnectionV1.ts flush），所以排在 ack 前面的事件帧会先到这里。
pub(crate) async fn wait_ack(
    ws_rx: &mut SplitStream<WsStream>,
    id: &str,
    stash: &mut Vec<Value>,
) -> Result<Value> {
    let deadline = tokio::time::Instant::now() + ACK_TIMEOUT;

    loop {
        match tokio::time::timeout_at(deadline, ws_rx.next()).await {
            Ok(Some(Ok(Message::Text(raw)))) => {
                let frame = server_frame(&raw);
                let Ok(ServerFrame::Ack {
                    id: answered,
                    code,
                    payload,
                    ..
                }) = frame
                else {
                    // 不是 ack 的帧原样进 stash：它们排在这条 ack 前面，属于事件流。
                    if let Ok(frame) = serde_json::from_str::<Value>(&raw) {
                        stash.push(frame);
                    }
                    continue;
                };

                if answered != id {
                    if let Ok(frame) = serde_json::from_str::<Value>(&raw) {
                        stash.push(frame);
                    }
                    continue;
                }

                return match code {
                    0 => Ok(payload),
                    code => Err(KapError::Handshake {
                        message: format!("control frame {id} rejected with code {code}: {raw}"),
                    }),
                };
            }
            Ok(Some(Err(error))) => {
                return Err(KapError::Handshake {
                    message: error.to_string(),
                });
            }
            Ok(None) => {
                return Err(KapError::Handshake {
                    message: "WS closed before the ack arrived".to_owned(),
                });
            }
            Err(_elapsed) => {
                return Err(KapError::Handshake {
                    message: format!("control frame {id} was never acknowledged"),
                });
            }
            Ok(_) => {}
        }
    }
}

/// 订阅的 ack 永远是 code 0：成败写在载荷的 accepted / not_found 里
/// （contracts/kap/asyncapi.json 的 subscribe_ack）。
/// 只看 code 就会把「这条会话没订上」当成订上了，然后一帧不来地等到超时。
/// Ok(false) 是「这条会话没订上」，一条会话的事；Err 是这条链路的事。
pub(crate) async fn wait_subscribe_ack(
    ws_rx: &mut SplitStream<WsStream>,
    id: &str,
    session_id: &str,
    stash: &mut Vec<Value>,
) -> Result<bool> {
    let payload = wait_ack(ws_rx, id, stash).await?;
    let decoded: Option<SubscribeAckPayloadStruct> = serde_json::from_value(payload).ok();

    Ok(decoded.is_some_and(|ack| ack.accepted.iter().any(|entry| entry == session_id)))
}

/// 把一条会话挂到这条连接的事件流上，返回那一帧的 id。不在握手内联订阅：
/// 订阅走独立的 subscribe 操作（contracts/kap/asyncapi.json 的 subscribe）。
///
/// 带着读点订阅，server 就从那一帧之后接着发（subscribePayloadSchema 的 cursors、
/// sessionCursorSchema）；接不下去时它回 resync_required，而不是默默从头来。新开
/// 与分叉出来的会话没有读点：它们的流从这一刻才开始。
pub(crate) async fn subscribe(
    ws: &WsSink,
    session_id: &str,
    from: Option<&crate::session::Cursor>,
) -> Result<String> {
    let cursors = from.map(|crate::session::Cursor { seq, epoch }| {
        [(
            session_id.to_owned(),
            ClientHelloCursorsValueStruct {
                seq: *seq,
                epoch: epoch.clone(),
            },
        )]
        .into_iter()
        .collect()
    });

    send_frame(
        ws,
        ClientFrame::Subscribe {
            id: Uuid::new_v4().to_string(),
            payload: SubscribeStruct {
                session_ids: vec![session_id.to_owned()],
                cursors,
                watch_fs: None,
                agent_filter: None,
            },
        },
    )
    .await
}
