# 0042 — agent 受控 home 就是 `agents/`，不再多一层

日期：2026-10-04

## 背景

数据根里 agent 的受控 home 是 `agents/<id>/home/`。两层各自有名字，而"哪一家"这件事
在 ADR 0033 之后已经收敛成一份档案：全仓只有一家 agent（ADR 0016），`agents/` 下永远只有
一个 `omp/`，它下面又只有一个 `home/`。两层目录不表达任何事实，只把"这里住着谁的 home"
重说了一遍。

## 决定

受控 home 就是 `agents/`：`paths::agent_home()` 只拼一层，不再收 agent_id。

- 路径由 Rust 算这条不变（写配置的 CLI 与起会话的连接必须落在同一处）。
- `controlled_home()` 不再需要 agent 身份；`agent_id()` 仍然存在，但它只用来对账本里的行
  做归属判断，不再是任何目录名。
- 目录名仍是 `agents`：它是磁盘上的既成事实，也是 electron 的存储页与备份口径读的那个名字。

## 一次性迁移

旧形状只存在于本版之前，所以搬一次就够，不建迁移设施：
`move_agent_home_up()` 在每次解析受控 home 时看一眼 `agents/<id>/home/`。存在就把里面
没有同名冲突的条目 rename 上来。新 home 里已经有同名的就不动（不覆盖正在用的那一份），
搬不动的那一份原样留在旧处；两层旧目录都空了才收走。全部是 rename，同卷，不产生副本。

删除条件：盘上再也找不到 `<home>/<id>/home/` 这种形状，即这一版发布并铺开之后删掉整段。
判据写在该函数的注释里。

没有改写 agent.db 里的绝对路径：那些表按 `session_file` 记路径，是会话统计与 gc 的账。
已经落在旧命名下的行留成旧路径即可 —— 文件本身搬到了新处，历史统计不参与会话读写，
下次 gc 照 `session_file` 对账。

## 影响

- 磁盘布局：`agents/` 自己就是 home；`docs/architecture/data-layout.md` 那一行同步改。
- `paths::agent_home` 去掉参数；`profile.rs` 的 `controlled_home` 去掉参数。
- 存储页那一格的文案从"agent 配置"改成"agent 数据"：它现在覆盖会话与技能。
- 新装机器上 `agents/` 直接就是 home，没有第二层可搬。
