import { mkdir } from 'node:fs/promises'

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}
