-- 旧帧账并入事件账：屏幕那条经过从此只有一张表。
--
-- 按线程重排序号（旧序按会话编，新序由账本按对话编），信封格子
-- （sessionId/seq/at）从载荷剥到列上；kind 判别式两边同名，原样保留。
-- prompt_admitted 的 admissionId 就是投递的幂等键，落进 turn_id 列。
ALTER TABLE conversation_events ADD COLUMN session_id TEXT;

INSERT INTO conversation_events (thread_id, seq, turn_id, kind, payload, recorded_at_unix_ms, session_id)
SELECT thread_id,
       ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY id),
       CASE json_extract(frame, '$.kind') WHEN 'prompt_admitted' THEN json_extract(frame, '$.admissionId') END,
       json_extract(frame, '$.kind'),
       json_remove(frame, '$.sessionId', '$.seq', '$.at'),
       at,
       session_id
FROM run_events
ORDER BY id;
