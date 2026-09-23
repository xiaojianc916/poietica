//! 子进程这条命：定位（program，含随包发的边车）、起与收尸（supervisor）、
//! stderr 探针、守护相位（daemon）、受控 home 的判读与写入（controlled_home）、
//! 接入档案的判读（profile）、运行时的安装与更新（install），以及它那个 agents
//! 目录（custom_agents）。

pub(crate) mod controlled_home;
pub(crate) mod custom_agents;
pub(crate) mod daemon;
pub(crate) mod install;
pub(crate) mod profile;
pub(crate) mod program;
pub(crate) mod stderr_probe;
pub(crate) mod supervisor;
