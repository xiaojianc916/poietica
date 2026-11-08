import { z } from 'zod'

/** 命名空间 = 用这批密钥的那一方（例如 `model-api-keys`、`omp-settings`）：一方只取自己那一格 */
export const SecretNamespace = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
/** 命名空间里的键：服务商 id、设置路径之类，不含值 */
export const SecretKey = z.string().min(1).max(256)
/** 密钥本身：只在 Host ↔ Core 之间、只在内存里流转 */
export const SecretValue = z.string().min(1).max(16_384)

export type SecretNamespace = z.infer<typeof SecretNamespace>
