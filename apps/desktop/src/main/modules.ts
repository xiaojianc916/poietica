import attachments from '@poietica/feature-attachments/host'
import browser from '@poietica/feature-browser/host'
import platform from '@poietica/feature-platform/host'
import preferences from '@poietica/feature-preferences/host'
import terminal from '@poietica/feature-terminal/host'
import update from '@poietica/feature-update/host'
import type { HostModule } from '@poietica/host-kernel'

/**
 * Host 的功能模块清单。顺序无关（内核按 dependsOn 拓扑排序）。
 * Host 模块之间没有 dependsOn（07 页 §0.1）。
 */
export const hostModules: readonly HostModule[] = [platform, preferences, attachments, terminal, browser, update]
