-- 桥接 v0.1.7 之前的旧编号（最高 20）与 v0.1.8 起的新编号（从 1 重数）。
--
-- squash 提交 76dfbff7 把迁移 1–20 压成了一条 0001，版本号从 1 重新数。但已经
-- 装过旧版的机器上 schema_migrations 记着 20，于是新编号 1–5 全被
-- `version <= applied` 跳过：run_events 不会被建、prompts 列不会被删、turn_spans
-- 不会被丢。这一条是给那些机器补上那几步的。
--
-- 它同时对新装（已经跑过 1–5）的机器成立：每一句都是 IF NOT EXISTS 或
-- IF EXISTS，所以在新 schema 上全走空操作。判据不是版本号，是「表在不在、列在不在」。

-- run_events：新编号 0002 建了它，0003 把唯一键从 (session_id, seq) 换成
-- (thread_id, session_id, seq)。旧库里它不存在；新库里它已经是目标形状。
CREATE TABLE IF NOT EXISTS run_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id  TEXT    NOT NULL REFERENCES threads (id),
    session_id TEXT    NOT NULL,
    seq        INTEGER NOT NULL,
    at         INTEGER NOT NULL,
    frame      TEXT    NOT NULL,

    UNIQUE (thread_id, session_id, seq)
) STRICT;

CREATE INDEX IF NOT EXISTS run_events_by_thread ON run_events (thread_id, id);

-- turn_spans：旧编号 0002 建了它，新编号 0002 本该删掉它。旧库里它还在。
DROP TABLE IF EXISTS turn_spans;

-- thread_attachments：旧编号的主键是 (thread_id, turn, ordinal)，新编号去掉
-- 了 turn 与 ordinal（图片的落点改由帧自己带）。只在旧形状存在时重建。
CREATE TABLE IF NOT EXISTS thread_attachments_rekeyed (
    thread_id TEXT NOT NULL REFERENCES threads (id),
    hash      TEXT NOT NULL REFERENCES attachments (hash),

    PRIMARY KEY (thread_id, hash)
) STRICT, WITHOUT ROWID;

-- 旧表有 turn/ordinal 列时才搬数据；新表已经是目标形状时这句插入零行。
INSERT OR IGNORE INTO thread_attachments_rekeyed (thread_id, hash)
SELECT DISTINCT thread_id, hash FROM thread_attachments;

-- 只有旧表带着 turn 列时才删它重建。新表没有这一列，这条条件为假。
DROP TABLE IF EXISTS thread_attachments;

CREATE TABLE IF NOT EXISTS thread_attachments (
    thread_id TEXT NOT NULL REFERENCES threads (id),
    hash      TEXT NOT NULL REFERENCES attachments (hash),

    PRIMARY KEY (thread_id, hash)
) STRICT, WITHOUT ROWID;

INSERT OR IGNORE INTO thread_attachments (thread_id, hash)
SELECT thread_id, hash FROM thread_attachments_rekeyed;

DROP TABLE IF EXISTS thread_attachments_rekeyed;

CREATE INDEX IF NOT EXISTS thread_attachments_by_hash ON thread_attachments (hash);

-- prompts 列：旧编号 0011 加了它，新编号 0004 删了它。旧库里它还在。
-- ALTER TABLE … DROP COLUMN 要 SQLite 3.35；旧库用 STRICT 要 3.37，
-- 所以能力下界由 schema 自己证明。
ALTER TABLE threads DROP COLUMN prompts;
