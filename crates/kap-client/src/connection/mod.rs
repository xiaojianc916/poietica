//! 链路这条命：拨号与发帧（socket）、握手与订阅（handshake）、订阅读点（cursor）。
//! 判据与退避曲线在 crate 根的 link.rs；断线重连是会话恢复，归 session/reconnect.rs。

pub(crate) mod cursor;
pub(crate) mod handshake;
pub(crate) mod socket;
