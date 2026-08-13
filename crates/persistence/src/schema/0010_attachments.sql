-- 附件的账。字节不在这里。
--
-- 身份是内容摘要,而且刻意与 asset_protocol.rs 的 asset token 用同一个:
-- 那条协议要求 asset_token == content_hash(小写十六进制 SHA-256),所以一张图
-- 从磁盘到界面全程只有一个名字,没有任何一处需要做翻译。
--
-- 为什么字节不进这张表:SQLite 存 BLOB 本身没问题,但这个库开在 WAL 模式下、
-- 与对话索引同一个文件,把几十 MB 的图片写进去意味着每次 checkpoint 都要搬运
-- 它们,而它们一个字节都不会再变。不可变的大对象归文件系统,可变的小事实归
-- 数据库 —— 这是 git、VS Code、Zed 的本地存储都在用的划分。

CREATE TABLE attachments (
    -- 小写十六进制 SHA-256,64 字符。
    hash       TEXT    PRIMARY KEY,
    -- 只可能是 asset_protocol.rs 允许清单里的那几种。那份清单是唯一的真值,
    -- 这里不再抄一遍:抄下来的清单会和它漂移,而漂移的方向是把 SVG 放进来。
    mime       TEXT    NOT NULL,
    byte_size  INTEGER NOT NULL,
    created_at TEXT    NOT NULL
) STRICT;

-- 哪条对话的第几轮、第几张。
--
-- 为什么键是「第几轮」而不是消息 id:这个应用不存对话内容(见 lib.rs 与迁移
-- 0009),历史由 agent 经 session/load 交还,那份历史里的 id 不归我们发。能由
-- 两侧独立数出同一个答案的,只有「这是这条对话里第几条用户消息」。
--
-- 对齐规则的现行版本在 0011:计数覆盖最后 N 条用户消息,认领方从末尾对齐,
-- 回放条数少于计数时整批放弃 —— 宁可不显示,不许张冠李戴。

CREATE TABLE thread_attachments (
    thread_id TEXT    NOT NULL REFERENCES threads (id),
    turn      INTEGER NOT NULL,
    ordinal   INTEGER NOT NULL,
    hash      TEXT    NOT NULL REFERENCES attachments (hash),

    PRIMARY KEY (thread_id, turn, ordinal)
) STRICT, WITHOUT ROWID;

-- 回收要问的是反向问题:这个摘要还有人引用吗。
CREATE INDEX thread_attachments_by_hash ON thread_attachments (hash);
