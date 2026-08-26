//! 插件在磁盘上的取用、解压、官方安装账本与落盘。
//!
//! 这个 crate 不解释插件清单；`kimi.plugin.json` 的领域语义只由
//! `packages/plugins` 的解码与状态管线持有。这里拥有字节、路径、原子写和 agent
//! 官方 `installed.json` 的保真读改写。

mod error;
mod layout;
mod ledger;
mod skills;
mod source;
mod staging;
mod text_file;

pub use error::{HostError, Result};
pub use layout::{SKILL_FILENAME, is_safe_segment, locate_root, locate_skill_root, manifest_in};
pub use ledger::{PluginInstallation, PluginLedger, PluginRecord};
pub use skills::{ScannedSkill, install_skill, remove_skill, scan_skills, set_skill_enabled};
pub use source::{copy_tree, extract_zip};
pub use staging::Staging;
pub use text_file::{read_optional, write_atomic};
