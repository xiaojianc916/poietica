/// 键名里出现这些词的值不再原样外传。
const SENSITIVE: &[&str] = &[
    "authorization",
    "cookie",
    "credential",
    "key",
    "password",
    "secret",
    "token",
];

/// 单条细节的长度上限，按字符截断，避免把半个码点写进账本。
const MAX_CHARS: usize = 256;

pub fn redact(key: &str, value: &str) -> String {
    let lowered = key.to_ascii_lowercase();

    if SENSITIVE.iter().any(|marker| lowered.contains(marker)) {
        return "[redacted]".to_owned();
    }

    if value.chars().count() <= MAX_CHARS {
        return value.to_owned();
    }

    value.chars().take(MAX_CHARS).collect()
}
