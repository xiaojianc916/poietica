//! 子进程这条命：定位（program）、起与收尸（supervisor）、实例注册表
//! （instance_registry）、stderr 探针、守护相位（daemon），以及它那个受控
//! home 的判读（controlled_home）与 agents 目录（custom_agents）。

pub(crate) mod controlled_home;
pub(crate) mod custom_agents;
pub(crate) mod daemon;
pub(crate) mod instance_registry;
pub(crate) mod program;
pub(crate) mod stderr_probe;
pub(crate) mod supervisor;
