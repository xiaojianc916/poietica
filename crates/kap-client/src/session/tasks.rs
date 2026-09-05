use futures::FutureExt;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

/// All descendants are cancelled and joined before their connection releases persistence.
#[derive(Clone, Debug)]
pub(crate) struct SessionTasks {
    stop: CancellationToken,
    tracker: TaskTracker,
}
impl SessionTasks {
    pub(crate) fn new(stop: CancellationToken) -> Self {
        Self {
            stop,
            tracker: TaskTracker::new(),
        }
    }
    pub(crate) fn spawn(
        &self,
        future: impl Future<Output = ()> + Send + 'static,
    ) -> tokio::task::JoinHandle<()> {
        let stop = self.stop.clone();
        self.tracker.spawn(async move {
            tokio::select! {
                biased;
                () = stop.cancelled() => {},
                result = AssertUnwindSafe(future).catch_unwind() => {
                    if result.is_err() {
                        log::error!("a KAP connection task panicked; closing the connection");
                        stop.cancel();
                    }
                }
            }
        })
    }
    pub(crate) async fn shutdown(&self) {
        self.stop.cancel();
        let _closed = self.tracker.close();
        self.tracker.wait().await;
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "task ownership fixtures must fail loudly"
    )]
    use super::*;
    #[tokio::test]
    async fn shutdown_waits_for_cancelled_descendants() {
        let tasks = SessionTasks::new(CancellationToken::new());
        let child = tasks.spawn(std::future::pending());
        tasks.shutdown().await;
        child.await.expect("cancelled task finished normally");
        let late = tasks.spawn(async { std::future::pending::<()>().await });
        late.await.expect("late task cannot escape cancellation");
        tasks.shutdown().await;
    }
}
