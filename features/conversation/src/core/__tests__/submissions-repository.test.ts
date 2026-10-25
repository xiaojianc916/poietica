import { describe, expect, test } from 'bun:test'
import { openDatabase } from '@poietica/storage-sqlite'
import { migrations } from '../migrations'
import { createThreadsRepository } from '../repository'
import { createSubmissionsRepository, type SubmissionRow } from '../submissions-repository'

/* 提交仓储的写法（数据库性能方案 D2）：update 一条语句改完带回新行、failUndelivered 一条语句收完、取号表只读两列走部分索引。 */
function fresh() {
  const db = openDatabase(':memory:')
  const mdb = db.forModule('conversation')
  for (const m of migrations) mdb.exec(m.sql)
  const threads = createThreadsRepository(mdb)
  for (const id of ['th-1', 'th-2'])
    threads.insert({
      id,
      workspaceId: 'ws',
      title: id,
      titleSource: 'auto',
      posture: 'default' as never,
      origin: 'user',
      sessionId: null,
      sessionFile: null,
      forkedFrom: null,
      pinned: false,
      archived: false,
      initialModel: null,
      initialThinking: null,
      createdAt: 0,
      updatedAt: 0,
    })
  return { db, repo: createSubmissionsRepository(mdb) }
}

function row(clientTurnId: string, patch: Partial<SubmissionRow> = {}): SubmissionRow {
  return {
    clientTurnId,
    threadId: 'th-1',
    text: `text of ${clientTurnId}`,
    attachments: [{ id: 'a1', name: 'x.png', kind: 'image', mime: 'image/png', size: 1 } as never],
    skills: ['s1'],
    requestedAs: 'turn',
    status: 'pending',
    turnId: null,
    error: null,
    rev: 1,
    createdAt: 10,
    updatedAt: 10,
    ...patch,
  }
}

describe('update：一条语句改完并带回新行', () => {
  test('只改给了的列，rev 自增；其余列原样带回', () => {
    const { db, repo } = fresh()
    repo.insert(row('c1', { error: { code: 'e', message: 'm' } }))

    const next = repo.update('c1', { status: 'started', turnId: 't1' })
    expect(next).toEqual(row('c1', { status: 'started', turnId: 't1', error: { code: 'e', message: 'm' }, rev: 2 }))
    expect(repo.get('c1')).toEqual(next)

    /* 显式的 null 是「清掉」，不是「不改」 */
    expect(repo.update('c1', { status: 'pending', turnId: null, error: null })).toEqual(
      row('c1', { status: 'pending', rev: 3 }),
    )
    expect(repo.update('c1', { status: 'failed', error: { code: 'x', message: 'y' } })?.error).toEqual({
      code: 'x',
      message: 'y',
    })
    db.close()
  })

  test('行不在：null，也不会凭空插一行', () => {
    const { db, repo } = fresh()
    expect(repo.update('nope', { status: 'started' })).toBeNull()
    expect(repo.get('nope')).toBeNull()
    db.close()
  })
})

describe('failUndelivered：一条语句收完', () => {
  test('只收 pending / queued，按创建先后返回，rev 各自 +1', () => {
    const { db, repo } = fresh()
    repo.insert(row('c3', { createdAt: 30, status: 'queued', requestedAs: 'followUp' }))
    repo.insert(row('c1', { createdAt: 10 }))
    repo.insert(row('c2', { createdAt: 20, status: 'started', turnId: 't1' }))
    repo.insert(row('c0', { createdAt: 30, threadId: 'th-2' }))
    repo.insert(row('c4', { createdAt: 40, status: 'failed', error: { code: 'old', message: 'old' } }))

    const error = { code: 'conversation.core_restarted', message: 'restarted' }
    const failed = repo.failUndelivered(error)
    expect(failed.map((r) => r.clientTurnId)).toEqual(['c1', 'c0', 'c3'])
    for (const r of failed) {
      expect(r.status).toBe('failed')
      expect(r.error).toEqual(error)
      expect(r.rev).toBe(2)
      expect(repo.get(r.clientTurnId)).toEqual(r)
    }
    expect(repo.get('c2')?.status).toBe('started')
    expect(repo.get('c4')?.error).toEqual({ code: 'old', message: 'old' })
    expect(repo.failUndelivered(error)).toEqual([])
    db.close()
  })
})

describe('取号表与认号', () => {
  test('mapByTurnId 只收本线程、已经开出轮的行', () => {
    const { db, repo } = fresh()
    repo.insert(row('c1', { status: 'started', turnId: 't1' }))
    repo.insert(row('c2', { status: 'started', turnId: 't2' }))
    repo.insert(row('c3'))
    repo.insert(row('c4', { threadId: 'th-2', status: 'started', turnId: 't1' }))

    expect([...repo.mapByTurnId('th-1')].sort()).toEqual([
      ['t1', 'c1'],
      ['t2', 'c2'],
    ])
    expect([...repo.mapByTurnId('th-2')]).toEqual([['t1', 'c4']])
    expect(repo.findByTurnId('th-2', 't1')?.clientTurnId).toBe('c4')
    expect(repo.findByTurnId('th-1', 't9')).toBeNull()
    db.close()
  })

  test('两条查询都走部分索引：取号表不回表', () => {
    const { db } = fresh()
    const plan = (sql: string, ...params: string[]) =>
      (db.raw.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join(' | ')
    expect(
      plan(
        'SELECT turn_id, client_turn_id FROM conversation_submissions WHERE thread_id = ? AND turn_id IS NOT NULL',
        'th-1',
      ),
    ).toContain('COVERING INDEX conversation_submissions_by_turn')
    expect(
      plan('SELECT * FROM conversation_submissions WHERE thread_id = ? AND turn_id = ? LIMIT 1', 'th-1', 't1'),
    ).toContain('conversation_submissions_by_turn (thread_id=? AND turn_id=?)')
    db.close()
  })
})
