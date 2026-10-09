/**
 * 谁问得晚，谁的答复算数。
 *
 * 一张选择器表有两条到达路径：我们问、它答（set_config_option 的答复、锚会话的
 * 整表读取），以及 agent 自己说话（ACP 的 session/update::config_option_update）。
 * 两条并发时按落地先后写入是错的 —— 换模型那一次，agent 先答复一张还没收敛的表、
 * 再推一张收敛过的，谁后落地谁覆盖就会把屏幕停在上一个模型的档位候选集上。
 *
 * 先后因此由这里定，而且全仓只有这一份：每一次发问领一张号，任何一次到达都让先前
 * 发出的号作废。它不认识表、不认识端口、也不认识对话，所以两台 store 用的是同一条
 * 规则，而不是同一段抄写。
 */
export class ArrivalOrder {
  #latest = 0

  /** 发一次问，领一张号。 */
  issue(): number {
    this.#latest += 1

    return this.#latest
  }

  /** 一张表不请自来：此前发出去的那些问题，答案都已经过期。 */
  arrive(): void {
    this.#latest += 1
  }

  /** 这张号还是最新的那一张吗。 */
  isLatest(ticket: number): boolean {
    return ticket === this.#latest
  }
}
