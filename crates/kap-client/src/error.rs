//! 解码失败的两种来路：帧不认识，或信封拒绝。

use thiserror::Error;

/// 一条字节流不是这个协议认识的帧。
#[derive(Debug, Error)]
#[error("the frame does not fit the pinned contract: {0}")]
pub struct DecodeError(#[from] serde_json::Error);

/// 信封收下了但业务拒绝：非零 code 是 server 的裁决，不是传输故障。
#[derive(Debug, Error)]
pub enum EnvelopeError {
    #[error("the server refused with code {code}: {msg}")]
    Refused { code: i64, msg: String },
    #[error("the envelope data does not fit the pinned contract: {0}")]
    Shape(#[from] serde_json::Error),
}
