/*
 * kimi 把「这句话带了什么附件」写成给**模型**看的机器句子，塞进提示正文
 * （kap-server promptMedia.ts 的 buildAttachedFileNotice / buildImageCompressionCaption，
 * 2026-09 的 kimi-code 2.0.2）。正文因此混着这些句子，而气泡只画人说的话：
 * 附件由 transcript 的 attachmentIds 画成卡片，句子在这里摘掉（ADR 0050）。
 *
 * 摘的是句子，不是内容：正文里从来没有过文件字节，附件本体走磁盘路径。
 */

/** 句子两端的锚，正本与参考 web UI 同源（dist-web 的 `Attached file "` 与末尾那句）。 */
const FILE_NOTICE_HEAD = 'Attached file "'
const FILE_NOTICE_MIDDLE = '" ('
const FILE_NOTICE_TAIL = ' — open it with the Read tool'

/** 图片被压过或模型不收时，服务端另加的一段说明。 */
const SYSTEM_NOTICE_HEAD = '<system>Image compressed to fit model limits:'
const SYSTEM_NOTICE_TAIL = '</system>'

/**
 * 摘掉一句 file notice，找不到就原样退回。
 *
 * 用「找边界」而不是一条正则：文件名是用户起的，里面可能有引号或换行，
 * 字符类一写窄就会漏摘，而漏摘的直接后果是那句话连同文件卡片一起出现在屏幕上。
 * 边界认的是 `" (`，与参考 web UI 同一条判据。
 */
function stripFileNotice(text: string): string {
  const head = text.indexOf(FILE_NOTICE_HEAD)
  if (head < 0) {
    return text
  }
  const middle = text.indexOf(FILE_NOTICE_MIDDLE, head + FILE_NOTICE_HEAD.length)
  if (middle < 0) {
    return text
  }
  const tail = text.indexOf(FILE_NOTICE_TAIL, middle)
  if (tail < 0) {
    return text
  }
  return text.slice(0, head) + text.slice(tail + FILE_NOTICE_TAIL.length)
}

function stripSystemNotice(text: string): string {
  const head = text.indexOf(SYSTEM_NOTICE_HEAD)
  if (head < 0) {
    return text
  }
  const tail = text.indexOf(SYSTEM_NOTICE_TAIL, head)
  if (tail < 0) {
    return text
  }
  return text.slice(0, head) + text.slice(tail + SYSTEM_NOTICE_TAIL.length)
}

/** 一遍里可能有多条（一句话挂几个附件）。 */
function stripAll(text: string, strip: (value: string) => string): string {
  let current = text
  for (;;) {
    const next = strip(current)
    if (next === current) {
      return current
    }
    current = next
  }
}

export function withoutKimiAttachmentNotices(prompt: string): string {
  const withoutFiles = stripAll(prompt, stripFileNotice)
  const withoutImages = stripAll(withoutFiles, stripSystemNotice)
  // [Image omitted: …]：半角括号包起来的一行，没有嵌套。
  return withoutImages.replace(/\[Image omitted: [^\]\n]*\]/g, '')
}
