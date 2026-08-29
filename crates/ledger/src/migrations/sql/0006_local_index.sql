-- 本机索引：这台机器上有过什么 —— 对话、附件、帧、工作台、用量、处置账。
--
-- 与 thread_projection（0005）的分界是可否重建：投影能从事件重算，
-- 这里的标题、位置、归属是用户与本机的决定，没有事件能重建它们。

-- 对话索引与本机事实的账本。
--
-- 对话内容不进库：历史由 agent 经 session/load 交还。附件字节归文件系统，
-- 库里只记账。threads 是唯一权威：标题、位置、归属都是用户或本机的决定，
-- 没有任何日志能重建它们。

CREATE TABLE threads (
    id             TEXT    PRIMARY KEY,
    title          TEXT    NOT NULL,
    created_at     TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL,
    -- 一条对话至多握一个 agent 会话，没握时为空。
    session_id     TEXT,
    -- 标题来源；取值集的唯一真值在 Rust 侧 TitleSource。
    title_source   TEXT    NOT NULL DEFAULT 'fallback',
    pinned         INTEGER NOT NULL DEFAULT 0,
    -- 会话号只在开出它的 agent 那里认得，所以持有者跟着号一起存。
    agent_id       TEXT,
    -- 归一化后的绝对路径，空 = 默认工作区。归一化只在渲染层入口做一遍。
    workspace_root TEXT,
    archived_at    TEXT,

    -- 握着会话的行必须说得出主人；空值只有一个意思：还没握住会话。
    CONSTRAINT threads_session_needs_owner
        CHECK (session_id IS NULL OR agent_id IS NOT NULL)
) STRICT;

-- 一号一主；没握会话的行是空，空值在唯一索引里不相撞。
CREATE UNIQUE INDEX threads_session_id ON threads (session_id);

-- 与列表取序同形，排序换成顺序读。
CREATE INDEX threads_shelf_order ON threads (pinned DESC, updated_at DESC, id);

-- 附件的账。字节不在这里：不可变的大对象归文件系统，可变的小事实归数据库。
-- 身份是内容摘要，与 asset_protocol.rs 的 asset token 同一个名字，全程无翻译。
CREATE TABLE attachments (
    -- 小写十六进制 SHA-256，64 字符。
    hash       TEXT    PRIMARY KEY,
    -- 允许清单的唯一真值在 asset_protocol.rs，这里不抄第二份。
    mime       TEXT    NOT NULL,
    byte_size  INTEGER NOT NULL,
    created_at TEXT    NOT NULL
) STRICT;

-- 这条对话引用了哪些字节，就这一个问题。图片的落点由帧自己带
-- （run_events 里 prompt_admitted 的 images），所以这里不记第几轮第几张：
-- 两侧各数一遍再对齐，那是同一件事有两个来源。
CREATE TABLE thread_attachments (
    thread_id TEXT NOT NULL REFERENCES threads (id),
    hash      TEXT NOT NULL REFERENCES attachments (hash),

    PRIMARY KEY (thread_id, hash)
) STRICT, WITHOUT ROWID;

-- 回收要问的是反向问题：这个摘要还有人引用吗。
CREATE INDEX thread_attachments_by_hash ON thread_attachments (hash);

-- 这台机器记下的帧：屏幕上那条时间线由它重放。
--
-- 追加只有一处（turn.rs 的 logging），读只有一处（agent_open_thread）。
-- agent 那侧那份是模型的上下文，由 session/load 让它自己恢复，不参与投影。
-- 唯一键按对话去重，不按会话：分叉出的对话要抄得走源对话的日志。
CREATE TABLE run_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id  TEXT    NOT NULL REFERENCES threads (id),
    session_id TEXT    NOT NULL,
    seq        INTEGER NOT NULL,
    at         INTEGER NOT NULL,
    -- RecordedEvent 的线上形状，原样一行 JSON：帧的形状归 frame.rs。
    frame      TEXT    NOT NULL,

    -- 重投的一帧由库拒绝，而不是由碰巧注意到它的调用方。
    UNIQUE (thread_id, session_id, seq)
) STRICT;

-- 重放按追加顺序读一条对话。
CREATE INDEX run_events_by_thread ON run_events (thread_id, id);

CREATE TABLE workbench_session (
    slot       INTEGER PRIMARY KEY CHECK (slot = 0),
    document   TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
) STRICT;

CREATE TABLE session_disposals (
    session_id TEXT PRIMARY KEY,
    agent_id   TEXT NOT NULL,
    noted_at   TEXT NOT NULL
) STRICT;

-- 用量：agent 报的是仪表值（此刻占多少），账要的是流量（今天花多少），
-- 所以读数与日账在同一次事务里写。
CREATE TABLE session_usage (
    session_id TEXT    PRIMARY KEY,
    used       INTEGER NOT NULL,
    size       INTEGER NOT NULL
) STRICT;

CREATE TABLE token_days (
    day    TEXT    PRIMARY KEY,
    tokens INTEGER NOT NULL
) STRICT;

-- 会话累计的输入构成（kap usage.total 的三格），追加迁移：0001 已落盘的库
-- 靠它补上这三列，老账上的存量从 0 记起，随下一份报告到达刷新。
ALTER TABLE session_usage ADD COLUMN input_other          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_usage ADD COLUMN input_cache_read     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_usage ADD COLUMN input_cache_creation INTEGER NOT NULL DEFAULT 0;

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

UPDATE run_events
SET frame = json_set(
    frame,
    '$.kind', 'prompt_admitted',
    '$.admissionId', 'imported:' || thread_id || ':' || session_id || ':' || seq
)
WHERE json_extract(frame, '$.kind') = 'run_started';
