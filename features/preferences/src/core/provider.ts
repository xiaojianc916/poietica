import type { HostCaller } from '@poietica/core-kernel'
import type { PreferencesPatch } from '@poietica/feature-preferences/contract'
import { Preferences } from '@poietica/feature-preferences/contract'
import type { SettingView } from '@poietica/feature-settings/contract'
import type { SettingsProvider } from '@poietica/feature-settings/core-api'
import { AppError } from '@poietica/foundation'
import { preferencesContract } from '../contract'

type Field = {
  readonly path: string
  readonly label: string
  readonly description: string
  readonly type: SettingView['definition']['type']
  readonly options?: readonly { readonly value: string; readonly label: string }[]
}

const FIELDS: readonly Field[] = [
  {
    path: 'theme',
    label: '主题',
    description: '跟随系统或固定深浅色',
    type: 'select',
    options: [
      { value: 'system', label: '跟随系统' },
      { value: 'light', label: '浅色' },
      { value: 'dark', label: '深色' },
    ],
  },
  {
    path: 'language',
    label: '界面语言',
    description: '界面文案语言',
    type: 'select',
    options: [
      { value: 'zh-CN', label: '简体中文' },
      { value: 'en', label: 'English' },
    ],
  },
  {
    path: 'logLevel',
    label: '日志级别',
    description: '写入应用日志的最低级别',
    type: 'select',
    options: [
      { value: 'debug', label: 'Debug' },
      { value: 'info', label: 'Info' },
      { value: 'warn', label: 'Warn' },
      { value: 'error', label: 'Error' },
    ],
  },
  { path: 'general.sendWithModifier', label: '用快捷键发送', description: '发送前需要按修饰键', type: 'boolean' },
  { path: 'general.confirmBeforeDelete', label: '删除前确认', description: '删除对话/工作区前询问', type: 'boolean' },
  { path: 'general.notifyOnCompletion', label: '完成后通知', description: '长任务完成时发系统通知', type: 'boolean' },
  {
    path: 'appearance.density',
    label: '界面密度',
    description: '列表与消息的间距',
    type: 'select',
    options: [
      { value: 'comfortable', label: '舒适' },
      { value: 'compact', label: '紧凑' },
    ],
  },
  { path: 'appearance.reduceMotion', label: '减少动效', description: '关掉非必要动画', type: 'boolean' },
  { path: 'appearance.messageTimestamps', label: '显示消息时间', description: '在消息旁显示时间', type: 'boolean' },
  { path: 'modelPicker.hiddenModels', label: '隐藏的模型', description: '模型选择器里不显示的模型', type: 'json' },
  { path: 'modelPicker.providerOrder', label: '供应商顺序', description: '模型选择器里的供应商排序', type: 'json' },
  { path: 'updates.autoCheck', label: '自动检查更新', description: '启动后检查新版本', type: 'boolean' },
]

const readPath = (value: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((current, key) => {
    if (typeof current !== 'object' || current === null) return undefined
    return (current as Record<string, unknown>)[key]
  }, value)

const writePatch = (path: string, value: unknown): PreferencesPatch => {
  const [head, tail] = path.split('.')
  if (head === undefined) throw new AppError('settings.invalid_key', '设置路径不能为空')
  if (tail === undefined) return { [head]: value } as PreferencesPatch
  return { [head]: { [tail]: value } } as PreferencesPatch
}

/** Host preferences 的注册表后端：值仍在 preferences.json，不复制到 Core DB。 */
export function createPreferencesProvider(host: HostCaller): SettingsProvider {
  return {
    id: 'preferences',
    owns: (key) => key.startsWith('prefs.'),
    async describe() {
      const current = await host.call(preferencesContract, 'prefs.get', {})
      const defaults = Preferences.parse({})
      return FIELDS.map((field): SettingView => {
        const value = readPath(current, field.path)
        const defaultValue = readPath(defaults, field.path)
        return {
          definition: {
            key: `prefs.${field.path}`,
            label: field.label,
            description: field.description,
            type: field.type,
            scopes: ['global'],
            defaultValue,
            ...(field.options === undefined ? {} : { options: [...field.options] }),
            sensitive: false,
            restart: false,
          },
          value,
          source: JSON.stringify(value) === JSON.stringify(defaultValue) ? 'default' : 'global',
          configured: JSON.stringify(value) !== JSON.stringify(defaultValue),
        }
      })
    },
    async set(input) {
      if (input.scope !== 'global') throw new AppError('settings.invalid_scope', 'preferences 只支持 global 作用域')
      const path = input.key.slice('prefs.'.length)
      await host.call(preferencesContract, 'prefs.update', { patch: writePatch(path, input.value) })
    },
  }
}
