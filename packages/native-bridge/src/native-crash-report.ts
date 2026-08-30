import { commands, type NativeCrashReport as GeneratedNativeCrashReport } from '@poietica/contract'
import { throughIpc } from './error'

/**
 * Native crash report generated from the Rust IPC contract.
 *
 * The renderer must not redefine this DTO manually. Rust and
 * tauri-specta remain the source of truth for the boundary.
 */
export type NativeCrashReport = GeneratedNativeCrashReport

/**
 * Reads and consumes the previous native process crash report.
 *
 * The Native command removes a valid report after reading it, so a
 * renderer reload cannot repeatedly present the same historical crash.
 */
export function takePreviousNativeCrashReport(): Promise<NativeCrashReport | null> {
  return throughIpc(() => commands.diagnosticsTakePreviousCrash())
}
