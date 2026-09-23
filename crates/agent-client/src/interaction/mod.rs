//! 人这一侧的两张桌子：审批（permission）与提问（question），以及等答案的
//! 桌子本身（desk）。两个 desk 分开，因为「什么算一个合法答复」的判据不同。

pub(crate) mod desk;
pub(crate) mod permission;
pub(crate) mod question;
