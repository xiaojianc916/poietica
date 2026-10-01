use super::model::{AppSettings, SettingsWriteResult};
use super::repository::SettingsRepository;
use poietica_problem::Problem;
use std::{future::Future, pin::Pin};
use tokio::sync::Mutex;
type ApplyFuture = Pin<Box<dyn Future<Output = Result<(), Problem>> + Send>>;
type ApplyIntent = dyn Fn(bool) -> ApplyFuture + Send + Sync;
pub(crate) struct SettingsService {
    repository: Box<dyn SettingsRepository>,
    apply: Box<ApplyIntent>,
    write: Mutex<()>,
}
impl SettingsService {
    pub(crate) fn new<R, A, F>(repository: R, apply: A) -> Self
    where
        R: SettingsRepository + 'static,
        A: Fn(bool) -> F + Send + Sync + 'static,
        F: Future<Output = Result<(), Problem>> + Send + 'static,
    {
        Self {
            repository: Box::new(repository),
            apply: Box::new(move |intent| -> ApplyFuture { Box::pin(apply(intent)) }),
            write: Mutex::new(()),
        }
    }
    pub(crate) fn load(&self) -> Result<AppSettings, Problem> {
        self.repository.load()
    }
    pub(crate) async fn save(&self, settings: AppSettings) -> Result<SettingsWriteResult, Problem> {
        let _write = self.write.lock().await;
        self.repository.save(&settings)?;
        let application_problem = (self.apply)(settings.general.daemon).await.err();
        Ok(SettingsWriteResult {
            settings,
            application_problem,
        })
    }
    pub(crate) async fn reset(&self) -> Result<SettingsWriteResult, Problem> {
        self.save(AppSettings::default()).await
    }
    pub(crate) async fn apply_startup(&self) -> Result<(), Problem> {
        let _write = self.write.lock().await;
        let settings = self.repository.load()?;
        (self.apply)(settings.general.daemon).await
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "a failing fixture or broken invariant must fail the test loudly"
    )]
    use super::super::model::AppSettings;
    use super::super::repository::SettingsRepository;
    use super::SettingsService;
    use poietica_problem::{Code, DiagnosticId, Problem};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::sync::Notify;
    #[derive(Clone, Default)]
    struct Memory {
        value: Arc<Mutex<AppSettings>>,
        writes: Arc<AtomicUsize>,
        reject: bool,
    }
    impl SettingsRepository for Memory {
        fn load(&self) -> Result<AppSettings, Problem> {
            Ok(self.value.lock().expect("settings test lock").clone())
        }
        fn save(&self, settings: &AppSettings) -> Result<(), Problem> {
            if self.reject {
                return Err(Problem::new(
                    Code::SettingsUnavailable,
                    DiagnosticId::issue(),
                ));
            }
            self.writes.fetch_add(1, Ordering::SeqCst);
            *self.value.lock().expect("settings test lock") = settings.clone();
            Ok(())
        }
    }
    #[tokio::test]
    async fn persistence_failure_does_not_apply_runtime_intent() {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&calls);
        let service = SettingsService::new(
            Memory {
                reject: true,
                ..Memory::default()
            },
            move |_| {
                observed.fetch_add(1, Ordering::SeqCst);
                async { Ok(()) }
            },
        );
        assert!(service.save(AppSettings::default()).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn application_failure_preserves_a_successful_commit() {
        let memory = Memory::default();
        let service = SettingsService::new(memory.clone(), |_| async {
            Err(Problem::new(Code::AgentRejected, DiagnosticId::issue()))
        });
        let settings = AppSettings {
            language: "en".into(),
            ..AppSettings::default()
        };
        let receipt = service.save(settings).await.expect("persisted receipt");
        assert!(receipt.application_problem.is_some());
        assert_eq!(receipt.settings.language, "en");
        assert_eq!(memory.load().expect("stored settings").language, "en");
    }
    #[tokio::test]
    async fn commits_and_runtime_application_share_one_order() {
        let memory = Memory::default();
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let applied = Arc::new(Mutex::new(Vec::new()));
        let service = Arc::new(SettingsService::new(memory.clone(), {
            let entered = Arc::clone(&entered);
            let release = Arc::clone(&release);
            let applied = Arc::clone(&applied);
            move |intent| {
                let entered = Arc::clone(&entered);
                let release = Arc::clone(&release);
                let applied = Arc::clone(&applied);
                async move {
                    applied.lock().expect("application order").push(intent);
                    if intent {
                        entered.notify_one();
                        release.notified().await;
                    }
                    Ok(())
                }
            }
        }));
        let first = tokio::spawn({
            let service = Arc::clone(&service);
            async move { service.save(AppSettings::default()).await }
        });
        entered.notified().await;
        let second = tokio::spawn({
            let service = Arc::clone(&service);
            async move {
                let mut settings = AppSettings::default();
                settings.general.daemon = false;
                service.save(settings).await
            }
        });
        tokio::task::yield_now().await;
        assert_eq!(memory.writes.load(Ordering::SeqCst), 1);
        release.notify_one();
        first.await.expect("first task").expect("first commit");
        second.await.expect("second task").expect("second commit");
        assert_eq!(
            *applied.lock().expect("application order"),
            vec![true, false]
        );
        assert!(!memory.load().expect("final settings").general.daemon);
    }
    #[tokio::test]
    async fn reset_uses_the_same_persistence_path() {
        let memory = Memory::default();
        let service = SettingsService::new(memory.clone(), |_| async { Ok(()) });
        let receipt = service.reset().await.expect("reset commit");
        assert_eq!(receipt.settings.language, "zh-CN");
        assert_eq!(memory.writes.load(Ordering::SeqCst), 1);
    }
}
