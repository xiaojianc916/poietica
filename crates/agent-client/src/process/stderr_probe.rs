//! The agent's stderr is the only account when it fails on its own yet ends the turn normally (omp does).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

const LINE_LIMIT: usize = 40;

const LINE_WIDTH: usize = 2000;

#[derive(Clone, Debug, Default)]
pub(crate) struct StderrLog {
    lines: Arc<Mutex<VecDeque<String>>>,
}

impl StderrLog {
    #[must_use]
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn push(&self, line: &str) {
        let trimmed = line.trim_end();

        if trimmed.trim().is_empty() {
            return;
        }

        // A poisoned record is no longer trusted; losing diagnostics is never worth failing a turn over.
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
