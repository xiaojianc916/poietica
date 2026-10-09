# @poietica/protocol

全应用契约汇总：`appContract`（composeContracts 的产物，system 契约自动并入）与 `PROTOCOL_VERSION`。
Core 与 Host 是分别构建的两个产物，契约快照（`src/__tests__/contract.snapshot.json`）把“契约长什么样”
固定下来，任何改动都会在测试与代码审查中暴露。

**版本规则（05 页 §8 / §13.6）**：任何契约形状变化都要把 `PROTOCOL_VERSION` 加 1，并重新生成快照；
Host 与 Core 总是一起发布，版本号只用来发现安装损坏或忘了重建 Core。

详见架构文档 06 页 §6。
