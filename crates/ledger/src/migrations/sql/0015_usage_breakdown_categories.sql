-- 上下文构成补齐到 agent 报的那七格。
--
-- 0014 先落了「不是对话的那几类」里最先确定的三格；这一条把它补成完整的一份：
-- 系统上下文、技能、空闲、自动压缩缓冲各占一列。
--
-- 追加而不是改 0014：那条已经落过盘。改它，装过 0014 的库就少这四列，读用量时
-- SELECT 直接失败；新库则会重复建列。两条相加才是完整的那七格。
ALTER TABLE session_usage ADD COLUMN breakdown_system_context INTEGER;
ALTER TABLE session_usage ADD COLUMN breakdown_skills         INTEGER;
ALTER TABLE session_usage ADD COLUMN breakdown_free           INTEGER;
ALTER TABLE session_usage ADD COLUMN breakdown_buffer         INTEGER;
