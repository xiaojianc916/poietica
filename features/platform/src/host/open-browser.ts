export async function openExternal(shell: { openExternal(url: string): Promise<void> }, url: string): Promise<void> {
  await shell.openExternal(url)
}
