# Tests

测试就近放在它所断言的东西旁边。仓库根目录的 `tests/` 只留一样东西：
**跨包的、没有任何单个包能独自持有的仓库级不变量。**

## 目录约定

- 各包内 `src/__tests__/`：该包自己的单元测试与契约测试。断言谁的行为，
  就住在谁的包里 —— 它随包一起被移动、被改名、被删除。
- `tools/architecture/`：全部架构规则的唯一产地（`layering.ts` 是判据数据，
  `policies.ts` 是规则，`verify.ts` 是入口）。加一条规则等于加一个函数。
- `tests/integration/`：跨包不变量。`tests/perf/`：基准，只报数字不设时限。

架构规则不写成 `.test.ts`：它要遍历整个仓库，而一个 `it` 的失败面只有一条断言。
规则进 `policies.ts`，由 `bun run test:architecture` 执行。

## 质量规则

- 测试名称描述长期行为或契约，不描述某一次修复或 Issue。
- 每个测试必须验证可观察结果、错误边界或不变量；禁止只验证 mock 调用而忽略结果。
- fixture 必须保留测试输入，禁止用 `void input` 丢弃参数后返回固定值。
- 失败、回滚、取消和恢复路径应与正常路径同等重要。
- 新增测试前先判断现有测试文件是否已覆盖同一长期契约；优先扩展现有测试，
  而不是创建一次性回归文件。

## 运行

```bash
bun run test                     # 全部工作区的 test 任务
bun run test:architecture        # 架构规则闸门
bun run --filter @poietica/design-system test
bun run --filter @poietica/tests test
```
