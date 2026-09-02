CREATE INDEX conversation_events_thread_kind_seq
ON conversation_events (thread_id, kind, seq);
