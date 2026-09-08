use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

pub(crate) fn read_file_metadata(path: &Path) -> Result<(Option<u64>, Option<u64>, u64), String> {
    let metadata =
        fs::metadata(path).map_err(|e| format!("Failed to stat {}: {}", path.display(), e))?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    let created_at = metadata
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    Ok((modified_at, created_at, metadata.len()))
}

fn invalid_utf8_text_error(path: &Path) -> String {
    format!("File is not valid UTF-8 text: {}", path.display())
}

fn read_existing_note_bytes(path: &Path) -> Result<Vec<u8>, String> {
    if !path.exists() {
        return Err(format!("File does not exist: {}", path.display()));
    }
    if !path.is_file() {
        return Err(format!("Path is not a file: {}", path.display()));
    }
    fs::read(path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))
}

pub(crate) fn get_note_content(path: &Path) -> Result<String, String> {
    let bytes = read_existing_note_bytes(path)?;
    String::from_utf8(bytes).map_err(|_| invalid_utf8_text_error(path))
}

pub(crate) fn note_content_matches(path: &Path, expected_content: &str) -> Result<bool, String> {
    let bytes = read_existing_note_bytes(path)?;
    Ok(bytes == expected_content.as_bytes())
}
