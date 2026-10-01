use super::model::AppSettings;
use super::repository::SettingsRepository;
use crate::error::{Error, Result};
use poietica_problem::Problem;
use serde_json::{Map, Value};
use std::{
    fs,
    io::{ErrorKind, Write},
    path::PathBuf,
};
const SETTINGS_KEY: &str = "settings";
#[derive(Debug)]
pub(crate) struct FileSettingsRepository {
    path: PathBuf,
}
impl FileSettingsRepository {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self { path }
    }
    fn document(&self) -> Result<Map<String, Value>> {
        match fs::read(&self.path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(Map::new()),
            Err(error) => Err(Error::Io(error)),
        }
    }
    fn write(&self, settings: &AppSettings) -> Result<()> {
        let mut document = self.document()?;
        document.insert(SETTINGS_KEY.into(), serde_json::to_value(settings)?);
        let directory = self
            .path
            .parent()
            .ok_or_else(|| Error::Validation("Settings path has no parent".into()))?;
        fs::create_dir_all(directory)?;
        let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
        serde_json::to_writer_pretty(&mut temporary, &document)?;
        temporary.write_all(b"\n")?;
        temporary.as_file().sync_all()?;
        let _file = temporary
            .persist(&self.path)
            .map_err(|failure| Error::Io(failure.error))?;
        Ok(())
    }
}
impl SettingsRepository for FileSettingsRepository {
    fn load(&self) -> std::result::Result<AppSettings, Problem> {
        let result = (|| -> Result<AppSettings> {
            let document = self.document()?;
            match document.get(SETTINGS_KEY) {
                Some(value) => Ok(serde_json::from_value(value.clone())?),
                None => Ok(AppSettings::default()),
            }
        })();
        result.map_err(Problem::from)
    }
    fn save(&self, settings: &AppSettings) -> std::result::Result<(), Problem> {
        self.write(settings).map_err(Problem::from)
    }
}
#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        clippy::indexing_slicing,
        reason = "a failing fixture or unexpected document shape must fail the test loudly"
    )]
    use super::super::model::AppSettings;
    use super::super::repository::SettingsRepository;
    use super::FileSettingsRepository;
    use serde_json::{Value, json};
    use std::fs;
    #[test]
    fn missing_fields_keep_defaults_and_other_top_level_keys_survive() {
        let directory = tempfile::tempdir().expect("test directory");
        let path = directory.path().join("settings.json");
        let repository = FileSettingsRepository::new(path.clone());
        assert_eq!(
            repository.load().expect("missing file defaults").language,
            "zh-CN"
        );
        fs::write(
            &path,
            serde_json::to_vec(&json!({"settings": {"language": "en"}, "extension": {"keep": 7}}))
                .expect("test JSON"),
        )
        .expect("test file");
        let mut settings = repository.load().expect("partial settings");
        assert!(settings.general.confirm_before_delete);
        settings.language = "zh-CN".into();
        repository.save(&settings).expect("atomic replacement");
        let document: Value =
            serde_json::from_slice(&fs::read(&path).expect("settings file")).expect("stored JSON");
        assert_eq!(document["extension"]["keep"], 7);
        assert_eq!(repository.load().expect("saved settings").language, "zh-CN");
    }
    #[test]
    fn corrupt_documents_are_neither_defaulted_nor_overwritten() {
        let directory = tempfile::tempdir().expect("test directory");
        let path = directory.path().join("settings.json");
        fs::write(&path, b"{broken").expect("corrupt test file");
        let repository = FileSettingsRepository::new(path.clone());
        assert!(repository.load().is_err());
        assert!(repository.save(&AppSettings::default()).is_err());
        assert_eq!(fs::read(&path).expect("original bytes"), b"{broken");
        fs::write(
            &path,
            serde_json::to_vec(&json!({"settings": {"general": {"daemon": "invalid"}}}))
                .expect("typed error document"),
        )
        .expect("test file");
        assert!(repository.load().is_err());
    }
}
