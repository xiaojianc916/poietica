use std::env;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::sync::{Arc, Mutex};

/// Names the file every line of the conversation is copied to, when set.
///
/// Absent or blank means no trace at all. A trace holds whatever the agent
/// said, so it is asked for deliberately and never left on by default.
const TRACE: &str = "POIETICA_KAP_TRACE";

/// Where traced lines are appended.
pub(crate) type TraceSink = Arc<Mutex<BufWriter<File>>>;

/// Opens the trace file the environment names, if it names one.
///
/// Opened once for the whole connection. A streaming turn emits thousands of
/// frames, and re-opening the file for each of them puts an open, a write and
/// a close on the hot path of every answer.
///
/// A path that cannot be opened means no trace, which is what an absent
/// variable already means.
pub(crate) fn open_trace() -> Option<TraceSink> {
    env::var(TRACE)
        .ok()
        .filter(|path| !path.trim().is_empty())
        .and_then(|path| OpenOptions::new().create(true).append(true).open(path).ok())
        .map(|file| Arc::new(Mutex::new(BufWriter::new(file))))
}

/// Appends one observed line to the trace file.
///
/// A trace that cannot be written is not worth failing a session over, so
/// every error here is dropped on purpose.
pub(crate) fn trace(sink: &Mutex<BufWriter<File>>, label: &str, line: &str) {
    if let Ok(mut file) = sink.lock() {
        let _ignored = writeln!(file, "{label} {line}");
        let _ignored = file.flush();
    }
}
