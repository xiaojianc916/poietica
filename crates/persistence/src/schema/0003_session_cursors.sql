-- kap 的事件流，这台机器读到哪儿了。
--
-- 位置由 kap 签发（信封上的 seq，跨守护进程重启有效），纪元说明它属于哪一段流。
-- 这不是日志：run_events 记的是这台机器留下的帧，一条对话一份、分叉时抄得走；
-- 这里记的是那条流上的读点，一条会话一份，与对话无关。
CREATE TABLE session_cursors (
    session_id TEXT    PRIMARY KEY,
    seq        INTEGER NOT NULL,
    -- 空 = server 没报纪元。
    epoch      TEXT,
    at         TEXT    NOT NULL
) STRICT;
