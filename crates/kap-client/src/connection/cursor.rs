//! 订阅读点：位置由 server 签发（信封 seq），重新订阅原样报回去。
//!
//! 它是线上词汇而不是会话状态：形状与 subscribe 载荷的 cursors 那一格一一对应
//! （contracts/kap/asyncapi.json 的 subscribe），所以住在链路这一侧 ——
//! 握手要用它组帧，而握手不该反向认识会话领域。

/// 一条会话读到哪一帧。epoch 由 server 在重开时换掉，对不上就是读点已失效。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Cursor {
    pub seq: i64,
    pub epoch: Option<String>,
}
