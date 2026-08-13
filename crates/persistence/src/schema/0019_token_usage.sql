-- 用量：每条会话报到哪儿了，以及每一天累计用掉多少 token。
--
-- agent 报的是仪表值（此刻占了多少），账要的是流量（今天花了多少），所以
-- 读数与日账在同一次事务里写。0018 那一列存的是同一个读数的 JSON 版本，
-- 一份事实只留一个归属方，随这次迁移撤掉。

CREATE TABLE session_usage (
    session_id TEXT    PRIMARY KEY,
    used       INTEGER NOT NULL,
    size       INTEGER NOT NULL
) STRICT;

CREATE TABLE token_days (
    day    TEXT    PRIMARY KEY,
    tokens INTEGER NOT NULL
) STRICT;

ALTER TABLE threads DROP COLUMN usage;
