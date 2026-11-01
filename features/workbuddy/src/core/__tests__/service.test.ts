import { describe, expect, test } from 'bun:test'
import type { ModelsPort } from '@poietica/engine'
import { openDatabase } from '@poietica/storage-sqlite'
import { createTestLogger } from '@poietica/test-kit'
import { migrations } from '../migrations'
import { type AccountRecord, createWorkBuddyRepository } from '../repository'
import { createWorkBuddyService } from '../service'

const NOW = Date.UTC(2026, 10, 1, 4, 0, 0)

function seed(record: Partial<AccountRecord> = {}) {
  const db = openDatabase(':memory:')
  const moduleDb = db.forModule('workbuddy')
  for (const migration of migrations) moduleDb.exec(migration.sql)
  const repository = createWorkBuddyRepository(moduleDb)
  repository.insert({
    id: 'a1',
    label: '稻黄草',
    authType: 'oauth',
    access: 'access',
    refresh: 'refresh',
    expires: NOW + 60_000,
    refreshExpiresAt: NOW + 120_000,
    uid: 'u1',
    domain: 'cn',
    tokenType: 'Bearer',
    enterpriseId: '',
    apiKey: '',
    plan: 'Free plan',
    status: 'ok',
    statusMessage: null,
    usageJson: JSON.stringify({
      plan: 'Free plan',
      windows: [
        {
          name: 'Credits',
          used: 7.5,
          amount: 12,
          limit: 160,
          balance: null,
          unit: 'credits',
          display: '12 / 160',
          resetsAt: '2026-11-03T00:00:00.000Z',
          runsOutAt: null,
          span: null,
          models: null,
          refused: false,
        },
      ],
      signIn: 'kept',
      error: null,
    }),
    usageAt: NOW,
    checkin: { day: '2026-11-01', at: NOW, outcome: 'claimed', message: null, credit: 5, streak: 2 },
    createdAt: NOW,
    updatedAt: NOW,
    ...record,
  })
  const models = {
    providers: async () => [],
    upsertCustomProvider: async () => undefined,
    removeCustomProvider: async () => undefined,
  } as unknown as ModelsPort
  const service = createWorkBuddyService({
    repository,
    models,
    logger: createTestLogger(),
    now: () => NOW,
    openExternal: async () => undefined,
    emitChanged: () => undefined,
    emitLogin: () => undefined,
  })
  return { db, repository, service }
}

describe('WorkBuddy Core 服务', () => {
  test('快照把积分、套餐、首选与签到放在账号视图上', () => {
    const { db, repository, service } = seed()
    repository.setSetting('preferred_account_id', 'a1')
    const snapshot = service.snapshot()
    expect(snapshot.accounts[0]).toMatchObject({
      label: '稻黄草',
      plan: 'Free plan',
      preferred: true,
      checkedInToday: true,
      kind: 'browser',
    })
    expect(snapshot.accounts[0]?.usage?.windows[0]?.display).toBe('12 / 160')
    expect(snapshot.accounts[0]?.checkin?.credit).toBe(5)
    db.close()
  })

  test('移除首选后自动换下一个账号；没有账号时反代退回 missing', async () => {
    const { db, repository, service } = seed()
    repository.setSetting('preferred_account_id', 'a1')
    await service.removeAccount('a1')
    expect(service.snapshot().accounts).toEqual([])
    expect(service.snapshot().proxy.providerState).toBe('missing')
    db.close()
  })

  test('API Key 账号的签到是 ineligible，不调用上游', async () => {
    const { db, service } = seed({
      id: 'key',
      authType: 'api',
      access: 'ck_12345678',
      refresh: '',
      uid: 'anonymous_12345678',
      apiKey: 'ck_12345678',
      checkin: null,
    })
    const result = await service.checkin('key')
    expect(result).toMatchObject({ outcome: 'ineligible', message: 'API Key 账号不参与签到' })
    expect(service.snapshot().accounts[0]?.checkedInToday).toBe(false)
    db.close()
  })
})
