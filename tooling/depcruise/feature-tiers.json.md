# feature-tiers.json

L4（`features/*`）内部的分级。`layers.json` 只给 `packages/*` 定层，功能之间原先只约束「经哪种子入口协作」
（`feature-cross-impl`），**不约束方向**，于是出现过：

- 包级成环：conversation ⇄ attachments；platform → browser → conversation → platform；
- 同一对功能在不同进程里方向相反：Core 是 conversation → attachments（经 attachments 的 core-api），
  UI 是 attachments → conversation（实现 conversation 的 ui-api 里定义的入库口）；
- 最底层的功能认识插件：platform 为一个分区名依赖 browser 的 contract。

分级规则（`config.cjs` 的 `feature-tier:<id>`）：功能的产品代码只能依赖**级别严格更低**的功能（任何子入口都算，
contract 也算）；测试文件豁免（与其它层级规则同一条理由：模块测试要装上依赖功能的真实模块）。
三个进程共用同一张表，所以「谁依赖谁」在 Core / Host / UI 里一定同向。

| 级 | 名称 | 功能 | 说明 |
| --- | --- | --- | --- |
| 0 | 平台 | platform | 窗口、对话框、通知、存储页：任何功能都可能要，自己不认识任何功能 |
| 1 | 基础状态 | preferences、workspaces | 偏好与工作区 |
| 2 | 能力 | attachments、models | 附件库、模型目录：被主干与插件使用，不认识对话 |
| 3 | 主干 | conversation | 对话；留贡献点给插件 |
| 4 | 插件 | 其余 | 往主干的贡献点里贡献；插件之间互不依赖 |

新功能用 `bun run new:feature <id> --tier <n>` 登记（缺省 4）。改级别时先问「它下面的功能是否因此要认识它」——
答案是「要」，说明该下沉的是那份**事实**（例：分区名下沉到 runtime-layout），而不是把功能往下挪。
