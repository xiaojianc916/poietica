# @poietica/git

Git 封装（L2）：经 `@poietica/process-kit` 调用系统 Git，解析输出并监听工作区变化。

## 关键导出

- `createGit`：`run`、`status`、`branches`；参数始终以数组传递
- 错误：`GitNotFoundError`、`NotARepositoryError`、`GitCommandError`、`GitRefusedError`
- 解析：`parsePorcelainV2`、`toChangeLists`、`parseNumstat`、`parseNameStatus`、`parseForEachRef`
- `watchRepository`、`isNoteworthy`；`assertSafeRefName` 拒绝空白或以 `-` 开头的引用名

## 约束

`status` 在非仓库目录返回 `null`，其余错误上抛。

层级见 [架构文档 §3](../../docs/ARCHITECTURE.md#3-分层与依赖规则)。
