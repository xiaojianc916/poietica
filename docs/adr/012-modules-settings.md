# ADR-012：模块类型、描述符与设置注册表

状态：部分实施（P6）：模块类型、三进程清单与契约汇总已由目录生成；timeline 已抽为独立 feature，threads / runs / composer 仍留在 conversation。

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
