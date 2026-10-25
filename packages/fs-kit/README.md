# @poietica/fs-kit

文件系统工具（L2）：原子写入、目录准备、流式哈希、JSON 文档与路径判断。

## 关键导出

- `writeFileAtomic`：临时文件落盘后改名；Windows 上对占用错误退避重试
- `ensureDir`、`sha256File`
- `createJsonDocument`：zod 校验；损坏文件改名 `.corrupt-<时间戳>` 后回退默认值
- `isInside`：纯字符串路径包含判断，不解析符号链接

## 约束

路径来自 `@poietica/runtime-layout` 的 `DataLayout`；JSON 持久化统一走 `createJsonDocument`。

数据归属见 [架构文档 §7](../../docs/ARCHITECTURE.md#7-数据与存储)。
