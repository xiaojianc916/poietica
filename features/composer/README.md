# composer

输入框 surface：草稿、附件引用、队列、侧边提问与斜杠/工具名册。

- `src/ui`：编辑器、控件、待答卡片与草稿状态；`src/surface` 是给其它功能的唯一界面入口。
- `src/ui-api`：草稿/附件/贡献点形状，贡献点名以 `composer.*` 开头。
- tier 2：只依赖 `conversation-kit` 与基础包，不认识 conversation；conversation 通过 `surface` 组合它。
