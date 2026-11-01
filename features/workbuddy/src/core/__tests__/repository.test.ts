import { describe, expect, test } from 'bun:test'
import { openDatabase } from '@poietica/storage-sqlite'
import { migrations } from '../migrations'
import { createWorkBuddyRepository } from '../repository'

function repository() {
  const db = openDatabase(':memory:')
  const moduleDb = db.forModule('workbuddy')
  for (const migration of migrations) moduleDb.exec(migration.sql)
  return { db, repo: createWorkBuddyRepository(moduleDb) }
}

describe('WorkBuddy 账号仓储', () => {
  test('账号、令牌、积分与签到各存一处，设置按 key 读写', () => {
    const { db, repo } = repository()
    repo.insert({
      id: 'a1',
      label: '稻黄草',
      authType: 'oauth',
      access: 'access-1',
      refresh: 'refresh-1',
      expires: 100,
      refreshExpiresAt: 200,
      uid: 'u1',
      domain: 'cn',
      tokenType: 'Bearer',
      enterpriseId: '',
      apiKey: '',
      plan: 'Free plan',
      status: 'ok',
      statusMessage: null,
      usageJson: null,
      usageAt: null,
      checkin: null,
      createdAt: 10,
      updatedAt: 10,
    })

    expect(repo.get('a1')).toMatchObject({ label: '稻黄草', authType: 'oauth', uid: 'u1' })
    expect(repo.findByIdentity('u1', '稻黄草')?.id).toBe('a1')

    repo.updateAuth(
      'a1',
      {
        authType: 'oauth',
        access: 'access-2',
        refresh: 'refresh-2',
        expires: 300,
        refreshExpiresAt: 400,
        uid: 'u1',
        domain: 'cn',
        tokenType: 'Bearer',
        enterpriseId: 'ent',
        apiKey: '',
      },
      20,
    )
    expect(repo.get('a1')?.access).toBe('access-2')
    expect(repo.get('a1')?.enterpriseId).toBe('ent')

    repo.updateUsage('a1', 'Pro', '{"plan":"Pro","windows":[],"signIn":null,"error":null}', 30, 30)
    expect(repo.get('a1')).toMatchObject({ plan: 'Pro', usageAt: 30 })

    repo.updateCheckin(
      'a1',
      {
        day: '2026-11-01',
        at: 40,
        outcome: 'claimed',
        message: null,
        credit: 5,
        streak: 2,
      },
      40,
    )
    expect(repo.get('a1')?.checkin).toEqual({
      day: '2026-11-01',
      at: 40,
      outcome: 'claimed',
      message: null,
      credit: 5,
      streak: 2,
    })

    repo.setStatus('a1', 'expired', '重新登录', 50)
    expect(repo.get('a1')).toMatchObject({ status: 'expired', statusMessage: '重新登录' })

    repo.setSetting('proxy_enabled', '1')
    repo.setSetting('proxy_enabled', '0')
    expect(repo.settings()).toEqual({ proxy_enabled: '0' })

    repo.remove('a1')
    expect(repo.get('a1')).toBeNull()
    db.close()
  })
})
