//! 窗口这一侧的常驻事实：标签与被持久化的几何集合。

use tauri_plugin_window_state::StateFlags;

/// Label of the only window this application declares. Matches tauri.conf.json.
pub const MAIN_WINDOW: &str = "main";

/// 被持久化、也被恢复的那一份窗口几何。
///
/// 保存与恢复必须用同一个集合，否则磁盘上会留下没人读的字段，或者读到没人写的
/// 字段。这个常量是唯一的声明处：托盘与生命周期都消费它，不再各写一遍 `all()`。
///
/// 刻意不含 VISIBLE：可见性归托盘状态机。隐藏到托盘时存下的 visible: false 若被
/// 当成恢复目标，下一次启动窗口就打不开了。
///
/// 刻意不含 DECORATIONS：边框归 tauri.conf.json（decorations: false + 自绘标题
/// 栏）。让磁盘上的旧值有机会把原生边框装回来，收益为零。
pub const WINDOW_STATE_FLAGS: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED)
    .union(StateFlags::FULLSCREEN);
