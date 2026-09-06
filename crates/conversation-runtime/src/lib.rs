//! Host-independent conversation execution.

pub mod catalog;
mod runtime;
pub use poietica_kap_client::{ConfigSelection, PromptObservation};
pub use runtime::{
    CommandError, DeletedThread, ExportSource, ForkThread, LaunchRequest, OpenThread, OpenedThread,
    Prompt, PromptReceipt, Runtime, RuntimeError, RuntimeFailure, SessionAction, Takeover,
    ThreadTarget,
};
mod delivery;
mod events;
mod submission;
pub use submission::TITLE_CHARS;
pub mod disposal;
mod gateway;
pub mod journal;
mod session;
pub use session::{SessionError, SessionHistory};

pub use delivery::DeliveryError;
