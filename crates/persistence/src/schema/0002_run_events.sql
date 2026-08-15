-- 这台机器记下的帧：屏幕上那条时间线由它重放。
--
-- 追加只有一处（turn.rs 的 logging），读只有一处（agent_open_thread）。
-- agent 那侧那份是模型的上下文，由 session/load 让它自己恢复，不参与投影。
CREATE TABLE run_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id  TEXT    NOT NULL REFERENCES threads (id),
    session_id TEXT    NOT NULL,
    seq        INTEGER NOT NULL,
    at         INTEGER NOT NULL,
    -- RecordedEvent 的线上形状，原样一行 JSON：帧的形状归 frame.rs。
    frame      TEXT    NOT NULL,

    -- 重投的一帧由库拒绝，而不是由碰巧注意到它的调用方。
    UNIQUE (session_id, seq)
) STRICT;

-- 重放按追加顺序读一条对话。
CREATE INDEX run_events_by_thread ON run_events (thread_id, id);

-- 轮次的两端不再另记一本账：run_started 与终帧就在日志里，各带自己的 at。
DROP TABLE turn_spans;
