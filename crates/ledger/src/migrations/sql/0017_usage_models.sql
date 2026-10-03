-- 用量按模型分开记：趋势图要的是「哪个模型在哪一天花了多少 token」。
--
-- 与 token_days 同一次事务写，两张表的分工是「合计」与「按模型拆开」；
-- 模型名取自 agent 自己报的那一份（omp 的 session.model 的 provider/id 拼法）。
CREATE TABLE token_model_days (
    day    TEXT    NOT NULL,
    model  TEXT    NOT NULL,
    tokens INTEGER NOT NULL,

    PRIMARY KEY (day, model)
) STRICT;
