-- 会话累计的输入构成（kap usage.total 的三格），追加迁移：0001 已落盘的库
-- 靠它补上这三列，老账上的存量从 0 记起，随下一份报告到达刷新。
ALTER TABLE session_usage ADD COLUMN input_other          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_usage ADD COLUMN input_cache_read     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_usage ADD COLUMN input_cache_creation INTEGER NOT NULL DEFAULT 0;
