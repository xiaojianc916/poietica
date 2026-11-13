/**
 * 产品领域实体已移到 @poietica/product-model（P6c 解耦准备）：
 * threads / runs / composer 的独立模块都要读同一份 Thread / TurnState / Submission 形状。
 */
export * from '@poietica/product-model'
