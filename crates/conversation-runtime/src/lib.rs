//! Host-independent conversation execution.

pub mod catalog;
pub mod connection;
mod delivery;
mod events;
mod submission;
pub use submission::TITLE_CHARS;
pub mod disposal;
mod gateway;
pub mod journal;
pub mod session;

pub use delivery::DeliveryError;
