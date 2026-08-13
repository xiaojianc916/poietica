-- 这条对话最近一次报过的上下文用量：ACP usage_update 的载荷原文（JSON）。
--
-- Kimi 只在轮次落定后报一次，装载旧会话时不补报（协议建议补报，它没做），
-- 所以重启后的第一眼只有这一列答得上。空表示从没报过。
-- 存原文不拆字段：读它的只有渲染侧契约层（usage.ts）一处，与命令表同一条规矩。
ALTER TABLE threads ADD COLUMN usage TEXT;
