-- 这本日志按对话记，去重也按对话去重。
--
-- 0002 把唯一键写成 (session_id, seq)，于是一段会话的帧在全库只允许存在一
-- 份：分叉出的对话抄不走源对话的日志，插入被 ON CONFLICT 静默吞掉。表级
-- UNIQUE 建的是 sqlite_autoindex，删不掉，所以按 sqlite.org 记的重建流程
-- 换键（lang_altertable.html#otheralter）：建新表、搬数据、删旧表、改名。
CREATE TABLE run_events_rekeyed (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id  TEXT    NOT NULL REFERENCES threads (id),
    session_id TEXT    NOT NULL,
    seq        INTEGER NOT NULL,
    at         INTEGER NOT NULL,
    frame      TEXT    NOT NULL,

    UNIQUE (thread_id, session_id, seq)
) STRICT;

INSERT INTO run_events_rekeyed (id, thread_id, session_id, seq, at, frame)
SELECT id, thread_id, session_id, seq, at, frame FROM run_events ORDER BY id;

DROP TABLE run_events;

ALTER TABLE run_events_rekeyed RENAME TO run_events;

-- 旧表带走了它的索引，重建一份：重放按追加顺序读一条对话。
CREATE INDEX run_events_by_thread ON run_events (thread_id, id);
