# kap 契约快照

`openapi.json` 与 `asyncapi.json` 由运行中的 `kimi web` 导出并入库。
Rust 客户端类型从这里生成，不得手写。

    pnpm kap:spec         # 刷新快照
    pnpm kap:spec:check   # 漂移检测，CI 用

快照变动必须与生成代码在同一个提交里。
