//! Host-independent conversation execution.

mod delivery;
pub mod disposal;
pub mod gateway;
pub mod journal;
pub mod session;

pub use delivery::{DeliveryError, RecoveryFailure, deliver, recover};
