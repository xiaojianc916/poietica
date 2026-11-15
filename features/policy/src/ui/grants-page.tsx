import { Banner, Button, SettingsGroup, SettingsPage } from '@poietica/design-system'
import type { TypedRpcClient } from '@poietica/rpc'
import { useCallback, useEffect, useState } from 'react'
import type { PolicyGrant, policyContract } from '../contract'
import './grants.css'

function expiryOf(at: number): string {
  return new Date(at).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function PolicyGrantsPage({ policy }: { readonly policy: TypedRpcClient<typeof policyContract> }) {
  const [grants, setGrants] = useState<readonly PolicyGrant[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [revoked, setRevoked] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  /*
   * 只读列表、只管列表：它**不**顺手清 failure —— 撤销一条已经不存在的记录时正要靠那条说明
   * 告诉用户「它已经没了」，刷新一次就把它抹掉等于什么都没说。清提示由发起动作的那一侧负责。
   */
  const load = useCallback(async (): Promise<void> => {
    const result = await policy.call('policy.grants.list', {})
    setGrants(result.grants)
  }, [policy])

  useEffect(() => {
    let live = true
    void load().catch((cause: unknown) => {
      if (live) setFailure(reasonOf(cause))
    })
    return () => {
      live = false
    }
  }, [load])

  const revoke = async (grant: PolicyGrant): Promise<void> => {
    setBusy(grant.id)
    setRevoked(null)
    setFailure(null)
    try {
      const result = await policy.call('policy.grants.revoke', { grantId: grant.id })
      if (!result.revoked) {
        setFailure('这条授权已经不存在了；列表已刷新。')
      } else {
        setRevoked(grant.toolName)
      }
      await load()
    } catch (cause) {
      setFailure(`撤销失败：${reasonOf(cause)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsPage>
      <SettingsGroup>
        {failure === null ? null : (
          <Banner
            onDone={() => {
              setFailure(null)
            }}
            text={`授权记录读取失败：${failure}`}
            tone="error"
          />
        )}
        {revoked === null ? null : (
          <Banner
            onDone={() => {
              setRevoked(null)
            }}
            text={`已撤销 ${revoked} 的放行；下次执行会重新询问。`}
            tone="success"
          />
        )}

        {grants === null ? (
          <p className="policy-grants__empty">正在读取…</p>
        ) : grants.length === 0 ? (
          <p className="policy-grants__empty">没有生效中的放行记录</p>
        ) : (
          <ul className="policy-grants">
            {grants.map((grant) => (
              <li className="policy-grants__row" key={grant.id}>
                <div className="policy-grants__copy">
                  <code className="policy-grants__tool">{grant.toolName}</code>
                  <span className="policy-grants__meta">
                    会话 {grant.sessionKey.slice(0, 12)} · 到期 {expiryOf(grant.expiresAt)}
                  </span>
                </div>
                <Button
                  disabled={busy === grant.id}
                  onClick={() => {
                    void revoke(grant)
                  }}
                  size="xs"
                  variant="dangerSoft"
                >
                  {busy === grant.id ? '撤销中…' : '撤销'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>
    </SettingsPage>
  )
}
