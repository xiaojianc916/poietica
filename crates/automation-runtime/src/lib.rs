//! Native execution ownership. The ledger is authoritative; the executor performs conversation operations.
mod execution;
mod scheduler;

use poietica_automation::Execution;
pub use scheduler::Runtime;
use std::fmt::Display;
use std::future::Future;
use std::time::Duration;

const POLL: Duration = Duration::from_secs(2);
const CALL_LIMIT: Duration = Duration::from_secs(90);
const PARALLELISM: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Observation {
    Active,
    Succeeded,
    Failed,
    Cancelled,
    Missing,
}

pub trait Executor: Send + Sync + 'static {
    type Failure: Display + Send;
    fn default_agent(&self) -> Result<String, Self::Failure>;
    fn submit(
        &self,
        execution: &Execution,
    ) -> impl Future<Output = Result<String, Self::Failure>> + Send;
    fn inspect(
        &self,
        execution: &Execution,
    ) -> impl Future<Output = Result<Observation, Self::Failure>> + Send;
    fn cancel(
        &self,
        execution: &Execution,
    ) -> impl Future<Output = Result<(), Self::Failure>> + Send;
}
