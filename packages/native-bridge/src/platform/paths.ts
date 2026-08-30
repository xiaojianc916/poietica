/*
 * 平台路径事实的唯一出口：主目录与文件名都问官方能力，不手写 %USERPROFILE%
 * / $HOME 猜测 —— 各自的边界情况是平台已经解决的问题。
 *
 * 动态 import：非 Tauri 宿主里答案是 null / 原样路径，调用方自己回落。
 */

export async function homeDirectory(): Promise<string> {
  const { homeDir } = await import('@tauri-apps/api/path')

  return homeDir()
}

export async function basename(path: string): Promise<string> {
  const { basename } = await import('@tauri-apps/api/path')

  return basename(path)
}
