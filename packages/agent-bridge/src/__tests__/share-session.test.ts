/*
 * 分享的分派、脱敏判据与错误路径。
 *
 * 分享是**唯一会把对话正文送出本机**的命令，所以这一格钉住的不是「能不能连上服务器」，
 * 而是三件更要紧的事：
 *   1. 会话号对不上任何会话文件时**如实报错**，不假装成功 —— 报一条不存在的链接比报错坏得多；
 *   2. 脱敏的判据按 agent 自己的设置算（`share.redactSecrets` && `secrets.enabled`）；
 *   3. `truncated` 原样来自 agent，不由本层猜 —— 猜成 false 等于替 agent 断言「内容是完整的」。
 *
 * 真的上传不发：那要联网、要 my.omp.sh 收下这份对话。桩打在 `export/share` 那一格上
 * （分享的唯一下界），与 packages/native-bridge 的 settings.test.ts 打桩生成的命令同理。
 *
 * 跑法：cd packages/agent-bridge && bun test src/__tests__/share-session.test.ts
 */

import { expect, mock, test } from 'bun:test'

const real = await import('@oh-my-pi/pi-coding-agent/export/share')
const { getAgentDir } = await import('@oh-my-pi/pi-coding-agent')

/*
 * 受控 home 必须与 SDK **实际解析到的**那一个一致，而不是这里另造一个。
 *
 * SDK 的 agent 目录是模块加载时解析、进程内唯一的（pi-utils 的 dirs.ts）：同一次
 * `bun test src` 里还有别的文件（live-image-attachments.test.ts）也在置
 * PI_CODING_AGENT_DIR，谁先 import 谁说了算。本文件再造一个临时目录只会让
 * createBridge 的对账失败（「agent home mismatch」）—— 那是测试互相踩，不是桥的问题。
 * 所以这里读它已经定下的那个值，只在自己的 home 里清出一块干净地方。
 */
const home = getAgentDir()

/** 每一趟分享实际交出去的 options；`obfuscator` 在不在就是脱敏开没开。 */
const uploads: { obfuscator?: unknown }[] = []

/** 这一趟让上传成功还是失败；每格用例自己设。 */
let behavior: (options?: { obfuscator?: unknown }) => Promise<unknown> = async () => ({
  url: 'https://my.omp.sh/s/abc#key',
  method: 'server',
  truncated: false,
  sealedBytes: 12,
})

/*
 * `shareSession` 是 ESM 具名导出，模块命名空间不可改（defineProperty 会抛），所以用 bun 的
 * 模块桩。桩里把真模块的其余出口原样散回去 —— 模块桩是**进程级**的，只换一格会让同一次
 * 运行里别的测试文件连 `DEFAULT_SHARE_URL` 都 import 不到。
 */
mock.module('@oh-my-pi/pi-coding-agent/export/share', () => ({
  ...real,
  shareSession: async (_manager: unknown, options?: { obfuscator?: unknown }) => {
    uploads.push(options ?? {})
    return await behavior(options)
  },
}))

const { createBridge } = await import('../bridge.ts')

/*
 * 桥按 SDK 已经解析到的那个 home 起：这里不再置 PI_CODING_AGENT_DIR，否则就是对账
 * 失败的那条路（见本文件头）。
 */
function bridgeFor() {
  return createBridge({ agentDir: home, cwd: process.cwd() })
}

test('sharing an unknown session is an honest failure, and nothing is uploaded', async () => {
  uploads.length = 0
  const bridge = bridgeFor()

  await expect(
    bridge.dispatch({ id: 's1', type: 'share_session', sessionId: 'no-such-session' }),
  ).rejects.toThrow(/no session file holds no-such-session/)

  /* 会话都没找到就绝不能有上传 —— 「试了一下」本身就把正文送出去了。 */
  expect(uploads).toHaveLength(0)
})

test('an upload the agent refuses comes back as a failure, not a fake link', async () => {
  uploads.length = 0
  behavior = async () => {
    throw new Error('share server refused the upload')
  }

  const bridge = bridgeFor()
  const opened = (await bridge.dispatch({
    id: 'open',
    type: 'new_session',
    cwd: process.cwd(),
  })) as { sessionId: string }

  await expect(
    bridge.dispatch({ id: 's2', type: 'share_session', sessionId: opened.sessionId }),
  ).rejects.toThrow(/refused the upload/)

  behavior = async () => ({
    url: 'https://my.omp.sh/s/abc#key',
    method: 'server',
    truncated: false,
    sealedBytes: 12,
  })
})

/*
 * 成功那一趟：交回的只有 url 与 truncated，且 truncated 原样来自 agent。
 */
test('a shared session returns only the link and passes truncated through verbatim', async () => {
  uploads.length = 0
  behavior = async () => ({
    url: 'https://my.omp.sh/s/abc#key',
    method: 'server',
    truncated: true,
    sealedBytes: 999_999,
  })

  const bridge = bridgeFor()
  const opened = (await bridge.dispatch({
    id: 'open',
    type: 'new_session',
    cwd: process.cwd(),
  })) as { sessionId: string }

  const shared = (await bridge.dispatch({
    id: 's3',
    type: 'share_session',
    sessionId: opened.sessionId,
  })) as { url: string; truncated: boolean }

  expect(shared.url).toBe('https://my.omp.sh/s/abc#key')
  /* 真值就是真值：折成 false 是在说「内容完整」，而 agent 刚说了它被裁过。 */
  expect(shared.truncated).toBe(true)

  /*
   * method / gistUrl / sealedBytes 是 agent 的实现细节，本层不转发 —— 转发就得有人
   * 解释它们，而屏幕上没有它们的位置。
   */
  expect(Object.keys(shared).sort()).toEqual(['truncated', 'url'])

  /*
   * 受控 home 是空的：没有 secrets.yml、没有环境里的密钥，且 `secrets.enabled` 在 omp 的
   * schema 里默认为 **false**，所以这一趟按 omp 的判据**不该**建 obfuscator。这一格钉住判据
   * 真的读了设置 —— 无条件建一个会让「关掉脱敏」这个开关失效。
   */
  expect(uploads).toHaveLength(1)
  expect(uploads[0]?.obfuscator).toBeUndefined()
})
