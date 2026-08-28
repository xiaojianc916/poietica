//! 每天用掉多少 token —— 设置页那张图读的就是它。
//!
//! 账怎么算是账本的事（persistence 的 usage.rs），这一侧只把它交出去。

use serde::Serialize;
use specta::Type;
use tauri::State;

use crate::local_index::{LocalIndex, counted, on_index, persistence};
use poietica_problem::Problem;

/// 一天的账。日历日按本机时区算，键就是渲染层索引热力图的那一个。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageDay {
    /// `YYYY-MM-DD`。
    pub day: String,
    /// 那天累计的 token。
    pub tokens: u32,
}

/// 最近 span 天的日账，由早到晚。没有账的日子不占行。
///
/// # Errors
///
/// 库读不出、或某一天的数大到这份 IPC 面装不下时返回错误。
#[tauri::command]
#[specta::specta]
pub async fn usage_token_days(
    index: State<'_, LocalIndex>,
    span: u32,
) -> Result<Vec<UsageDay>, Problem> {
    let recorded = on_index(&index, move |store| {
        store.token_days(i64::from(span)).map_err(persistence)
    })
    .await
    .map_err(Problem::from)?;

    let mut days = Vec::with_capacity(recorded.len());

    for day in recorded {
        days.push(UsageDay {
            day: day.day,
            tokens: counted(day.tokens).map_err(Problem::from)?,
        });
    }

    Ok(days)
}
