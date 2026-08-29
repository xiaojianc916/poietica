# 命名与常量

## 三条硬规则

1. **目录名说能力，文件名说事实。** 看到名字知道它干什么，不靠打开看。
2. **禁技术种类名与万能桶名。** 清单在 `tools/architecture/layering.ts` 的 `FORBIDDEN_DIRECTORY_NAMES`（`utils`/`common`/`helpers`/`types`/`services`/`managers`/`core`/`lib`/`state`/`stores`/`components`/`ports`/`domain`/`application`/`presentation` 等）。要扩展清单就改那里。
3. **禁时间性命名。** `legacy` / `v2` / `new` / `old` / `*2` 一律不许。改名与换实现必须同一次改动完成，不留旧名转发层。

## 常量单一产地

跨语言不得不复制时（如 `IMAGE_OPENER`），**拷贝处必须注明正本的当前路径**；正本移动，拷贝注释必须跟着改。生成物（`packages/contract/src/generated/`、`crates/kap-client/src/generated/`）不手改。

## Debug 不打载荷

任何可能携带大字节或密钥的类型，`Debug` 手写或字段跳过；脱敏收在一张表里。

## 注释纪律

- 只解释**当前代码为什么这样**。无现时论据的纯历史一律删；保留历史仅当它是当前形态的直接论据（"不是 X，因为 X 试过且以某种方式坏了"）。
- 指名道姓给**当前**路径：引用标杆、引用本仓判例都要能被 grep 到。文件移动/拆分时，指向它的注释锚点必须同步更新。
- 外部行为断言注明**来源与日期**。
- 注释与代码矛盾按缺陷处理：改注释或改代码，不许并存。
- **注释必须凝练简短。** 长篇大论的注释本身就是错误示范。
