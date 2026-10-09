import { describe, expect, test } from 'bun:test'
import { dataLayout, resolveDataRoot } from '../data-layout'

const ROOT = 'C:\\Users\\a\\AppData\\Roaming\\Poietica'

describe('dataLayout', () => {
  // RL-1：19 个字段与 08 页 §1 的布局逐一相等（快照）；返回对象被冻结
  test('RL-1 与数据根布局逐一相等', () => {
    expect(dataLayout(ROOT)).toMatchInlineSnapshot(`
      {
        "attachmentsDir": "C:\\Users\\a\\AppData\\Roaming\\Poietica\\attachments",
        "chromiumSessionDir": "C:\\Users\\a\\AppData\\Roaming\\Poietica\\session",
        "coreCwd": "C:\\Users\\a\\AppData\\Roaming\\Poietica\\core\\cwd",
        "coreDir": "C:\\Users\\a\\AppData\\Roaming\\Poietica\\core",
        "coreLog": "C:\\Users\\a\\AppData\\Roaming\\Poietica\\logs\\core.log",
        "dbFile": "C:\\Users\\a\\AppData\\Roaming\\Poietica\\core\\poietica.db",
        "keymapFile": "C:\\Users\\a\\AppData\\Roaming\\Poietica\\keymap.json",
        "logsDir": "C:\\Users\\a\\AppData\\Roaming\\Poietica\\logs",
        "mainLog": "C:\\Users\\a\\AppData\\Roaming\\Poietica\\logs\\main.log",
        "nativeHomeDir": "C:\\Users\\a\\AppData\\Roaming\\Poietica\\native-home",
        "ompAgentDir": "C:\\Users\\a\\AppData\\Roaming\\Poietica\\omp\\agent",
        "ompRoot": "C:\\Users\\a\\AppData\\Roaming\\Poietica\\omp",
        "preferencesFile": "C:\\Users\\a\\AppData\\Roaming\\Poietica\\preferences.json",
        "pythonDir": "C:\\Users\\a\\AppData\\Roaming\\Poietica\\tools\\python",
        "root": "C:\\Users\\a\\AppData\\Roaming\\Poietica",
        "scratchDir": "C:\\Users\\a\\AppData\\Roaming\\Poietica\\scratch",
        "toolsDir": "C:\\Users\\a\\AppData\\Roaming\\Poietica\\tools",
        "uiStateFile": "C:\\Users\\a\\AppData\\Roaming\\Poietica\\ui-state.json",
        "windowStateFile": "C:\\Users\\a\\AppData\\Roaming\\Poietica\\window-state.json",
      }
    `)
  })

  test('RL-1 返回对象被冻结', () => {
    const layout = dataLayout(ROOT)
    expect(Object.isFrozen(layout)).toBe(true)
    expect(() => {
      /* 运行时写入只读对象（对象已冻结）：用一次未知类型视图，不用抑制注释（铁律 3）。 */
      ;(layout as unknown as { root: string }).root = 'C:\\other'
    }).toThrow()
  })

  // RL-2：相对路径抛错
  test('RL-2 相对路径抛错', () => {
    expect(() => dataLayout('relative')).toThrow('数据根必须是绝对路径：relative')
  })
})

describe('resolveDataRoot', () => {
  // RL-3：安装版忽略 override；开发版有 override 用 override；开发版无 override → …\\Poietica Dev
  test('RL-3 安装版忽略 override', () => {
    expect(
      resolveDataRoot({ isPackaged: true, appDataDir: 'C:\\Users\\a\\AppData\\Roaming', override: 'C:\\tmp\\smoke' }),
    ).toBe('C:\\Users\\a\\AppData\\Roaming\\Poietica')
  })

  test('RL-3 开发版用 override', () => {
    expect(
      resolveDataRoot({ isPackaged: false, appDataDir: 'C:\\Users\\a\\AppData\\Roaming', override: 'C:\\tmp\\smoke' }),
    ).toBe('C:\\tmp\\smoke')
  })

  test('RL-3 开发版无 override → Poietica Dev', () => {
    expect(resolveDataRoot({ isPackaged: false, appDataDir: 'C:\\Users\\a\\AppData\\Roaming', override: null })).toBe(
      'C:\\Users\\a\\AppData\\Roaming\\Poietica Dev',
    )
  })

  test('RL-3 空字符串 override 视为 null', () => {
    expect(resolveDataRoot({ isPackaged: false, appDataDir: 'C:\\Users\\a\\AppData\\Roaming', override: '' })).toBe(
      'C:\\Users\\a\\AppData\\Roaming\\Poietica Dev',
    )
  })
})
