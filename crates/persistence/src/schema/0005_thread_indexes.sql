-- 会话列表按 (pinned, updated_at, id) 取序，会话回放按 (thread_id, started_at, id)
-- 归并 run；索引与排序同形，排序换成顺序读。
-- 列表索引取代 0004 的 threads_by_shelf；那份前缀索引当时漏删，由 0020 删。
--
-- run_events(run_id, seq) 不在此列：它已有 UNIQUE 约束，SQLite 自带索引。

CREATE INDEX IF NOT EXISTS threads_shelf_order
    ON threads (pinned DESC, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS runs_thread_order
    ON runs (thread_id, started_at, id);
