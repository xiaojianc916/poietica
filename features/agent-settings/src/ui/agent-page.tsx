import { ErrorState, LoadingState, SettingRow, SettingsGroup, SettingsPage } from '@poietica/design-system'
import { type ReactElement, useCallback, useEffect, useState } from 'react'
import type { SettingDescriptor, SettingGroup } from '../contract'
import type { AgentSettingsApi } from './api'
import { SettingControl } from './setting-control'
import { isVisible, type SettingLookup } from './settings-conditions'

/*
 * “Agent”页：按分组渲染 descriptor，整页由引擎报的目录生成，这里没有一行 per-setting 的表单代码
 * （07 页 §7.2：以后开放一个新设置项，只需要在 engine-omp 的 settings-catalog.ts 里加一条）。
 *
 * **迁移自** legacy \`packages/settings/src/ui/agent-settings/agent-settings.tsx\` +
 * \`catalog-rows.tsx\`：空态与失败态的判据（「目录还没读到」与「读到空」是两件事）、
 * 「行由 SettingRow 承担、控件不重复排版」的分工、按 group 分节画法，全部照旧。
 *
 * 两处随新架构收敛（不是省略，是搬了家）：
 *   - **分节**：legacy 在客户端按 \`entry.group\` 归并（catalog-rows 的 groupBy）；新架构按
 *     07 页 §7C 把归并放进 Core，\`agentSettings.catalog\` 直接交回 \`{groups}\`，次序取
 *     engine-omp 的 SETTING_GROUPS；
 *   - **可见性**：legacy 的 settings-conditions（\`owned\` 与 \`condition\`）也搬进了 Core ——
 *     engine-omp 的 isProductSetting 已经把「产品别处有控件」和「与这台桌面软件无关」两类滤掉。
 */

export function AgentPage({
  api,
  section,
}: {
  readonly api: AgentSettingsApi
  /** 这一页画哪一段：记忆 / 个性化（legacy 的 memory / persona 两页共用一个目录） */
  readonly section: 'memory' | 'persona'
}): ReactElement {
  const [groups, setGroups] = useState<readonly SettingGroup[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api.catalog()
      setGroups(r.groups)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  // 引擎侧设置变化（别的控件、别的进程）时重新拉目录
  useEffect(() => api.onChanged(() => void load()).dispose, [api, load])

  const write = useCallback(
    (path: string, value: unknown) => {
      setSaving(path)
      void api
        .set(path, value)
        .then(() => load())
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : String(e))
        })
        .finally(() => {
          setSaving(null)
        })
    },
    [api, load],
  )

  /* 本页要画的那几组：归属 → owned → 条件，三件事各走一遍（见 visibleGroups）。 */
  const shown = groups === null ? [] : visibleGroups(groups, section)

  if (groups === null) {
    return (
      <SettingsPage>
        {error === null ? (
          <div className="settings-state">
            <LoadingState label="正在读取 agent 自己的设置…" />
          </div>
        ) : (
          <div className="settings-state">
            <ErrorState message={error} onRetry={() => void load()} />
          </div>
        )}
      </SettingsPage>
    )
  }

  return (
    <SettingsPage>
      {error === null ? null : (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}

      {shown.map((group) => (
        <SettingsGroup key={group.id} title={group.label}>
          {group.settings.map((descriptor: SettingDescriptor) => (
            <SettingRow
              description={descriptor.description}
              key={descriptor.path}
              label={descriptor.label}
              warning={descriptor.warning ?? undefined}
            >
              <SettingControl
                entry={descriptor}
                onChange={(value) => {
                  write(descriptor.path, value)
                }}
                saving={saving === descriptor.path}
              />
            </SettingRow>
          ))}
        </SettingsGroup>
      ))}

      {/* 空态是防御性的：目录还没读到（上面的加载态）与读到空是两件事 */}
      {shown.length === 0 ? (
        <SettingsGroup>
          <SettingRow description="agent 没有报出这一类设置" label="无可显示的项" />
        </SettingsGroup>
      ) : null}
    </SettingsPage>
  )
}

/**
 * 本页要画的那几组。
 *
 * 三件事在这里各走一遍，**顺序有味**：
 *
 * 1. 只留**归属本页**的格子（`section`，产地是引擎端口 —— 记忆按 omp 自己的 tab 判、
 *    个性化按 path 名单判）。归属是**引擎报的**，不是这里猜的：上一版按组名里的关键词猜，
 *    而组名已经是中文（「提示词」「思考」），一个都匹配不上，于是个性化页永远空白、
 *    记忆页把整份目录都画了出来。
 * 2. 滤掉 `owned` 的：它的**行**由产品别处的控件负责，画第二遍就是一个事实两个控件。
 *    值仍在目录里，别的格子按 `condition` 读它。
 * 3. 滤掉条件不成立的。判据要用**整份目录**里此刻的值（`hindsightActive` 要读
 *    `memory.backend`），所以收的是整份目录而不是筛完的那一段。
 *
 * 一组里所有行都被滤掉时，那一组整个不画 —— 空标题下面什么都没有只是在说「这里本来有话」。
 */
function visibleGroups(groups: readonly SettingGroup[], section: 'memory' | 'persona'): readonly SettingGroup[] {
  const at = settingLookup(groups)
  const out: SettingGroup[] = []
  for (const group of groups) {
    const settings = group.settings.filter(
      (descriptor) => descriptor.section === section && !descriptor.owned && isVisible(descriptor.condition, at),
    )
    if (settings.length > 0) out.push({ ...group, settings })
  }
  return out
}

/** 目录里按路径取此刻的值；只有非凭据的格子有值（凭据的 value 恒为 null）。 */
function settingLookup(groups: readonly SettingGroup[]): SettingLookup {
  const byPath = new Map<string, unknown>()
  for (const group of groups) for (const s of group.settings) byPath.set(s.path, s.value)
  return (path) => byPath.get(path)
}
