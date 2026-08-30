//! 链路这条命：拨号与发帧（socket）、握手与订阅（handshake）、断线重连
//! （reconnect）。判据与退避曲线在 crate 根的 link.rs。

pub(crate) mod handshake;
pub(crate) mod reconnect;
pub(crate) mod socket;
