# @poietica/feature-runs

运行与提交记录（P6c 第一阶段）：`conversation_submissions` 表由 runs 模块接管。

- 服务：`SubmissionsRepositoryToken`。
- 过渡：`tablePrefix: 'conversation'`，表重命名在独立 schema 窗口完成。
- 尚未迁入：TurnService、SubmissionService、SessionPool。
