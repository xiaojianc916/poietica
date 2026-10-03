//! 设置页每日 token 图的数据出口；口径归账本（persistence 的 usage.rs），这里只交出去。

use serde::Serialize;
use specta::Type;

use crate::ledger::counted;
use poietica_ledger::execution::read_index;
use poietica_problem::Problem;

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageDay {
    pub day: String,
    pub tokens: u32,
}

/// 一天里一个模型花掉的 token。趋势图按它分线。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageModelDay {
    pub day: String,
    pub model: String,
    pub tokens: u32,
}

/// 最近 span 天里每个模型各自的日账，由早到晚。没有账的日子与模型不占行。
#[specta::specta]
pub async fn usage_model_days(span: u32) -> Result<Vec<UsageModelDay>, Problem> {
    let index = crate::ledger::index()?;
    let recorded = read_index(&index, move |store| {
        store
            .token_model_days(i64::from(span))
            .map_err(crate::error::Error::from)
    })
    .await
    .map_err(Problem::from)?;

    let mut days = Vec::with_capacity(recorded.len());

    for day in recorded {
        days.push(UsageModelDay {
            day: day.day,
            model: day.model,
            tokens: counted(day.tokens).map_err(Problem::from)?,
        });
    }

    Ok(days)
}

/// 最近 span 天里发出去的句子数。准入那一行就是「用户说了一句话」，插话也照算。
#[specta::specta]
pub async fn usage_message_count(span: u32) -> Result<u32, Problem> {
    let index = crate::ledger::index()?;
    let recorded = read_index(&index, move |store| {
        store
            .messages_since(i64::from(span))
            .map_err(crate::error::Error::from)
    })
    .await
    .map_err(Problem::from)?;

    counted(recorded).map_err(Problem::from)
}

/// 最近 span 天的日账，由早到晚。没有账的日子不占行。
#[specta::specta]
pub async fn usage_token_days(span: u32) -> Result<Vec<UsageDay>, Problem> {
    let index = crate::ledger::index()?;
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
