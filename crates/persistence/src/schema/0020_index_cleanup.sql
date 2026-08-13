-- 删两个只耗写入、不服务任何查询的索引。
--
-- threads_by_shelf (0004) 是 threads_shelf_order (0005) 的严格前缀：同一份
-- 排序付两份维护，查询计划器最多用其一。
-- threads_archived_at (0015) 没有任何语句按 archived_at 过滤或排序 —— 归档
-- 过滤在渲染层做，判据与 0013「要用它的那天再加」同一条。
DROP INDEX IF EXISTS threads_by_shelf;
DROP INDEX IF EXISTS threads_archived_at;
