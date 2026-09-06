use super::model::AppSettings;
use poietica_problem::Problem;
pub(crate) trait SettingsRepository: Send + Sync {
    fn load(&self) -> Result<AppSettings, Problem>;
    fn save(&self, settings: &AppSettings) -> Result<(), Problem>;
}
