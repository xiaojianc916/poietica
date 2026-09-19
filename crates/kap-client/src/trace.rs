use std::env;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::sync::{Arc, Mutex};

/// Names the file every line of the conversation is copied to, when set.
///
/// Absent or blank means none: a trace holds whatever the agent said, so it is
/// opt-in and never left on by default.
const TRACE: &str = "POIETICA_KAP_TRACE";

/// Where traced lines are appended.
pub(crate) type TraceSink = Arc<Mutex<BufWriter<File>>>;

/// Opens the trace file the environment names, if it names one.
///
/// Opened once per connection: a streaming turn emits thousands of frames, and
/// re-opening per frame puts open/write/close on every answer's hot path. A
/// path that cannot be opened means no trace, same as an absent variable.
pub(crate) fn open_trace() -> Option<TraceSink> {
    env::var(TRACE)
        .ok()
        .filter(|path| !path.trim().is_empty())
        .and_then(|path| OpenOptions::new().create(true).append(true).open(path).ok())
        .map(|file| Arc::new(Mutex::new(BufWriter::new(file))))
}

/// Appends one observed line to the trace file. Write errors are dropped on
/// purpose: a trace is not worth failing a session over.
pub(crate) fn trace(sink: &Mutex<BufWriter<File>>, label: &str, line: &str) {
    if let Ok(mut file) = sink.lock() {
        let _ignored = writeln!(file, "{label} {line}");
        let _ignored = file.flush();
    }
}
