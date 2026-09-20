use tauri_plugin_window_state::StateFlags;

/// Label of the only window this application declares. Matches tauri.conf.json.
pub const MAIN_WINDOW: &str = "main";

/// 保存与恢复必须用同一个集合；刻意不含 VISIBLE——托盘隐藏时存下的 false 若被恢复，下次启动窗口就打不开。
pub const WINDOW_STATE_FLAGS: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED)
    .union(StateFlags::FULLSCREEN);
