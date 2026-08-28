use poietica_conversation::identity::{Seq, ThreadId};
use poietica_conversation::projection::{ThreadView, project};
use poietica_time::WallClock;

use crate::conversation::{SqliteLedger, events};
use crate::error::LedgerError;
use crate::projection::threads;

/// 投影是派生数据，重建就是重放 + upsert；这里不存在第二份 fold 逻辑。
pub fn rebuild<C: WallClock>(
    ledger: &SqliteLedger<C>,
    thread: &ThreadId,
) -> Result<ThreadView, LedgerError> {
    let events = events::after(ledger, thread, Seq::NONE)?;
    let view = project(thread, &events);

    threads::upsert(ledger, &view)?;

    Ok(view)
}
