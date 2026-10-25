# @poietica/storage-sqlite

SQLite 存储层（L2）：基于 `bun:sqlite` 的模块化连接、迁移与表前缀守卫。

## 关键导出

- `openDatabase`：WAL 与外键；`forModule(moduleId)` 提供受限视图
- `ModuleDatabase`：`prepare`、`exec`、`transaction`，首次使用即校验表前缀
- `runMigrations`：版本须从 1 连续；`DataTooNewError` 表示数据库来自更新版本
- `tablePrefix`、`assertOwnTables`：拒绝越界表名及 `ATTACH`、`PRAGMA`、`VACUUM`

## 约束

模块只经 `forModule` 访问数据库，`raw` 仅供内核；迁移版本须从 1 连续递增。项目尚未发布，各功能只保留一条 `init`，改表直接改那一条（见 `AGENTS.md` §5.2）。

数据归属见 [架构文档 §7](../../docs/ARCHITECTURE.md#7-数据与存储)。
