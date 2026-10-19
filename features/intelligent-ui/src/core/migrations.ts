import type { Migration } from '@poietica/storage-sqlite'

/*
 * 界面状态按（线程, 工具调用）各一行。没有外键：线程删除走 conversation 的 threadRemoved 事件清账。
 *
 * `model_revision` 只在 model 那一半变了时加一；`delivered_revision` 是最后一次随用户的话交给模型时的那一版。
 * 两者不等 = 这份状态还没交给模型。只动 view（界面自己恢复用）不会让模型再看一遍同样的东西。
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `CREATE TABLE intelligent_ui_states (
  thread_id          TEXT NOT NULL,
  call_id            TEXT NOT NULL,
  title              TEXT NOT NULL,
  model_json         TEXT,
  view_json          TEXT,
  model_revision     INTEGER NOT NULL,
  delivered_revision INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (thread_id, call_id)
);`,
  },
]
