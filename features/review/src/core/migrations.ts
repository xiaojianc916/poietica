import type { Migration } from '@poietica/storage-sqlite'

/**
 * 当前 schema（一条 init 建完）。
 *
 * review_turn_files 是「一轮改过哪些文件」的账本，事实只在写的那一刻存在：引擎在工具写盘时
 * 报出写前写后的正文（conversation 的 turnFileChanged），此后工作区里只剩新内容，谁事后去读都
 * 拿不回旧的那一份。所以撤销一轮要的 before/after 必须在这里存下来，而不是撤销时再去推。
 *
 * 一行是（线程, 轮, 路径）的一次写入：
 * - before / after 都是可空 TEXT，null 各有一层意思 —— before 为 null 表示写之前这个文件不存在
 *   （撤销就是删掉），after 为 null 表示这一笔把它删了（撤销就是把 before 写回来）。两者都不能存成
 *   空串：那会把文件写成空文件；
 * - state 记这一轮是否已经撤销过。撤销以轮为单位整批退，所以同轮的每一行一起翻成 reverted；
 *   行数不在表里 —— 加减行数由 before/after 现算（@poietica/design-system/diff 的 computeFile），
 *   同一轮同一文件改多次时，最初 before 与最终 after 一比就是这一轮真正的增减；
 * - 不挂外键：线程删除走 conversation 的 threadRemoved 事件清账（库里的线程行归 conversation，
 *   本功能不引它的表）。
 *
 * 主键 (thread_id, turn, path) 就是查与合并的形状：同一轮同一文件的重复写入落成同一行；
 * 索引 (thread_id, turn) 供「这一轮的全部文件」与整页读取。
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `CREATE TABLE review_turn_files (
  thread_id  TEXT NOT NULL,
  turn       INTEGER NOT NULL,
  path       TEXT NOT NULL,
  before     TEXT,
  after      TEXT,
  state      TEXT NOT NULL CHECK (state IN ('applied', 'reverted')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, turn, path)
);
CREATE INDEX review_turn_files_by_turn ON review_turn_files (thread_id, turn);`,
  },
]
