//! 把一个 kap agent 接进这台机器：装它、认它、给它凭据、验它的密钥。
//!
//! 与 `super::conversation` 的分界是「这件事什么时候发生」：这里全是落盘的事实 ——
//! agents.json 里的接入档案、agent 自己 config.toml 里的 provider 与默认模型、
//! 那个外部 CLI 装没装。`super::conversation` 是一条活着的会话，状态在内存里，寿命
//! 是一次连接。所以两边不是同一个 `config`，也不该合成一个。
//!
//! 依赖单向：`super::conversation::runtime` 起连接之前向 `profile::launch_env` 要环境
//! 变量；这一侧不认识会话，也不得反向引用 `super::conversation`。
//!
//! 分四个文件而不是一个，因为其中两条是各自封闭的白名单入口：`exec` 只放行
//! provider 子命令，`install` 只放行一次全局安装。把后者并进前者，等于把一个
//! 受控入口改成通用执行入口。

pub mod exec;
pub mod install;
pub mod probe;
pub mod profile;
