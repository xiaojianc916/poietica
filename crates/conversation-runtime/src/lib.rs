//! Host-independent conversation execution.

pub mod automation;
mod delivery;
mod submission;
pub use submission::{Submission, TITLE_CHARS, submit};
pub mod disposal;
pub mod gateway;
pub mod journal;
pub mod session;

pub use delivery::{DeliveryError, RecoveryFailure, deliver, recover};
