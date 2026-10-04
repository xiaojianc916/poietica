//! 应用日志：进程里唯一的落盘出口。
//!
//! 事件面是 `tracing` 的，落盘是 `tracing-subscriber` + `tracing-appender` 的。
//! 这个文件只做两件本地的事：
//! 1. 决定日志留在哪、留几份、什么时候换新的一份（当日一份、留 7 份）；
//! 2. 在**写进文件之前**脱敏 —— 密钥与用户目录不落盘是产品不变量，不能交给上游自觉。
//!
//! 形状是 JSON Lines：一行一条、追加写。字段名对齐 OTel Logs 数据模型
//! （`timestamp` / `level` / `target` / `message`），于是将来真要接一个 filelog
//! receiver，吃的是同一份文件。
//!
//! `tracing-subscriber` 的 `json()` 那一层被 `RedactedJson` 替掉了：官方那版没有
//! 「写之前改一改文本」的钩子，而脱敏必须在写之前发生。轮转、级别、非阻塞写入仍旧
//! 全是 `tracing-appender` 与 `reload`/`EnvFilter` 的官方实现。
//!
//! # 级别是活的
//!
//! 闸门由设置里那一格（`AppSettings.logging.level`）定，默认 warn。用户改了它不必重启
//! 应用：`reload` 层拿在手里，换的只是那一个 `EnvFilter` —— 订阅器、写入器、轮转
//! 全部原地不动。`RUST_LOG` 仍然优先于设置（它是排查时的临时覆盖，不该被设置压过去）。
//!
//! # 顺序即不变量
//!
//! `install` 只调一次（`bootstrap`），此前与此时失败都不 panic：装不上就退回 stderr，
//! 应用照常启动。日志不该能把要记录的那个进程带下去。

use std::path::Path;

use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::{FmtContext, FormatEvent, FormatFields, FormattedFields};
use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::reload;
use tracing_subscriber::util::SubscriberInitExt as _;
use tracing_subscriber::{EnvFilter, fmt};

/// 日志文件名。轮转出来的那一份在它后面接日期。
///
/// **与主进程那份分开**：两边各是一个库的写入器，各有各的轮转与格式。写同一个文件
/// 等于两套轮转各按自己的判断改名/截断，会互相吃掉对方的行。原生这份是 poietica.log，
/// 主进程那份是 main.log，同一个目录里两份都在。
const FILE_NAME: &str = "poietica.log";

/// 留几份。一天一份，7 份即一周；总占用有上界（单份大小由写入量决定，量级是几十 KB/天）。
const MAX_LOG_FILES: usize = 7;

/// 单条消息的上限：一条日志不该能把一个文件撑满。
const MAX_MESSAGE_LENGTH: usize = 4_000;

const MAX_TARGET_LENGTH: usize = 120;

/// 与 packages/problem/src/diagnostics/buffer.ts 的 SENSITIVE_KEY_PATTERN 同一条判据。
const SENSITIVE_KEY_MARKERS: [&str; 8] = [
    "token",
    "secret",
    "password",
    "authorization",
    "cookie",
    "license",
    "apikey",
    "credential",
];

const BEARER_PREFIX: &str = "bearer ";
const URL_CREDENTIAL_MARKER: &str = "://";
const USER_PATH_MARKERS: [&str; 3] = ["\\users\\", "/users/", "/home/"];

const REDACTED: &str = "[REDACTED]";

/// 非阻塞写入器的后台线程守卫：丢了它，进程退出时最后几条会丢。
static GUARD: std::sync::OnceLock<WorkerGuard> = std::sync::OnceLock::new();

/// 级别闸门的活门。装上之后由 `set_level` 换里面那个 `EnvFilter`。
static LEVEL: std::sync::OnceLock<reload::Handle<EnvFilter, tracing_subscriber::Registry>> =
    std::sync::OnceLock::new();

/// 装上落盘出口。`NativeHost.start` 只调一次；装第二次是空操作。
///
/// `level` 是此刻生效的闸门（来自设置里那一格）。换它走 `set_level`，不必重启。
pub(crate) fn install(directory: &Path, level: &str) -> Result<(), std::io::Error> {
    std::fs::create_dir_all(directory)?;

    let appender = tracing_appender::rolling::Builder::new()
        .filename_prefix(FILE_NAME)
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .max_log_files(MAX_LOG_FILES)
        /* InitError 是 appender 自己的初始化错误（目录不可写、名字非法），它就在包装 io。 */
        .build(directory)
        .map_err(std::io::Error::other)?;

    let (writer, guard) = tracing_appender::non_blocking(appender);

    /* RUST_LOG 优先：它是排查时的临时覆盖，不该被设置里那一格压过去。 */
    let (filter, handle) = reload::Layer::new(
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(level)),
    );

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().event_format(RedactedJson).with_writer(writer))
        .try_init()
        .ok();

    let _already_installed = GUARD.set(guard);
    let _already_level = LEVEL.set(handle);

    Ok(())
}

/// 换掉级别闸门。设置里那一格改了就走这里，订阅器与写入器原地不动。
///
/// 装不上（`install` 之前调用）时静默返回 —— 与调用点的 `tracing::warn!` 同一个纪律：
/// 日志装不上不该让「改设置」这一次操作失败。
pub(crate) fn set_level(level: &str) {
    if let Some(handle) = LEVEL.get() {
        let _applied = handle.reload(EnvFilter::new(level));
    }
}

/// 一个 `FormatEvent`：按官方 JSON 的字段名写，且每条都过脱敏。
///
/// 自己写而不是用官方的 `format::Json`，是因为脱敏必须发生在**写之前**：密钥一旦进了
/// 文件就没有补救，而官方的 JSON `Format` 没有插手正文的钩子。
struct RedactedJson;

impl<S, N> FormatEvent<S, N> for RedactedJson
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
    N: for<'writer> FormatFields<'writer> + 'static,
{
    fn format_event(
        &self,
        context: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> std::fmt::Result {
        let metadata = event.metadata();
        let mut visitor = Fields::default();

        event.record(&mut visitor);

        let message = sanitize(&visitor.message, MAX_MESSAGE_LENGTH);
        let target = sanitize(metadata.target(), MAX_TARGET_LENGTH);

        write!(
            writer,
            "{{\"timestamp\":\"{}\",\"level\":\"{}\",\"target\":\"{}\",\"message\":\"{}\"",
            timestamp(),
            metadata.level(),
            escape(&target),
            escape(&message)
        )?;

        /* span 里的字段（如果有）挂成 fields：排查时要的是「这件事发生在哪个会话/连接上」。 */
        if let Some(span) = context.lookup_current() {
            let extensions = span.extensions();

            if let Some(fields) = extensions.get::<FormattedFields<N>>() {
                let rendered = fields.fields.trim();

                if !rendered.is_empty() {
                    write!(
                        writer,
                        ",\"span\":\"{}\"",
                        escape(&sanitize(rendered, MAX_MESSAGE_LENGTH))
                    )?;
                }
            }
        }

        if !visitor.extra.is_empty() {
            write!(writer, ",\"fields\":{{")?;

            for (index, (name, value)) in visitor.extra.iter().enumerate() {
                if index > 0 {
                    writer.write_char(',')?;
                }

                write!(
                    writer,
                    "\"{}\":\"{}\"",
                    escape(name),
                    escape(&sanitize(value, MAX_MESSAGE_LENGTH))
                )?;
            }

            writer.write_char('}')?;
        }

        writeln!(writer, "}}")
    }
}

/// 事件里的字段：`message` 单独一格，其余收进 `fields`。
///
/// 其余字段**必须收**：`tracing::warn!(session = %id, "…")` 这类结构化事件一旦被丢，
/// 排查时看到的就是一句没有主语的句子。全部按字符串收（`record_debug` 已经渲染好）。
#[derive(Default)]
struct Fields {
    message: String,
    extra: Vec<(String, String)>,
}

impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let rendered = format!("{value:?}");

        self.push(field.name(), rendered);
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.push(field.name(), value.to_owned());
    }
}

impl Fields {
    fn push(&mut self, name: &str, value: String) {
        if name == "message" {
            self.message = value;
            return;
        }

        self.extra.push((name.to_owned(), value));
    }
}

/// 脱敏：可能带密钥的片段先换掉，再按长度截断。
fn sanitize(value: &str, maximum_length: usize) -> String {
    let redacted = redact(value);

    if redacted.len() <= maximum_length {
        return redacted;
    }

    format!("{}…", head(&redacted, maximum_length))
}

fn redact(value: &str) -> String {
    let mut result = value.to_owned();

    // URL 里的 user:password@ —— 整体遮掉，用户名与口令都不留。
    if result.contains(URL_CREDENTIAL_MARKER) {
        result = redact_url_credentials(&result);
    }

    // Bearer 之后的 token 到第一个空白为止。
    result = redact_after_marker(&result, BEARER_PREFIX);

    result = redact_keyed_pairs(&result);

    for marker in USER_PATH_MARKERS {
        result = redact_user_path(&result, marker);
    }

    result
}

fn redact_url_credentials(value: &str) -> String {
    let mut result = String::with_capacity(value.len());

    for segment in value.split("://") {
        if result.is_empty() {
            result.push_str(segment);
            continue;
        }

        result.push_str("://");

        /* 一律走 split_at_checked：字节下标落在一个多字节字符中间时它回 None，不 panic。 */
        let authority_end = segment
            .find(['/', '?', '#', ' ', '"'])
            .unwrap_or(segment.len());

        let Some((authority, rest)) = segment.split_at_checked(authority_end) else {
            result.push_str(segment);
            continue;
        };

        if let Some(at) = authority.find('@') {
            result.push_str(REDACTED);
            result.push_str(authority.get(at..).unwrap_or_default());
        } else {
            result.push_str(authority);
        }

        result.push_str(rest);
    }

    result
}

fn redact_after_marker(value: &str, marker: &str) -> String {
    let mut result = value.to_owned();
    let mut search_from = 0_usize;

    while let Some(tail) = result.get(search_from..) {
        let Some(found) = tail.to_ascii_lowercase().find(marker) else {
            break;
        };

        let start = search_from + found + marker.len();

        let Some(secret) = result.get(start..) else {
            break;
        };

        let end = start + secret.find(char::is_whitespace).unwrap_or(secret.len());

        result.replace_range(start..end, REDACTED);
        search_from = start + REDACTED.len();
    }

    result
}

/// `key=value` 形态里键名敏感的，值整段遮掉。
fn redact_keyed_pairs(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut rest = value;

    while let Some(index) = rest.find(['=', ':']) {
        let (head_part, tail) = rest.split_at(index);

        let key_start = head_part
            .rfind(|character: char| {
                !character.is_alphanumeric() && character != '_' && character != '-'
            })
            .and_then(|offset| offset.checked_add(1))
            .unwrap_or(0);

        let key = head_part
            .get(key_start..)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let sensitive = SENSITIVE_KEY_MARKERS
            .iter()
            .any(|marker| key.contains(marker));

        result.push_str(head_part);

        let separator = tail.chars().next().unwrap_or('=');
        let remainder = tail.get(separator.len_utf8()..).unwrap_or_default();

        result.push(separator);

        if !sensitive {
            rest = remainder;
            continue;
        }

        let value_end = remainder
            .find(|character: char| {
                character.is_whitespace() || character == ',' || character == '}'
            })
            .unwrap_or(remainder.len());

        result.push_str(REDACTED);
        rest = remainder.get(value_end..).unwrap_or_default();
    }

    result.push_str(rest);
    result
}

fn redact_user_path(value: &str, marker: &str) -> String {
    let lowercase = value.to_ascii_lowercase();
    let mut result = value.to_owned();
    let mut search_from = 0_usize;

    while let Some(tail) = lowercase.get(search_from..) {
        let Some(found) = tail.find(marker) else {
            break;
        };

        let start = search_from + found + marker.len();

        let Some(name) = result.get(start..) else {
            break;
        };

        let end = start
            + name
                .find(['\\', '/', '"', ' ', '\n', '\t'])
                .unwrap_or(name.len());

        if end > start {
            result.replace_range(start..end, REDACTED);
            search_from = start + REDACTED.len();
            continue;
        }

        search_from = end.checked_add(1).unwrap_or(result.len());
    }

    result
}

/// JSON 字符串里必须转义的五个字符，加上控制字符。
fn escape(value: &str) -> String {
    let mut result = String::with_capacity(value.len());

    for character in value.chars() {
        match character {
            '"' => result.push_str("\\\""),
            '\\' => result.push_str("\\\\"),
            '\n' => result.push_str("\\n"),
            '\r' => result.push_str("\\r"),
            '\t' => result.push_str("\\t"),
            control if control < ' ' => result.push(' '),
            other => result.push(other),
        }
    }

    result
}

/// 按字符边界取前 `maximum` 个字符：字节切会把一个中文字符劈成两半，写出坏 JSON。
fn head(value: &str, maximum: usize) -> &str {
    match value.char_indices().nth(maximum) {
        Some((offset, _)) => value.split_at_checked(offset).map_or("", |(head, _)| head),
        None => value,
    }
}

/// RFC 3339 到毫秒。自己算是为了不让这个文件依赖时区库 —— 时间戳只回答「多前」。
fn timestamp() -> String {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let millis = elapsed.subsec_millis();

    format_iso(elapsed.as_secs(), millis)
}

fn format_iso(seconds: u64, millis: u32) -> String {
    let days = seconds / 86_400;
    let remaining = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);

    let hour = remaining / 3_600;
    let minute = (remaining % 3_600) / 60;
    let second = remaining % 60;

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// 天数 → 年月日（Howard Hinnant 的 civil_from_days）。
fn civil_from_days(days: u64) -> (i64, u64, u64) {
    let z = i64::try_from(days).unwrap_or(i64::MAX) + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };

    (
        year + i64::from(month <= 2),
        u64::try_from(month).unwrap_or(1),
        u64::try_from(day).unwrap_or(1),
    )
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "测试作用域：断言必须当场炸"
)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_rfc3339() {
        assert_eq!(format_iso(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_iso(1_000_000_000, 500), "2001-09-09T01:46:40.500Z");
    }

    #[test]
    fn redacts_credentials() {
        assert!(redact("Authorization: Bearer abc.def").contains(REDACTED));
        assert!(!redact("Authorization: Bearer abc.def").contains("abc.def"));
        assert!(!redact("https://user:pass@example.com/x").contains("pass"));
        assert!(redact(r"open C:\Users\alice\secret.txt").contains(REDACTED));
        assert!(!redact(r"open C:\Users\alice\secret.txt").contains("alice"));
    }

    #[test]
    fn keeps_ordinary_text_intact() {
        assert_eq!(
            redact("the ledger rejected a statement: no such table"),
            "the ledger rejected a statement: no such table"
        );
        assert_eq!(redact("base=2 retry=3"), "base=2 retry=3");
    }

    /// 走**真正的格式器**，不是手拼一行再验它。
    ///
    /// 判例：手拼的那一版测试全绿，而 format_event 里 `"file":"{}":{}` 少了一对引号，
    /// 落盘出来的每一行带 file 的日志都是坏 JSON —— 测试没有覆盖被验的那个函数。
    /// 这里用真实的 subscriber 装配，逐行吃掉盘上那份文件再解析，形状对不上就当场炸。
    #[test]
    fn every_written_line_is_valid_json() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("log.jsonl");

        {
            let file = std::fs::File::create(&path).unwrap();
            let subscriber = fmt()
                .event_format(RedactedJson)
                .with_writer(move || file.try_clone().unwrap())
                .finish();

            tracing::subscriber::with_default(subscriber, || {
                tracing::error!("a \"quoted\" \n line with Authorization: Bearer abc.def");
                tracing::warn!(secret = "hunter2", "a structured field");
            });
        }

        let text = std::fs::read_to_string(&path).unwrap();

        assert!(!text.trim().is_empty(), "格式器一行都没写出来");

        let parsed: Vec<serde_json::Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();

        assert_eq!(parsed.len(), 2, "两条事件该落成两行");

        for entry in &parsed {
            assert!(entry["timestamp"].is_string(), "缺 timestamp：{entry}");
            assert!(entry["level"].is_string(), "缺 level：{entry}");
            assert!(entry["target"].is_string(), "缺 target：{entry}");
            assert!(entry["message"].is_string(), "缺 message：{entry}");
        }

        /* 凭据一个字符都不许落盘：连键名带值都被换掉了。 */
        assert!(!text.contains("abc.def"), "凭据落盘了：{text}");

        /* 结构化字段必须留下：丢了它，排查时只看到一句没有主语的句子。 */
        assert_eq!(
            parsed[1]["fields"]["secret"], "hunter2",
            "结构化字段丢了：{text}"
        );
    }

    /// 档门是活的：换掉之后同一条 info 从「不落」变成「落」。
    ///
    /// 直接验 `reload` 这个原语 —— `install` 用全局订阅器，一个进程只装得上一次，
    /// 而这条依赖的正是「换 filter 不必重建订阅器」这个性质。
    #[test]
    fn the_gateway_can_be_swapped_without_reinstalling() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("gate.jsonl");
        let file = std::fs::File::create(&path).unwrap();

        let (filter, handle) = reload::Layer::new(EnvFilter::new("warn"));
        let subscriber = tracing_subscriber::registry().with(filter).with(
            fmt::layer()
                .event_format(RedactedJson)
                .with_writer(move || file.try_clone().unwrap()),
        );

        tracing::subscriber::with_default(subscriber, || {
            tracing::info!("before the swap");

            handle.reload(EnvFilter::new("info")).unwrap();

            tracing::info!("after the swap");
        });

        let text = std::fs::read_to_string(&path).unwrap();

        assert!(
            !text.contains("before the swap"),
            "warn 档不该收 info：{text}"
        );
        assert!(
            text.contains("after the swap"),
            "换成 info 档之后该收：{text}"
        );
    }

    #[test]
    fn truncation_lands_on_character_boundaries() {
        let text = "中文".repeat(100);
        let cut = head(&text, 5);

        assert_eq!(cut.chars().count(), 5);
        assert_eq!(cut, "中文中文中");
    }
}
