UPDATE run_events
SET frame = json_set(
    frame,
    '$.kind', 'prompt_admitted',
    '$.admissionId', 'imported:' || thread_id || ':' || session_id || ':' || seq
)
WHERE json_extract(frame, '$.kind') = 'run_started';
