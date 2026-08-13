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
    -- 已说过几句话。record_prompt 自增并交出序号，附件与轮次计时都挂它。
    prompts        INTEGER NOT NULL DEFAULT 0,
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

-- 哪条对话的第几轮、第几张。键是「第几条用户消息」而不是消息 id：历史由
-- agent 交还，那份历史里的 id 不归我们发；两侧能独立数出同一个答案的只有
-- 序号。计数器 N 覆盖最后 N 条用户消息，认领方从末尾对齐，回放条数少于 N
-- 时整批放弃 —— 宁可不显示，不许张冠李戴。
CREATE TABLE thread_attachments (
    thread_id TEXT    NOT NULL REFERENCES threads (id),
    turn      INTEGER NOT NULL,
    ordinal   INTEGER NOT NULL,
    hash      TEXT    NOT NULL REFERENCES attachments (hash),

    PRIMARY KEY (thread_id, turn, ordinal)
) STRICT, WITHOUT ROWID;

-- 回收要问的是反向问题：这个摘要还有人引用吗。
CREATE INDEX thread_attachments_by_hash ON thread_attachments (hash);

-- 每一轮的两端。内容是 agent 的，计时是这台机器的，所以记在这里；turn 与
-- 附件同一把尺子，从末尾对齐。started_at / ended_at 是 epoch 毫秒：这两格
-- 要做减法，耗时的家不是日历，是数轴。
CREATE TABLE turn_spans (
    thread_id  TEXT    NOT NULL REFERENCES threads (id),
    turn       INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER NOT NULL,

    PRIMARY KEY (thread_id, turn)
) STRICT, WITHOUT ROWID;

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
