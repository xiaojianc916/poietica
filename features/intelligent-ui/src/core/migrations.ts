import type { Migration } from '@poietica/storage-sqlite'

/**
 * 当前 schema（一条 init 建完）。界面状态按（线程, 工具调用）各一行；没有外键：线程删除走 conversation 的
 * threadRemoved 事件清账。
 *
 * `model_revision` 在「交给模型的那几份」（model 与 tweaks）变了时加一；`delivered_revision` 是最后一次随用户的话
 * 交给模型时的那一版。两者不等 = 这份状态还没交给模型。只动 view（界面自己恢复用）不会让模型再看一遍同样的东西。
 *
 * `tweaks_json` 是用户在卡片「调整」面板里改过的值（只记与默认值不同的那些），与 model 同等：改了算新的一版，
 * 也随 model 一起交给模型。
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
  tweaks_json        TEXT,
  PRIMARY KEY (thread_id, call_id)
);`,
  },
]
