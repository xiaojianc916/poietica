//! 扩展（插件与技能）在磁盘上的取用、解压、落盘与盘点。
//!
//! 这个 crate 不认识插件清单的内容。它搬字节、拼路径、保证写入是原子的，至于
//! kimi.plugin.json 里写了什么由 packages/plugins 的解码器说了算 —— 提示词预算、
//! 命令描述回落、agent 覆盖规则都在那一条管线上，这里再解析一遍就是第二套规则。

mod error;
mod inventory;
mod layout;
mod skills;
mod source;
mod staging;
mod text_file;

pub use error::{ExtensionError, Result};
pub use inventory::{InstalledPlugin, PluginInstall, PluginInventory, PluginReference};
pub use layout::{SKILL_FILENAME, is_safe_segment, locate_root, locate_skill_root, manifest_in};
pub use skills::{ScannedSkill, install_skill, remove_skill, scan_skills, set_skill_enabled};
pub use source::{copy_tree, extract_zip};
pub use staging::Staging;
pub use text_file::{read_optional, write_atomic};
