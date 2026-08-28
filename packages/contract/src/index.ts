/* 契约面就是生成物的全部。具名重导出等于在仓库里手抄第二份清单，两份必然分叉
（AGENTS.md §0），所以这里是 export *，规则给这一处让路。 */
// biome-ignore lint/performance/noReExportAll: 见上。
export * from './generated/ipc-bindings.ts'
