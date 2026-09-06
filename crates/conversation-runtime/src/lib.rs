mod connection;
pub use connection::{LaunchRequest, RuntimeError, Takeover};
/// Host-independent conversation execution.
pub mod catalog;
mod runtime;
pub use poietica_kap_client::{ConfigSelection, PromptObservation};
pub use runtime::{
    CommandError, DeletedThread, ExportSource, ForkThread, OpenThread, OpenedThread, Prompt,
    PromptReceipt, Runtime, RuntimeFailure, SessionAction, ThreadTarget,
};
mod delivery;
mod events;
mod submission;
pub use submission::TITLE_CHARS;
pub mod disposal;
mod gateway;
pub mod journal;
mod session;
pub mod toolkit;
pub use session::{SessionError, SessionHistory};

pub use delivery::DeliveryError;
