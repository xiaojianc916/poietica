# @poietica/contract-kit

契约基元（L1）：以 zod 定义方法、通知与错误码，供各功能的 `contract` 子入口使用。

## 关键导出

- `defineContract`、`defineMethod`、`defineNotification`、`defineErrors`
- `composeContracts`：并入系统契约，校验命名空间、名称与错误码前缀
- `contractSnapshot`：输出排序稳定的 JSON 快照
- `systemContract`、`SYSTEM_CONTRACT_ID` 与 `coreStatusSchema` / `coreReadySchema` / `coreNoticeSchema`

## 约束

名称须以所属命名空间开头，`owner` 为 `core` 或 `host`；错误码前缀须等于契约 id（系统契约为 `kernel`）。

见 [架构文档 §5](../../docs/ARCHITECTURE.md#5-契约与协议)。
