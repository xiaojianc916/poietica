//! WebSocket 传输：拨号与发帧，只管运输，不认识任何一条命令。

use std::sync::Arc;

use futures::SinkExt;
use futures::stream::SplitSink;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::header::AUTHORIZATION},
};

use crate::error::{KapError, Result};
use crate::generated::events::ClientFrame;

/// 本进程与 kap server 之间的 WebSocket。
pub(crate) type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// 发控制帧的那一头。主循环与「刚开出来的会话要订阅」的任务共用同一个写端，
/// 而 SplitSink 不是 Clone，所以它在锁后面。
pub(crate) type WsSink = Arc<tokio::sync::Mutex<SplitSink<WsStream, Message>>>;

/// 拨一条 WS。令牌走 Authorization 头，与 REST 同一条鉴权。
pub(crate) async fn dial_ws(ws_url: &str, auth: &reqwest::header::HeaderValue) -> Result<WsStream> {
    let mut request = ws_url
        .into_client_request()
        .map_err(|e| KapError::Transport {
            message: e.to_string(),
        })?;

    request.headers_mut().insert(AUTHORIZATION, auth.clone());

    let (stream, _response) = connect_async(request)
        .await
        .map_err(|e| KapError::Handshake {
            message: e.to_string(),
        })?;

    Ok(stream)
}

/// 发一帧控制帧，返回它的 id。帧的形状由快照生成的 ClientFrame 成形，
/// 这里只管上 wire。
pub(crate) async fn send_frame(ws: &WsSink, frame: ClientFrame) -> Result<String> {
    let id = match &frame {
        ClientFrame::ClientHello { id, .. } | ClientFrame::Subscribe { id, .. } => id.clone(),
        ClientFrame::Pong { .. } => String::new(),
    };

    ws.lock()
        .await
        .send(Message::Text(serde_json::to_string(&frame).map_err(
            |e| KapError::Transport {
                message: e.to_string(),
            },
        )?))
        .await
        .map_err(|e| KapError::Transport {
            message: e.to_string(),
        })?;

    Ok(id)
}
