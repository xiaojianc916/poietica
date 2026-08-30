//! What the agent says on its own error stream.
//!
//! An agent is free to report a failure of its own and still end the turn
//! normally: Kimi answers a rejected provider request that way. The protocol
//! carries nothing in that case, so the only account of what happened is the
//! text the process wrote to its standard error, and a client that discards
//! it has nothing to show but a guess.
//!
//! The record is bounded on purpose. An agent can be chatty for an hour, and
//! only the end of that is ever an explanation.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

/// How many lines are kept.
const LINE_LIMIT: usize = 40;

/// How much of a single line is kept.
const LINE_WIDTH: usize = 2000;

/// A shared, bounded tail of the agent process error stream.
///
/// Cheap to clone: every clone reads and writes the same record.
#[derive(Clone, Debug, Default)]
pub(crate) struct StderrLog {
    lines: Arc<Mutex<VecDeque<String>>>,
}

impl StderrLog {
    /// An empty record.
    #[must_use]
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Keeps one line, dropping the oldest once the record is full.
    ///
    /// Blank lines are skipped: they carry no account of anything and would
    /// push a real one out of the record.
    pub(crate) fn push(&self, line: &str) {
        let trimmed = line.trim_end();

        if trimmed.trim().is_empty() {
            return;
        }

        // A poisoned record is a record we can no longer trust; losing
        // diagnostics is never worth failing a turn over.
        let Ok(mut lines) = self.lines.lock() else {
            return;
        };

        let kept = match trimmed.char_indices().nth(LINE_WIDTH) {
            None => trimmed.to_owned(),
            Some((cut, _char)) => trimmed.get(..cut).unwrap_or_default().to_owned(),
        };

        if lines.len() >= LINE_LIMIT {
            let _oldest = lines.pop_front();
        }

        lines.push_back(kept);
    }

    /// The record as one block of text, oldest line first.
    #[must_use]
    pub(crate) fn tail(&self) -> String {
        let Ok(lines) = self.lines.lock() else {
            return String::new();
        };

        lines
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("\n")
    }
}
