use crate::error::{Error, IpcError, Result};
use crate::paths::automations_store;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tauri::{AppHandle, Wry, async_runtime, command};
use tauri_plugin_store::{Store, StoreExt};
use tauri_specta::Event;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::time::{Instant, MissedTickBehavior, interval_at};
use uuid::Uuid;

type AutomationsCommandResult<T> = std::result::Result<T, IpcError>;

/// 账本只留最近这么多次。再往前的正文仍在各自那条对话里。
///
/// 常量在这一侧而不在渲染进程：账本归这里所有，裁剪是它自己的不变量。放在
/// 调用方那侧，任何一条没走那段代码的写入都会让账本无限长下去。
const RUN_HISTORY_LIMIT: usize = 50;

/// 多久看一眼日程。
///
/// 心跳只决定「多久看一眼」，不决定「到没到期」—— 后者由墙钟时间戳比对回答
/// （见 due_at）。所以定时器漂了、机器睡过去了，都不会让某一次到期丢掉，只会
/// 让它晚一点被发现。cron 守护进程也是这个形状：醒来，自己不记时间。
const TICK: Duration = Duration::from_secs(30);

/*
 * 目录文件的写入串行化。
 *
 * 每一条写命令都是「读—改—写」，而 tauri 的命令处理器彼此并发。两条命令交错，
 * 后写的那条就会把先写的那条整段盖掉。这把锁只保护这个模块自己拥有的那一个
 * 文件，不是给别人摸的全局状态。
 *
 * 用 std 的互斥锁而不是异步锁：临界区里没有 .await，纯文件读写，跨不了让点，
 * 因此这些 future 仍然是 Send，也不必为一次毫秒级的写引入一整套异步锁语义。
 */
static LEDGER: Mutex<()> = Mutex::new(());

#[derive(Debug, Deserialize, Serialize, Type, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AutomationRunOutcome {
    Succeeded,
    Failed,
}

/// 一次运行的账目。
///
/// 只有指针和结局，没有正文：一次运行就是一条对话，说过什么由那条对话自己
/// 保管。这里再存一份，就是 AGENTS.md 明令禁止的第二份运行状态。
#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    /// 这次运行开出来的那条对话。开不出来时为 None。
    pub thread_id: Option<String>,
    /// RFC 3339。全库其余每一处时间戳都是这个格式。
    pub started_at: String,
    pub outcome: AutomationRunOutcome,
}

#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub title: String,
    /// 到期时发给 agent 的那句话。自动化的全部行为都由它决定。
    pub prompt: String,
    /// 什么时候跑。crontab 表达式；None 就是「只在人按下运行时跑一次」。
    ///
    /// 这一侧不解析它。这一侧只有一个职责：把 next_run_at 和墙钟比大小
    /// （见 due_at）。日历是领域的事，归 packages/automations，那里用 croner
    /// 求值。
    ///
    /// 时区不在这里，也不在任何一个字段里：求值那一刻的系统时区就是答案。
    /// 存一份下来，总有一天会和人所在的地方对不上，而「每天九点」说的永远
    /// 是此刻这台机器上的九点。
    ///
    /// Option 而不是一个带 Manual 分支的判别联合：Manual 不携带任何数据，
    /// 那个 tag 只是 None 的另一种拼法，两份表示就是两份能互相矛盾的真相。
    pub schedule: Option<String>,
    pub enabled: bool,
    pub created_at: String,
    /// 下一次到期的时刻，RFC 3339；manual 为 None。
    ///
    /// 它是被存下来的状态，不是每次由 last_run 推出来的推论：只有存下来，
    /// 关机三天之后再打开才分得清「这次错过了」与「刚刚才排上」。cron 守护
    /// 进程与 Temporal 这类调度器的做法都是如此。
    pub next_run_at: Option<String>,
    /// 这次运行要改掉的会话设置，按 agent 报的 controlId 记。
    ///
    /// 值是 agent 自己的词汇（模型别名、推理档位、模式），这一层不认识也不
    /// 校验：候选由它在 session/new 里报出，随时可能改名或撤回。空表就是
    /// 「跟随全局默认」，所以缺席与空表是同一个意思，serde(default) 足够。
    ///
    /// BTreeMap 而非 HashMap：写进 JSON 的键序要稳定，否则每次保存都是一次
    /// 无意义的磁盘差异。生成的 TypeScript 因此是 Partial<Record<..>>。
    #[serde(default)]
    pub session_config: BTreeMap<String, String>,
    /// 运行账本。归这一侧所有 —— 见 automations_upsert。
    pub runs: Vec<AutomationRun>,
}

#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct AutomationCatalog {
    pub version: u32,
    pub automations: Vec<Automation>,
}

impl Default for AutomationCatalog {
    fn default() -> Self {
        Self {
            version: 1,
            automations: Vec::new(),
        }
    }
}

/// 一次运行跑完之后，日程该怎么走。
///
/// 由发起那次运行的一侧算出来、随记账一起提交；这一侧只做比对，不重算。手动
/// 试运行落在 Keep 上：cron、systemd timer 与 Kubernetes CronJob 的手动触发
/// 都不改写周期计划，这里同一条规矩。
#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AutomationReschedule {
    Keep,
    #[serde(rename_all = "camelCase")]
    Advance {
        /// 刚刚到期的那个时刻。与盘上的 next_run_at 对不上就说明日程已经被人
        /// 动过，这次推进作废 —— 比较并交换，不是无条件覆盖。
        from: String,
        to: Option<String>,
    },
}

/// 一次运行的提交：记一笔账，并按上面的判定推进日程。
#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunRecord {
    pub id: String,
    pub run: AutomationRun,
    pub reschedule: AutomationReschedule,
}

/// 账本变了。写路径只有一处宣布，所以 MCP 那一侧的改动同样到得了屏幕。
#[derive(Clone, Debug, Deserialize, Event, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AutomationCatalogChanged {
    pub catalog: AutomationCatalog,
}

/// 一条还没有身份的自动化。id、created_at 与运行账本由这一侧铸。
///
/// next_run_at 由日历的持有方给（packages/automations 用 croner 求值）；缺席表示
/// 还没排，它会在下一次宣布之后被补上。
#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AutomationCreation {
    pub title: String,
    pub prompt: String,
    pub schedule: Option<String>,
    #[serde(default)]
    pub session_config: BTreeMap<String, String>,
    pub next_run_at: Option<String>,
}

pub(crate) fn open(app: &AppHandle) -> Result<Arc<Store<Wry>>> {
    Ok(app.store(automations_store(app)?)?)
}

/// 读出目录。读不懂的原件先挪走，再如实报错。
pub(crate) fn read_catalog(store: &Store<Wry>) -> Result<AutomationCatalog> {
    let Some(value) = store.get("automations") else {
        return Ok(AutomationCatalog::default());
    };

    match serde_json::from_value::<AutomationCatalog>(value.clone()) {
        Ok(catalog) => Ok(catalog),
        Err(cause) => {
            /*
             * 读不懂的目录不丢：原件挪到备份键、主键删除，然后如实报错。
             * 下一次启动读到的是「没有」，而不是又一次解析失败；原件留底，
             * 不会被下一次保存盖掉。VS Code 的 state 备份与 Chrome 的
             * Preferences.bad 是同一个做法。
             */
            store.set("automations.corrupt", value);
            store.delete("automations");
            store.save()?;

            Err(cause.into())
        }
    }
}

/// 读—改—写，全程持锁，回给写完之后的整本目录。
///
/// 每一条写命令都长这个样子，于是「怎么写盘」在这个模块里只有一份实现。
pub(crate) fn mutate(
    app: &AppHandle,
    edit: impl FnOnce(&mut Vec<Automation>),
) -> Result<AutomationCatalog> {
    let _guard = LEDGER.lock().unwrap_or_else(PoisonError::into_inner);

    let store = open(app)?;
    let mut catalog = read_catalog(&store)?;

    edit(&mut catalog.automations);

    store.set("automations", serde_json::to_value(&catalog)?);
    store.save()?;

    if let Err(cause) = (AutomationCatalogChanged {
        catalog: catalog.clone(),
    })
    .emit(app)
    {
        log::warn!("could not announce the automation catalog: {cause}");
    }

    Ok(catalog)
}

/// 铸一条新的：id 与 created_at 归账本，日程与日历归领域层。
pub(crate) fn create(app: &AppHandle, creation: AutomationCreation) -> Result<AutomationCatalog> {
    let created_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|cause| Error::Internal(cause.to_string()))?;

    let automation = Automation {
        id: Uuid::new_v4().to_string(),
        title: creation.title,
        prompt: creation.prompt,
        enabled: creation.schedule.is_some(),
        schedule: creation.schedule,
        created_at,
        next_run_at: creation.next_run_at,
        session_config: creation.session_config,
        runs: Vec::new(),
    };

    mutate(app, move |automations| {
        automations.insert(0, automation);
    })
}

/// Creates one automation and returns the catalog as written.
///
/// # Errors
///
/// Returns an error when the clock cannot be formatted, when the store cannot be
/// opened, or when the write does not reach disk.
#[command]
#[specta::specta]
pub async fn automations_create(
    app: AppHandle,
    creation: AutomationCreation,
) -> AutomationsCommandResult<AutomationCatalog> {
    create(&app, creation).map_err(IpcError::from)
}

/// Reads the persisted automations.
///
/// # Errors
///
/// Returns an error when the store cannot be opened, or when the stored
/// catalog cannot be parsed. In that case the unreadable original is first
/// moved to the automations.corrupt backup key: falling back to an empty
/// catalog without keeping the original would let the next write overwrite
/// the only copy of the user's automations.
#[command]
#[specta::specta]
pub async fn automations_load(app: AppHandle) -> AutomationsCommandResult<AutomationCatalog> {
    (|| -> Result<AutomationCatalog> {
        let store = open(&app)?;

        read_catalog(&store)
    })()
    .map_err(IpcError::from)
}

/// Creates or replaces one automation and returns the catalog as written.
///
/// The run ledger is not taken from the caller: it belongs to this side, so the
/// stored runs are kept and the incoming ones ignored. A caller that forgot to
/// send them would otherwise erase the history.
///
/// # Errors
///
/// Returns an error when the store cannot be opened, when the catalog cannot be
/// serialized, or when the write does not reach disk.
#[command]
#[specta::specta]
pub async fn automations_upsert(
    app: AppHandle,
    automation: Automation,
) -> AutomationsCommandResult<AutomationCatalog> {
    mutate(&app, move |automations| {
        let at = automations
            .iter()
            .position(|candidate| candidate.id == automation.id);
        let kept = at
            .and_then(|index| automations.get(index))
            .map_or_else(Vec::new, |existing| existing.runs.clone());
        let saved = Automation {
            runs: kept,
            ..automation
        };

        match at {
            Some(index) => {
                automations.remove(index);
                automations.insert(index, saved);
            }
            None => automations.insert(0, saved),
        }
    })
    .map_err(IpcError::from)
}

/// Removes one automation and returns the catalog as written.
///
/// Removing something that is already gone is a success, not an error: the
/// caller asked for a state and that state already holds. HTTP DELETE is
/// specified the same way.
///
/// # Errors
///
/// Returns an error when the store cannot be opened, when the catalog cannot be
/// serialized, or when the write does not reach disk.
#[command]
#[specta::specta]
pub async fn automations_remove(
    app: AppHandle,
    id: String,
) -> AutomationsCommandResult<AutomationCatalog> {
    mutate(&app, move |automations| {
        automations.retain(|candidate| candidate.id != id);
    })
    .map_err(IpcError::from)
}

/// Records one run and advances the schedule, returning the catalog as written.
///
/// # Errors
///
/// Returns an error when the store cannot be opened, when the catalog cannot be
/// serialized, or when the write does not reach disk.
#[command]
#[specta::specta]
pub async fn automations_record_run(
    app: AppHandle,
    record: AutomationRunRecord,
) -> AutomationsCommandResult<AutomationCatalog> {
    let AutomationRunRecord {
        id,
        run,
        reschedule,
    } = record;

    mutate(&app, move |automations| {
        let Some(existing) = automations.iter_mut().find(|candidate| candidate.id == id) else {
            /* 跑的过程中被删掉了。这是一个合法的时序，不是错误。 */
            return;
        };

        existing.runs.insert(0, run);
        existing.runs.truncate(RUN_HISTORY_LIMIT);

        /*
         * 比较并交换：只有盘上那个「下一次到期」仍然是刚刚到期的那个，才把它
         * 推到下一格。运行期间有人改过触发条件、停用过、或者另一次运行已经推
         * 过了，from 都对不上，这次推进作废。停用的那条 next_run_at 是 None，
         * 同样对不上 —— 不必再单独判一次 enabled。
         */
        if let AutomationReschedule::Advance { from, to } = reschedule
            && existing.next_run_at.as_deref() == Some(from.as_str())
        {
            existing.next_run_at = to;
        }
    })
    .map_err(IpcError::from)
}

/// 一条自动化到期了。原生侧敲的那一下钟。
///
/// 递过去的是整行，不是一个 id：到期与否由这一侧判定，被判定的那一行也该由这
/// 一侧交出去。让渲染层拿 id 回自己的副本里查，等于把判据和被判据的对象拆到两
/// 个进程里各存一份，而那份副本可能已经旧了。
///
/// 范式同 updates.rs 的 UpdateProgress：事件名与 payload 类型由 collect_events!
/// 一并导出，渲染层不手抄任何一个。Event 派生要求 Deserialize，它只服务于这条
/// 生成通道。
#[derive(Clone, Debug, Deserialize, Event, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDue {
    pub automation: Automation,
}

/// 这一行现在该跑了吗。
fn due_at(automation: &Automation, now: OffsetDateTime) -> bool {
    if !automation.enabled {
        return false;
    }

    let Some(next) = automation.next_run_at.as_deref() else {
        return false;
    };

    match OffsetDateTime::parse(next, &Rfc3339) {
        Ok(at) => at <= now,
        Err(cause) => {
            /*
             * 读不懂的时刻不当成「到期了」：那会让这一行在每个心跳上被点一次火。
             * 但也不静默 —— 它只可能来自被外部改坏的目录文件。
             */
            let id = &automation.id;

            log::warn!("automation {id} has an unreadable next run time: {cause}");

            false
        }
    }
}

/// 眼下已经到期的那些行。
fn due_now(app: &AppHandle) -> Result<Vec<Automation>> {
    let store = open(app)?;
    let catalog = read_catalog(&store)?;
    let now = OffsetDateTime::now_utc();

    Ok(catalog
        .automations
        .into_iter()
        .filter(|automation| due_at(automation, now))
        .collect())
}

/// 敲钟：把已经到期的每一行递给渲染层。
///
/// 至少一次，不是恰好一次。日程要到渲染层把这次运行记上账
/// （automations_record_run）才推进，在那之前每个心跳都会再敲一次同一行，由接收
/// 侧按 id 去重（automation-store.ts 的 inFlight）。反过来做才是错的：先推进日程
/// 再投递，投递失败的那一次就永远地丢了。
fn ring(app: &AppHandle) -> Result<()> {
    for automation in due_now(app)? {
        if let Err(error) = (AutomationDue { automation }).emit(app) {
            /*
             * 投不出去只影响这一行，而且下一个心跳还会再来一次。为它中断整轮扫描，
             * 等于让一行的故障拖住其余每一行。
             */
            log::warn!("could not announce a due automation: {error}");
        }
    }

    Ok(())
}

/// 起表。进程级，与应用同寿。
///
/// 表在这一侧走，不在 webview 里。渲染进程的定时器在页面隐藏时会被平台降频，而
/// 这个应用本来就带托盘、隐藏到托盘是常态 —— 把闹钟放在会被降频的那一侧，等于让
/// 「后台自动跑」在最需要它的时候最不准。
///
/// 第一下等满一个心跳：启动那一刻的补跑由 automations_sweep 负责，它在渲染层挂好
/// 监听之后才发，所以不会敲空。
pub fn watch(app: &AppHandle) {
    let app = app.clone();

    async_runtime::spawn(async move {
        let mut ticks = interval_at(Instant::now() + TICK, TICK);

        /*
         * 默认是 Burst：机器睡两小时再醒来，tokio 会把错过的那些下连着补完。这里
         * 一下就够 —— 到期与否看的是墙钟，不是敲了几下。
         */
        ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            ticks.tick().await;

            if let Err(cause) = ring(&app) {
                log::warn!("could not read the automation catalog: {cause}");
            }
        }
    });
}

/// Announces every automation whose next run time has already passed.
///
/// 渲染层挂好监听之后调它一次：心跳的下一下最远在 TICK 之后，而关机期间错过的那
/// 次不该等那么久。它与心跳走同一段 ring，不是第二套到期判定。
///
/// # Errors
///
/// Returns an error when the store cannot be opened, or when the stored catalog
/// cannot be parsed.
#[command]
#[specta::specta]
pub async fn automations_sweep(app: AppHandle) -> AutomationsCommandResult<()> {
    ring(&app).map_err(IpcError::from)
}
