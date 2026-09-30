-- 上下文构成的三格与用量同行。
--
-- 它们随用量一起到达、一起替换，寿命与那一行完全相同，所以不另开一张表：第二张表
-- 会带来第二个写入时刻，两份读数就有机会对不上。
--
-- NULL = 那一份报数没带构成。三列同进同出：要么三格都有，要么整份缺席 —— 屏幕上
-- 缺一格就画不出完整的一条，报半份等于报了个错的分布。
ALTER TABLE session_usage ADD COLUMN breakdown_system   INTEGER;
ALTER TABLE session_usage ADD COLUMN breakdown_tools    INTEGER;
ALTER TABLE session_usage ADD COLUMN breakdown_messages INTEGER;
