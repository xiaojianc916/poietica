-- 每一轮的两端：哪条对话的第几轮，什么时候发出去，什么时候落定。
--
-- 为什么有这本账：agent 经 session/load 交还历史，而那些帧上没有任何原来的
-- 时刻 —— ACP 的 session/update 里没有这一格。内容是 agent 的，计时是这台
-- 机器的：与附件同一类事实（这个程序不存对话内容，见 lib.rs），因此记进
-- 同一个库。
--
-- turn 与附件同一把尺子：record_prompt 发出的序号，从 0 数起，盖住的是账本
-- 开始记之后的那几轮；认领方从末尾对齐（见 packages/agent 的 turn-spans.ts，
-- 与 attachImages 同一条规矩）。
--
-- started_at / ended_at 是 epoch 毫秒。库里另一种时刻是 RFC 3339 文本
--（threads.updated_at），那一格回答的是「排到列表的哪里」；这两格要做减法，
-- 耗时的家不是日历，是数轴。

CREATE TABLE turn_spans (
    thread_id  TEXT    NOT NULL REFERENCES threads (id),
    turn       INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER NOT NULL,

    PRIMARY KEY (thread_id, turn)
) STRICT, WITHOUT ROWID;
