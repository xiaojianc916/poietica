-- 准入冻结的技能清单。重试投递时送出的必须还是同一份，所以意图快照要带它。
ALTER TABLE turn_admissions ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
