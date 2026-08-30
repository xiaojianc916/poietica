use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Url};
use tauri_specta::Event;

use super::PICKER_CANCEL_SCRIPT;
use super::bridge::{BrowserHost, publish};
use super::child_view::run_in_page;
use super::lock;
use crate::paths::write_element_report;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum BrowserPickSubmission {
    Attach,
    Send,
}

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct BrowserElementPicked {
    pub tab_id: u32,
    pub submission: BrowserPickSubmission,
    /// 一行身份，进提示词正文。
    pub summary: String,
    pub comment: String,
    /// 完整快照落在系统临时目录里的这份文件上；提示词只带路径。
    pub report_path: String,
}

pub(super) fn stop_picker(app: &AppHandle, tab_id: Option<u32>) -> bool {
    let lease = {
        let host = app.state::<BrowserHost>();
        let mut picker = lock(&host.picker);
        match tab_id {
            Some(id) => picker.cancel(id),
            None => picker.cancel_active(),
        }
    };
    let Some(lease) = lease else {
        return false;
    };
    let _ = run_in_page(app, lease.tab_id(), PICKER_CANCEL_SCRIPT);
    true
}

pub(super) fn stop_picker_unless(app: &AppHandle, tab_id: u32) {
    let active = lock(&app.state::<BrowserHost>().picker).active_tab_id();
    if active.is_some() && active != Some(tab_id) {
        stop_picker(app, None);
    }
}

pub(super) fn disarm_picker(app: &AppHandle, tab_id: u32) {
    let host = app.state::<BrowserHost>();
    let _ = lock(&host.picker).cancel(tab_id);
}

pub(super) fn finish_pick(app: &AppHandle, tab_id: u32, target: &Url) {
    let Some(outcome) = poietica_browser_native::decode_picker_callback(target) else {
        log::warn!("browser tab {tab_id} returned an invalid picker payload");
        return;
    };
    let accepted = {
        let host = app.state::<BrowserHost>();
        lock(&host.picker).finish(tab_id, outcome.token())
    };
    if !accepted {
        log::warn!("browser tab {tab_id} returned a stale picker payload");
        return;
    }

    if let poietica_browser_native::PickOutcome::Submitted {
        submission,
        element,
        ..
    } = outcome
    {
        match write_element_report(&element.report) {
            Ok(path) => {
                let picked = BrowserElementPicked {
                    tab_id,
                    submission: match submission {
                        poietica_browser_native::PickSubmission::Attach => {
                            BrowserPickSubmission::Attach
                        }
                        poietica_browser_native::PickSubmission::Send => {
                            BrowserPickSubmission::Send
                        }
                    },
                    summary: element.summary,
                    comment: element.comment,
                    report_path: path.to_string_lossy().into_owned(),
                };
                if let Err(error) = picked.emit(app) {
                    log::warn!("browser element pick was not delivered: {error}");
                }
            }
            Err(error) => log::warn!("browser element report was not written: {error}"),
        }
    }
    publish(app);
}
