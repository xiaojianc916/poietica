//! 设置页每日 token 图的数据出口；口径归账本（persistence 的 usage.rs），这里只交出去。

use serde::Serialize;
use specta::Type;
use tauri::State;

use crate::ledger::{LocalIndex, counted};
use poietica_ledger::execution::read_index;
use poietica_problem::Problem;

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageDay {
    pub day: String,
    pub tokens: u32,
}

/// 最近 span 天的日账，由早到晚。没有账的日子不占行。
#[tauri::command]
#[specta::specta]
pub async fn usage_token_days(
    index: State<'_, LocalIndex>,
    span: u32,
) -> Result<Vec<UsageDay>, Problem> {
    let recorded = read_index(&index, move |store| {
        store
            .token_days(i64::from(span))
            .map_err(crate::error::Error::from)
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
