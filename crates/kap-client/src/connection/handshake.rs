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
    SubscribeAckPayloadStruct, SubscribeStruct, UnsubscribeStruct,
};
use crate::server_frame;

/// 一帧控制帧的 ack 最多等多久：对端接下 TCP 却不说话时，裸等会让握手永远停住。
pub(crate) const ACK_TIMEOUT: Duration = Duration::from_secs(10);

const SUPPORTED_KAP_WS_PROTOCOL: i64 = 2;

fn validate_protocol_version(version: i64) -> Result<()> {
    if version == SUPPORTED_KAP_WS_PROTOCOL {
        return Ok(());
    }

    Err(KapError::Handshake {
        message: format!(
            "unsupported KAP websocket protocol {version}; this build requires {SUPPORTED_KAP_WS_PROTOCOL}"
        ),
    })
}

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
                if let Ok(ServerFrame::ServerHello { payload, .. }) = server_frame(&raw) {
                    validate_protocol_version(payload.protocol_version)?;
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

/// 本地关掉一条会话时，同步告诉 server 别再发它的帧
/// （contracts/kap/asyncapi.json 的 unsubscribe）。
pub(crate) async fn unsubscribe(ws: &WsSink, session_id: &str) -> Result<()> {
    send_frame(
        ws,
        ClientFrame::Unsubscribe {
            id: Uuid::new_v4().to_string(),
            payload: UnsubscribeStruct {
                session_ids: vec![session_id.to_owned()],
            },
        },
    )
    .await
    .map(|_id| ())
}

/// 把一条会话的 transcript 粒度流挂上这条连接（subscribe_v2，asyncapi.json）。
///
/// 粒度按 agent 声明：`*` 是默认档，逐 agent 的键盖过它。delta 是最细一档，
/// 屏幕（块与流片都要）与追赶（REST catch-up）都吃得下；更粗的档会丢流片。
/// `transcript_since` 只在对得上号的续订里带，否则 server 从头整发 —— 首订
/// 就该整发。
pub(crate) async fn subscribe_transcript(
    ws: &WsSink,
    session_id: &str,
    since: Option<i64>,
) -> Result<String> {
    use crate::generated::events::{SubscribeV2Struct, SubscribeV2TranscriptValueEnum};

    send_frame(
        ws,
        ClientFrame::SubscribeV2 {
            id: Uuid::new_v4().to_string(),
            payload: SubscribeV2Struct {
                session_id: session_id.to_owned(),
                transcript: [("*".to_owned(), SubscribeV2TranscriptValueEnum::Delta)]
                    .into_iter()
                    .collect(),
                transcript_since: since.map(|seq| [("*".to_owned(), seq)].into_iter().collect()),
            },
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::validate_protocol_version;

    #[test]
    fn websocket_protocol_is_an_explicit_compatibility_gate() {
        assert!(validate_protocol_version(2).is_ok());
        assert!(validate_protocol_version(1).is_err());
        assert!(validate_protocol_version(3).is_err());
    }
}
