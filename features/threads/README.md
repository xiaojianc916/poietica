# @poietica/feature-threads

线程元数据仓储（P6c 第一阶段）：`threads` 表由 conversation 的历史迁移创建，本模块接管读写。

- 服务：`ThreadsRepositoryToken`。
- 过渡：`tablePrefix: 'conversation'`，表重命名与旧库迁移在独立 schema 窗口完成。
- 尚未迁入：ThreadService、标题策略、回收队列与会话池接线。
