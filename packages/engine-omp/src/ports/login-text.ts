/**
 * omp 登录流程推给人看的那几句话（进度、输入提示、授权说明）的中文。omp 在这里没有稳定标识符，只能按原文认；
 * omp 改了措辞就落回「不认识」：进度不转发（界面有自己的阶段文案，不把英文原文甩给人），
 * 输入提示与授权说明原样交回（那一格总得让人知道填什么）。
 */

type Rewrite = string | ((match: RegExpMatchArray) => string)

const PROGRESS: readonly (readonly [RegExp, Rewrite])[] = [
  [/^Waiting for browser (authentication|authorization)/i, '等待在浏览器中完成授权…'],
  [/^Waiting for pasted authorization code/i, '等待粘贴授权码…'],
  [/^Waiting for device authorization/i, '等待在网页上确认…'],
  [/^(Initiating|Requesting) device authorization/i, '正在获取验证码…'],
  [/^Exchanging authorization code/i, '正在完成登录…'],
  [/^Enabling models/i, '正在启用模型…'],
  [/^Checking Cloud Code Assist account status/i, '正在检查 Cloud Code Assist 账号…'],
  [/^Checking for existing Cloud Code Assist project/i, '正在查找已有的 Cloud Code Assist 项目…'],
  [/^Provisioning the Antigravity free tier/i, '正在开通 Antigravity 免费额度…'],
  [/^Provisioning Cloud Code Assist project/i, '正在开通 Cloud Code Assist 项目，可能需要一点时间…'],
  [/^Refreshing Cloud Code Assist project/i, '正在刷新 Cloud Code Assist 项目…'],
  [/^Waiting for project provisioning \(attempt (\d+)\/(\d+)\)/i, (m) => `正在等待项目开通（第 ${m[1]}/${m[2]} 次）…`],
]

interface PromptText {
  readonly message: string
  readonly placeholder?: string
  /** 浏览器回调的备用通道：授权正常完成就不必填 */
  readonly fallback?: boolean
}

const PROMPTS: readonly (readonly [RegExp, PromptText])[] = [
  /* omp 给粘贴授权码类服务商同时挂上的备用输入（auth/oauth.ts 的 manualCodeInput） */
  [/^Paste the authorization code/i, { message: '粘贴授权码或完整的回调地址', fallback: true }],
  [/^GitHub Enterprise URL\/domain/i, { message: 'GitHub Enterprise 域名（使用 github.com 请留空）' }],
  [/^Enter your Snowflake account identifier/i, { message: 'Snowflake 账号标识或地址' }],
]

const INSTRUCTIONS: readonly (readonly [RegExp, string])[] = [
  [/^Sign in to Snowflake in your browser/i, '在浏览器中登录 Snowflake 并批准访问。'],
]

/** 设备码：omp 写成 `Enter code: XXXX-XXXX` */
const DEVICE_CODE = /code[:：]?\s*([A-Z0-9][A-Z0-9-]{3,})\s*$/i

function rewrite(rule: Rewrite, match: RegExpMatchArray): string {
  return typeof rule === 'string' ? rule : rule(match)
}

/** 进度：认得的换成中文，不认得的交回 null（不转发） */
export function loginProgressText(message: string): string | null {
  for (const [pattern, rule] of PROGRESS) {
    const match = message.match(pattern)
    if (match !== null) return rewrite(rule, match)
  }
  return null
}

/** 输入提示：认得的换成中文并标出是不是备用通道，不认得的原样交回 */
export function loginPromptText(
  message: string,
  placeholder: string | null,
): { readonly message: string; readonly placeholder: string | null; readonly fallback: boolean } {
  for (const [pattern, text] of PROMPTS) {
    if (pattern.test(message)) {
      return { message: text.message, placeholder: text.placeholder ?? placeholder, fallback: text.fallback === true }
    }
  }
  return { message, placeholder, fallback: false }
}

/** 授权说明：设备码单独拎出来（界面要把它画大、给复制），其余认得的换成中文 */
export function loginAuthText(instructions: string | null): {
  readonly code: string | null
  readonly instructions: string | null
} {
  if (instructions === null) return { code: null, instructions: null }
  const code = instructions.match(DEVICE_CODE)
  if (code !== null && /^enter code/i.test(instructions.trim())) return { code: code[1] ?? null, instructions: null }
  for (const [pattern, text] of INSTRUCTIONS) {
    if (pattern.test(instructions)) return { code: null, instructions: text }
  }
  return { code: null, instructions }
}
