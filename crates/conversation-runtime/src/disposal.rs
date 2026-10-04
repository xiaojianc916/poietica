//! An archive intent is discharged only after a confirmed successful operation.

use std::future::Future;

use poietica_agent_client::{AgentError, Refusal};
use poietica_ledger::execution::{IndexError, LocalIndex, write_index};

#[derive(Debug)]
pub struct DisposalFailure {
    pub session_id: String,
    pub cause: AgentError,
}

pub async fn discharge<E, F, A, L>(
    index: &LocalIndex<E>,
    owner: &str,
    serving: &str,
    archive: F,
    alive: L,
) -> Result<Vec<DisposalFailure>, E>
where
    E: From<IndexError> + Send + 'static,
    F: Fn(String) -> A,
    A: Future<Output = Result<(), AgentError>>,
    L: Fn() -> bool,
{
    let agent = owner.to_owned();
    let anchor = serving.to_owned();
    let pending = write_index(index, move |store| {
        store
            .record_session_disposal(&anchor, &agent)
            .map_err(IndexError::from)
            .map_err(E::from)?;
        store
            .session_disposals(&agent)
            .map_err(IndexError::from)
            .map_err(E::from)
    })
    .await?;
    let mut failures = Vec::new();
    for session_id in pending {
        if !alive() {
            break;
        }
        if session_id == serving {
            continue;
        }
        match archive(session_id.clone()).await {
            Ok(()) => {}
            /*
             * 远端明确说「没有这条会话」——这笔欠账在定义上已经还清。
             *
             * 不改别的失败：只有**确定性的缺席**才算还清。桥那条线上同一个意思有两种
             * 说法：删/导出/分享按号找不到文件时抛 `no session file holds <id>`，经
             * `session/bridge.rs` 折成 `Envelope { code: 0 }`；连接自己认不出的号走
             * `Refused(UnknownSession)`。
             *
             * 不这么做的话这笔账**永远**收不回来：每次连接都重试一遍注定失败的往返，
             * 而数量只增不减（用户每删一条从未产生过会话文件的对话就 +1）。判例：一台
             * 开发机上一天就攒到 272 条，每次开机刷 272 行警告，把真正的异常埋掉。
             */
            Err(cause) if absent_at_agent(&cause) => {}
            Err(cause) => {
                failures.push(DisposalFailure { session_id, cause });
                continue;
            }
        }
        write_index(index, move |store| {
            store
                .discharge_session_disposal(&session_id)
                .map_err(IndexError::from)
                .map_err(E::from)
        })
        .await?;
    }
    Ok(failures)
}

/// 远端是不是**确定性地**说这条会话它没有。
///
/// 只认那两种确切说法（见上面 match 的那一段）；任何别的失败都还算「还没删掉」，
/// 继续欠着 —— 把超时、断连这类不确定的失败也当成还清，等于丢掉一次真正的回收。
fn absent_at_agent(cause: &AgentError) -> bool {
    match cause {
        AgentError::Refused(Refusal::UnknownSession) => true,
        AgentError::Envelope { message, .. } => message.contains("no session file holds"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::discharge;
    use poietica_agent_client::AgentError;
    use poietica_ledger::execution::{IndexError, LocalIndex, read_index, write_index};
    use poietica_time::wall_clock::SystemWallClock;
    use std::error::Error;
    use std::future::ready;

    /// 远端明确说「没有这条会话」时，这笔欠账要当场清掉，而不是每次连接再问一遍。
    #[tokio::test]
    async fn an_absence_the_agent_confirms_is_discharged() -> Result<(), Box<dyn Error>> {
        let directory = tempfile::tempdir()?;
        let index =
            LocalIndex::<IndexError>::open(&directory.path().join("ledger.db"), SystemWallClock)?;
        write_index(&index, |store| {
            store
                .record_session_disposal("retired", "agent")
                .map_err(IndexError::from)
        })
        .await?;

        let failures = discharge(
            &index,
            "agent",
            "active",
            |_| {
                ready(Err(AgentError::Envelope {
                    code: 0,
                    message: "no session file holds retired".to_owned(),
                }))
            },
            || true,
        )
        .await?;

        assert!(failures.is_empty(), "确定性的缺席不算失败");
        let pending = read_index(&index, |store| {
            store.session_disposals("agent").map_err(IndexError::from)
        })
        .await?;
        assert!(
            !pending.iter().any(|session| session == "retired"),
            "这条账该被清掉，否则每次连接都要再失败一遍"
        );

        Ok(())
    }

    /// 不确定的失败（超时、断连）仍然欠着：回收不能因为一次网络抖动就被丢掉。
    #[tokio::test]
    async fn an_indeterminate_failure_stays_due() -> Result<(), Box<dyn Error>> {
        let directory = tempfile::tempdir()?;
        let index =
            LocalIndex::<IndexError>::open(&directory.path().join("ledger.db"), SystemWallClock)?;
        write_index(&index, |store| {
            store
                .record_session_disposal("retired", "agent")
                .map_err(IndexError::from)
        })
        .await?;

        let failures = discharge(
            &index,
            "agent",
            "active",
            |_| {
                ready(Err(AgentError::Transport {
                    message: "the agent went away".to_owned(),
                }))
            },
            || true,
        )
        .await?;

        assert_eq!(failures.len(), 1, "不确定的失败要如实回报");

        let pending = read_index(&index, |store| {
            store.session_disposals("agent").map_err(IndexError::from)
        })
        .await?;
        assert!(pending.iter().any(|session| session == "retired"));

        Ok(())
    }

    #[tokio::test]
    async fn an_unconfirmed_archive_remains_due() -> Result<(), Box<dyn Error>> {
        let directory = tempfile::tempdir()?;
        let index =
            LocalIndex::<IndexError>::open(&directory.path().join("ledger.db"), SystemWallClock)?;
        write_index(&index, |store| {
            store
                .record_session_disposal("retired", "agent")
                .map_err(IndexError::from)
        })
        .await?;
        let failures = discharge(
            &index,
            "agent",
            "active",
            |_| {
                ready(Err(AgentError::Transport {
                    message: "response lost".to_owned(),
                }))
            },
            || true,
        )
        .await?;
        assert_eq!(failures.len(), 1);
        let pending = read_index(&index, |store| {
            store.session_disposals("agent").map_err(IndexError::from)
        })
        .await?;
        assert!(pending.iter().any(|session| session == "retired"));
        let failures = discharge(&index, "agent", "active", |_| ready(Ok(())), || true).await?;
        assert!(failures.is_empty());
        let pending = read_index(&index, |store| {
            store.session_disposals("agent").map_err(IndexError::from)
        })
        .await?;
        assert_eq!(pending, vec!["active".to_owned()]);
        Ok(())
    }
}
