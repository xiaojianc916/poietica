use thiserror::Error;

#[derive(Debug, Error)]
pub enum LedgerError {
    #[error("SQLite 拒绝了操作：{0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("无法准备账本目录：{0}")]
    Io(#[from] std::io::Error),
    #[error("事件负载无法编解码：{0}")]
    Payload(#[from] serde_json::Error),
    #[error("journal_mode 落在 {actual}，账本要求 wal")]
    JournalMode { actual: String },
    #[error("账本连接已中毒：上一个持锁者 panic 了")]
    Poisoned,
    #[error("{column} 存着无法识别的值 {value}")]
    UnknownStoredValue { column: &'static str, value: String },
    #[error("迁移 {version} 的名字变了：账本记着 {recorded}，代码里是 {expected}")]
    MigrationDrift {
        version: i64,
        recorded: String,
        expected: String,
    },
}
