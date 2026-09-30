-- 这一句走哪一层：turn（开一轮）或三层插话 steer / followUp / aside。
-- 投递时按它分派，重放与当时不可能不一样，所以和 prompt 一样是冻结意图的一部分。
-- 老行是这一格出现之前的准入，那时只有开轮这一种，默认值就是它。
ALTER TABLE turn_admissions ADD COLUMN deliver_as TEXT NOT NULL DEFAULT 'turn';
