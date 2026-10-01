//! 把一个 kap agent 接进这台机器：装它、认它、给它凭据、验它的密钥。
//!
//! 与 `super::conversation` 的分界是「这件事什么时候发生」：这里全是落盘的事实 ——
//! agents.json 里的接入档案、agent 自己 config.toml 里的 provider 与默认模型、
//! 那个外部 CLI 装没装。`super::conversation` 是一条活着的会话，状态在内存里，寿命
//! 是一次连接。所以两边不是同一个 `config`，也不该合成一个。
//!
//! 依赖单向：`super::conversation::runtime` 起连接之前向 `profile::launch_env` 要环境
//! 变量；这一侧不认识会话，也不得反向引用 `super::conversation`。

pub mod install;
pub mod profile;
