# ADR-012：模块类型、描述符与设置注册表

状态：P6c 已实施；模块描述符已生成并在启动时校验。timeline / threads / runs / composer 均为独立 feature；conversation 只保留组合根、RPC handlers 与装配；`ui/shared` 下沉为 `conversation-kit` 包。

背景：功能切片是唯一主轴，领域、运行时、界面、集成混在一个目录；设置分散且有影子副本。

决策：

- 模块按 domain / capability / agent-runtime / agent-tool / integration / surface 分类，每模块只有一种类型。
- 每个模块一份声明式描述符：类型、进程、RPC/通知、事件、表、设置项、UI 点、依赖。
- 从描述符生成协议契约、三进程装配清单、依赖层级与 TS references；人工清单只保留生成入口。
- 设置统一 schema（zod）、多后端、优先级：管理员强制 > Thread > 项目 > 用户 > 默认。
- omp 自有设置直接读写 omp 配置，不建影子副本；凭据走系统凭据库。

后果：

- 加一个功能 = 加一个目录 + 描述符，不再改多份手工清单。
- 迁移期保留合并外观，全部切完再删。

## 实施进度（2026-11-15）

- `tooling/assembly/core-modules.ts` 从 `features/<id>/package.json` 的 `poietica.kind`、`feature-tiers.json` 的级别与 `exports` 生成 `featureDescriptors`；`coreModules` 改为从描述符派生，不再另维护一份列表。
- 描述符在 Core 启动时校验：每个模块必须有且只指向自己的实现；依赖的 tier 必须严格更低；数量必须与模块清单一致。
- 仍没有把 RPC/事件/表/设置项/UI 贡献点全部收进描述符；这些仍由契约、模块代码与生成清单各自表达。

## 实施进度（2026-11-15 续）

- 描述符增加 `processes`（从功能包的 `./core`/`./host`/`./ui` 导出推导）；Core 启动校验模块声明了 `core` 进程。
- 运行时可核对视图：RPC 方法与通知来自契约，表来自迁移的 `CREATE TABLE`，事件与设置项来自模块的 `events` / `settings` 声明；`CoreKernel.descriptors` 暴露合成结果。
- `events` / `settings` 目前只有 conversation 与 policy 声明；UI 贡献点仍由 `UiFeature` 在渲染进程运行时注册，尚未进入描述符。
- preferences / agent-settings / models / python 的旧存储仍未迁入统一注册表；当前只有 policy 通过注册表读写 `policy.preset`。
