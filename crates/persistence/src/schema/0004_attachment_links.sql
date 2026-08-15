-- 附件的账不再记「第几句话、第几张」。
--
-- 图片的落点由帧自己带（run_events 里 run_started 的 images），所以这张表只剩
-- 一个问题要答：这条对话引用了哪些字节。序号那把尺子连同「从末尾对齐」的规则
-- 一起消失 —— 两侧各数一遍再对齐，本来就是同一件事有两个来源。
--
-- 主键列删不掉，官方给的办法就是重建（lang_altertable.html#otheralter）。
CREATE TABLE thread_attachments_rekeyed (
    thread_id TEXT NOT NULL REFERENCES threads (id),
    hash      TEXT NOT NULL REFERENCES attachments (hash),

    PRIMARY KEY (thread_id, hash)
) STRICT, WITHOUT ROWID;

-- 同一张图挂在几轮上，收缩之后就是一行：内容寻址的账本里，重复的链接不是事实。
INSERT INTO thread_attachments_rekeyed (thread_id, hash)
SELECT DISTINCT thread_id, hash FROM thread_attachments;

DROP TABLE thread_attachments;

ALTER TABLE thread_attachments_rekeyed RENAME TO thread_attachments;

-- 回收问的是反向问题：这个摘要还有人引用吗。
CREATE INDEX thread_attachments_by_hash ON thread_attachments (hash);

-- 每一轮的两端在帧上（run_started 与终帧各带自己的时刻），读它的代码在那一刻
-- 就删了。表留着就是留一份没有读者的第二真相。
DROP TABLE turn_spans;

-- 说过几句话不再是任何东西的尺子。DROP COLUMN 要 SQLite 3.35，而上面这些表用了
-- STRICT，那要 3.37 —— 能力下界由 schema 自己证明。
ALTER TABLE threads DROP COLUMN prompts;
