/**
 * 谁问得晚，谁的答复算数。
 *
 * 表有两条到达路径（我们问它答 / agent 主动推），并发时按落地先后写入是错的：换模型那一次
 * agent 会先答复一张没收敛的表、再推收敛过的，屏幕会停在上一个模型的档位候选集上。
 */
export class ArrivalOrder {
  #latest = 0

  issue(): number {
    this.#latest += 1

    return this.#latest
  }

  /** 一张表不请自来：此前发出去的那些问题，答案都已经过期。 */
  arrive(): void {
    this.#latest += 1
  }

  isLatest(ticket: number): boolean {
    return ticket === this.#latest
  }
}
