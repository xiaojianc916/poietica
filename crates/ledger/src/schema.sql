-- 本机账本的形状。一份文件就是全部：没有版本号、没有迁移链、没有历史形状。
--
-- 这个库不属于任何已发布的版本，所以磁盘形状就是这里写的这一份。改形状 = 改这个文件 +
-- 删掉用户盘上那个库（见 docs/architecture/data-layout.md），不存在「补齐」这一步。
-- 首次打开时整份执行一遍；已经存在的库只在缺表时补建（CREATE TABLE IF NOT EXISTS），
-- 不比对、不追版本 —— 已发布的迁移链才是需要那套东西的地方，这里没有已发布的版本。
--
-- 表按「这块事实归谁」聚集，不按加入时间排。

-- ---------------------------------------------------------------------------
-- 屏幕经过与本机帧：conversation_events 是这台机器留下的帧账。
--
-- 追加只有一处（conversation/events.rs），读只有一处（agent_open_thread）。
-- agent 那侧那份是模型的上下文，由 session/load 让它自己恢复，不参与投影。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversation_events (
    thread_id          TEXT    NOT NULL,
    seq                INTEGER NOT NULL,
    turn_id            TEXT,
    kind               TEXT    NOT NULL,
    payload            TEXT    NOT NULL,
    recorded_at_unix_ms INTEGER NOT NULL,
    session_id         TEXT,
    PRIMARY KEY (thread_id, seq)
) STRICT;

CREATE INDEX IF NOT EXISTS conversation_events_by_turn
    ON conversation_events (thread_id, turn_id, seq);

CREATE INDEX IF NOT EXISTS conversation_events_thread_kind_seq
    ON conversation_events (thread_id, kind, seq);

-- ---------------------------------------------------------------------------
-- 准入与投递：一次 turn 的意图快照，以及它有没有送达。
--
-- 投递幂等键就是 turn_id：重试送出的必须还是同一份意图，所以技能清单、交付层级
-- 都冻结在这里，而不是投递时现算。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS turn_admissions (
    turn_id              TEXT    NOT NULL PRIMARY KEY,
    thread_id            TEXT    NOT NULL,
    prompt               TEXT    NOT NULL,
    model                TEXT    NOT NULL,
    attachments          TEXT    NOT NULL,
    skills               TEXT    NOT NULL DEFAULT '[]',
    deliver_as           TEXT    NOT NULL DEFAULT 'turn',
    submitted_at_unix_ms INTEGER NOT NULL,
    admitted_at_unix_ms  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS turn_admissions_by_thread
    ON turn_admissions (thread_id, admitted_at_unix_ms);

CREATE TABLE IF NOT EXISTS delivery_outbox (
    turn_id            TEXT    NOT NULL PRIMARY KEY
        REFERENCES turn_admissions (turn_id) ON DELETE CASCADE,
    thread_id          TEXT    NOT NULL,
    state              TEXT    NOT NULL
        CHECK (state IN ('pending', 'sent', 'accepted', 'unknown', 'failed')),
    attempts           INTEGER NOT NULL DEFAULT 0,
    updated_at_unix_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS delivery_outbox_unresolved
    ON delivery_outbox (state, updated_at_unix_ms);

-- ---------------------------------------------------------------------------
-- 本机索引：这台机器上有过什么 —— 对话、附件、工作台、用量、处置账。
--
-- 对话内容不进库：历史由 agent 经 session/load 交还。附件字节归文件系统，
-- 库里只记账。threads 是唯一权威：标题、位置、归属都是用户或本机的决定，
-- 没有任何日志能重建它们。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS threads (
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
CREATE UNIQUE INDEX IF NOT EXISTS threads_session_id ON threads (session_id);

-- 与列表取序同形，排序换成顺序读。
CREATE INDEX IF NOT EXISTS threads_shelf_order ON threads (pinned DESC, updated_at DESC, id);

-- 附件的账。字节不在这里：不可变的大对象归文件系统，可变的小事实归数据库。
-- 身份是内容摘要，与 asset_protocol.rs 的 asset token 同一个名字，全程无翻译。
CREATE TABLE IF NOT EXISTS attachments (
    -- 小写十六进制 SHA-256，64 字符。
    hash       TEXT    PRIMARY KEY,
    -- 允许清单的唯一真值在 asset_protocol.rs，这里不抄第二份。
    mime       TEXT    NOT NULL,
    byte_size  INTEGER NOT NULL,
    created_at TEXT    NOT NULL,
    name       TEXT    NOT NULL DEFAULT 'attachment'
) STRICT;

-- 这条对话引用了哪些字节，就这一个问题。哪一句话带了哪几张由 agent 的
-- transcript 记（turn 的 attachmentIds，见 ADR 0014），所以这里不记第几轮第几张：
-- 两侧各数一遍再对齐，那是同一件事有两个来源。
CREATE TABLE IF NOT EXISTS thread_attachments (
    thread_id TEXT NOT NULL REFERENCES threads (id),
    hash      TEXT NOT NULL REFERENCES attachments (hash),

    PRIMARY KEY (thread_id, hash)
) STRICT, WITHOUT ROWID;

-- 回收要问的是反向问题：这个摘要还有人引用吗。
CREATE INDEX IF NOT EXISTS thread_attachments_by_hash ON thread_attachments (hash);

-- 工作台那一份文档：一格，一个进程级单例。
CREATE TABLE IF NOT EXISTS workbench_session (
    slot       INTEGER PRIMARY KEY CHECK (slot = 0),
    document   TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
) STRICT;

-- agent 那侧已经放掉的会话：本机记一笔，免得下次还去问它。
CREATE TABLE IF NOT EXISTS session_disposals (
    session_id TEXT PRIMARY KEY,
    agent_id   TEXT NOT NULL,
    noted_at   TEXT NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- 用量：agent 报的是仪表值（此刻占多少），账要的是流量（今天花多少）。
-- 三个读数在同一次事务里写：分两次写就会有机会对不上。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS session_usage (
    session_id             TEXT    PRIMARY KEY,
    used                   INTEGER NOT NULL,
    size                   INTEGER NOT NULL,
    -- 会话累计的输入构成（kap usage.total 的三格）。
    input_other            INTEGER NOT NULL DEFAULT 0,
    input_cache_read       INTEGER NOT NULL DEFAULT 0,
    input_cache_creation   INTEGER NOT NULL DEFAULT 0,
    -- 上下文构成。NULL = 那一份报数没带构成。七格同进同出：要么七格都有，
    -- 要么整份缺席 —— 屏幕上缺一格就画不出完整的一条，报半份等于报了个错的分布。
    breakdown_system         INTEGER,
    breakdown_system_context INTEGER,
    breakdown_tools          INTEGER,
    breakdown_skills         INTEGER,
    breakdown_messages       INTEGER,
    breakdown_free           INTEGER,
    breakdown_buffer         INTEGER
) STRICT;

-- 用量按模型分开记，只此一张：趋势图要的是「哪个模型在哪一天花了多少 token」，
-- 而日合计就是它的部分和（不另存一份，免得两处对不上）。
--
-- 模型名取自 agent 自己报的那一份（omp 的 session.model 的 provider/id 拼法）；
-- 报数没带模型时落进 'unattributed' 那一行，合计算它、趋势图不画它。
CREATE TABLE IF NOT EXISTS token_model_days (
    day    TEXT    NOT NULL,
    model  TEXT    NOT NULL,
    tokens INTEGER NOT NULL,

    PRIMARY KEY (day, model)
) STRICT;

-- ---------------------------------------------------------------------------
-- 自动化：目录文档、命令归属，以及两条「别的写入者不许越界」的约束。
-- 约束写在库上而不是调用方：越界的那一次写必须由库拒绝，不能靠碰巧有人注意到。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS automation_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    document TEXT CHECK (document IS NULL OR json_valid(document))
) STRICT;

INSERT OR IGNORE INTO automation_state(singleton, document) VALUES (1, NULL);

CREATE TABLE IF NOT EXISTS automation_claims (
    command_key TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    request_id TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS automation_claims_by_run ON automation_claims(run_id);

CREATE INDEX IF NOT EXISTS automation_claims_by_request
ON automation_claims(request_id) WHERE request_id IS NOT NULL;

-- Historical rows are retained even if an earlier writer reused an identity.
CREATE TRIGGER IF NOT EXISTS automation_request_identity
BEFORE INSERT ON automation_claims
WHEN NEW.request_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM automation_claims
    WHERE request_id = NEW.request_id OR run_id = NEW.request_id
)
BEGIN
    SELECT RAISE(ABORT, 'automation request identity is already owned');
END;

CREATE TRIGGER IF NOT EXISTS automation_owns_active_thread
BEFORE DELETE ON threads
WHEN EXISTS (
    SELECT 1 FROM automation_state,
        json_each(automation_state.document, '$.executions') AS execution
    WHERE json_extract(execution.value, '$.run.threadId') = OLD.id
)
BEGIN
    SELECT RAISE(ABORT, 'cancel and reconcile the automation before deleting its conversation');
END;

-- Admission and cancellation are ordered by the same SQLite writer transaction.
CREATE TRIGGER IF NOT EXISTS automation_admission_ownership
BEFORE INSERT ON turn_admissions
WHEN EXISTS (
    SELECT 1 FROM automation_state AS s, json_each(s.document, '$.executions') AS e
    WHERE json_extract(e.value, '$.run.threadId') = NEW.thread_id
      AND (
        json_extract(e.value, '$.run.id') != NEW.turn_id
        OR json_extract(e.value, '$.cancelRequested') = 1
        OR json_extract(e.value, '$.run.outcome') != 'dispatching'
      )
) OR (
    EXISTS (SELECT 1 FROM automation_claims WHERE run_id = NEW.turn_id)
    AND NOT EXISTS (
        SELECT 1 FROM automation_state AS s, json_each(s.document, '$.executions') AS e
        WHERE json_extract(e.value, '$.run.id') = NEW.turn_id
          AND json_extract(e.value, '$.run.threadId') = NEW.thread_id
          AND json_extract(e.value, '$.cancelRequested') = 0
          AND json_extract(e.value, '$.run.outcome') = 'dispatching'
    )
)
BEGIN
    SELECT RAISE(ABORT, 'automation execution does not own this admission');
END;
