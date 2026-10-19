# same-layer.json

03 页 §2.2 的「允许依赖」一栏点名了若干**同层**依赖边（L1→L1、L2→L2、L3→L3 各一条）。
P0.8 生成的 `layer-order` 规则按「依赖同层或更高层的包」禁用，会把这些设计上明确允许的边也拦下，
导致 P1 的验收（`bun run  all` 通过）不可能达成。本文件是这些边的白名单，除此以外同层依赖仍然报错。

白名单只收**同层**边：`config.cjs` 加载时校验每个条目两端层号相等，不相等直接报错。跨层向下的边本来就允许，
写进来不起作用；跨层向上的边写进来会被悄悄放行。曾经的 `core-kernel`（L3→L2）、`host-kernel`（L3→L2）两条
即属前者，已删。现存四条：

| 边 | 层 | 理由 |
| --- | --- | --- |
| engine → transcript | L1 | 引擎端口的事件流以 transcript 的 TimelineOp 为载荷 |
| rpc → contract-kit | L1 | 通道按契约描述做校验与分发 |
| git → process-kit | L2 | git 经 process-kit 起子进程 |
| engine-omp → engine-testkit | L3 | 只有 `src/testing`（`@poietica/engine-omp/testing`）用到，类型级 |
