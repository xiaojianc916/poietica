//! 浏览器临时表面的原生宿主。

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_specta::Event;

use crate::bootstrap::app::MAIN_WINDOW;
use crate::error::{Error, IpcError, Result};

const POPUP_WINDOW: &str = "browser-popup";
const POPUP_DOCUMENT: &str = "browser-popup.html";
const MAX_POPUP_SIZE: f64 = 1_024.0;
const MAX_PANES: usize = 256;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum BrowserPopupKind {
    Overflow,
    Tabs,
}

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPopupPane {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPopupRequest {
    pub kind: BrowserPopupKind,
    pub theme: String,
    pub panes: Vec<BrowserPopupPane>,
    pub active_pane_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum BrowserPopupActionKind {
    SelectPane,
    ClosePane,
    SelectTab,
    CloseTab,
    ReopenClosed,
}

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPopupAction {
    pub action: BrowserPopupActionKind,
    pub pane_id: Option<String>,
    pub tab_id: Option<u32>,
    pub index: Option<u32>,
}

#[derive(Debug, Default)]
pub struct BrowserPopupHost {
    request: Mutex<Option<BrowserPopupRequest>>,
    /// 浮层文档是否已经取过请求。取到之前窗口还没有画面，那段时间里的失焦是内核
    /// 在交接焦点，不是用户要关闭它。
    armed: std::sync::atomic::AtomicBool,
}

impl BrowserPopupHost {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<BrowserPopupRequest>> {
        self.request
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn snapshot(&self) -> Option<BrowserPopupRequest> {
        self.lock().clone()
    }

    fn replace(&self, request: BrowserPopupRequest) {
        *self.lock() = Some(request);
    }

    fn arm(&self, armed: bool) {
        self.armed.store(armed, std::sync::atomic::Ordering::Release);
    }

    fn armed(&self) -> bool {
        self.armed.load(std::sync::atomic::Ordering::Acquire)
    }


    fn take(&self) -> Option<BrowserPopupRequest> {
        self.lock().take()
    }

    fn accepts_action(&self, action: &BrowserPopupAction) -> bool {
        let request = self.lock();
        let Some(request) = request.as_ref() else {
            return false;
        };

        match action.action {
            BrowserPopupActionKind::SelectPane | BrowserPopupActionKind::ClosePane => {
                action.tab_id.is_none()
                    && action.index.is_none()
                    && action.pane_id.as_ref().is_some_and(|pane_id| {
                        request.panes.iter().any(|pane| &pane.id == pane_id)
                    })
            }
            BrowserPopupActionKind::SelectTab | BrowserPopupActionKind::CloseTab => {
                request.kind == BrowserPopupKind::Tabs
                    && action.pane_id.is_none()
                    && action.tab_id.is_some()
                    && action.index.is_none()
            }
            BrowserPopupActionKind::ReopenClosed => {
                request.kind == BrowserPopupKind::Tabs
                    && action.pane_id.is_none()
                    && action.tab_id.is_none()
                    && action.index.is_some()
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct PopupGeometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn validate(request: &BrowserPopupRequest, geometry: PopupGeometry) -> Result<()> {
    let values = [geometry.x, geometry.y, geometry.width, geometry.height];
    if !values.into_iter().all(f64::is_finite)
        || !(1.0..=MAX_POPUP_SIZE).contains(&geometry.width)
        || !(1.0..=MAX_POPUP_SIZE).contains(&geometry.height)
    {
        return Err(Error::Validation("invalid browser popup geometry".to_owned()));
    }

    let valid_theme = !request.theme.is_empty()
        && request.theme.len() <= 32
        && request
            .theme
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    if !valid_theme || request.panes.len() > MAX_PANES {
        return Err(Error::Validation("invalid browser popup request".to_owned()));
    }

    if request.panes.iter().any(|pane| {
        pane.id.trim().is_empty()
            || pane.id.len() > 256
            || pane.title.len() > 512
    }) {
        return Err(Error::Validation("invalid browser popup pane".to_owned()));
    }

    match request.kind {
        BrowserPopupKind::Overflow
            if !request.panes.is_empty() || request.active_pane_id.is_some() =>
        {
            Err(Error::Validation(
                "overflow popup cannot carry pane state".to_owned(),
            ))
        }
        BrowserPopupKind::Tabs
            if request.active_pane_id.as_ref().is_some_and(|active| {
                !request.panes.iter().any(|pane| &pane.id == active)
            }) =>
        {
            Err(Error::Validation(
                "active popup pane is not in the pane snapshot".to_owned(),
            ))
        }
        _ => Ok(()),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn open_browser_popup(
    app: AppHandle,
    request: BrowserPopupRequest,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> std::result::Result<(), IpcError> {
    let geometry = PopupGeometry {
        x,
        y,
        width,
        height,
    };
    validate(&request, geometry)?;
    dismiss(&app)?;

    let main = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| Error::NotFound("main window".to_owned()))?;
    let origin = main
        .inner_position()
        .map_err(Error::from)?
        .to_logical::<f64>(main.scale_factor().map_err(Error::from)?);

    let builder = WebviewWindowBuilder::new(
        &app,
        POPUP_WINDOW,
        WebviewUrl::App(POPUP_DOCUMENT.into()),
    )
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .skip_taskbar(true)
    .resizable(false)
    .prevent_overflow()
    .inner_size(geometry.width, geometry.height)
    .position(origin.x + geometry.x, origin.y + geometry.y)
    .focused(true)
    .parent(&main)
    .map_err(Error::from)?;

    app.state::<BrowserPopupHost>().arm(false);
    app.state::<BrowserPopupHost>().arm(false);
    app.state::<BrowserPopupHost>().replace(request);

    match builder.build() {
        Ok(window) => {
            let handle = app.clone();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::Focused(false))
                    && handle.state::<BrowserPopupHost>().armed()
                    && let Err(error) = dismiss(&handle)
                {
                    log::warn!("browser popup did not close after focus loss: {error}");
                }
            });
            Ok(())
        }
        Err(error) => {
            app.state::<BrowserPopupHost>().take();
            Err(Error::from(error).into())
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn browser_popup_state(app: AppHandle) -> Option<BrowserPopupRequest> {
    let request = app.state::<BrowserPopupHost>().snapshot();

    /* 请求交出去的那一刻浮层才算立住，失焦关闭从这里开始生效。 */
    if request.is_some() {
        app.state::<BrowserPopupHost>().arm(true);
    }

    request
}

#[tauri::command]
#[specta::specta]
pub async fn browser_popup_dispatch_action(
    app: AppHandle,
    action: BrowserPopupAction,
) -> std::result::Result<(), IpcError> {
    if !app.state::<BrowserPopupHost>().accepts_action(&action) {
        return Err(Error::Validation("invalid browser popup action".to_owned()).into());
    }

    if let Err(error) = action.emit(&app) {
        log::warn!("browser popup action could not be delivered: {error}");
        return Err(Error::Internal(
            "browser popup action could not be delivered".to_owned(),
        ).into());
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn close_browser_popup(app: AppHandle) -> std::result::Result<(), IpcError> {
    Ok(dismiss(&app)?)
}

fn dismiss(app: &AppHandle) -> Result<()> {
    let host = app.state::<BrowserPopupHost>();
    let Some(request) = host.take() else {
        return Ok(());
    };

    if let Some(window) = app.get_webview_window(POPUP_WINDOW)
        && let Err(error) = window.destroy()
    {
        host.replace(request);
        return Err(error.into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        BrowserPopupKind, BrowserPopupPane, BrowserPopupRequest, PopupGeometry, validate,
    };

    fn tabs_request() -> BrowserPopupRequest {
        BrowserPopupRequest {
            kind: BrowserPopupKind::Tabs,
            theme: "light".to_owned(),
            panes: vec![BrowserPopupPane {
                id: "pane-1".to_owned(),
                title: "Pane".to_owned(),
            }],
            active_pane_id: Some("pane-1".to_owned()),
        }
    }

    #[test]
    fn valid_tabs_request_is_accepted() {
        assert!(
            validate(
                &tabs_request(),
                PopupGeometry {
                    x: 10.0,
                    y: 20.0,
                    width: 352.0,
                    height: 300.0,
                },
            )
            .is_ok()
        );
    }

    #[test]
    fn non_finite_geometry_is_rejected() {
        assert!(
            validate(
                &tabs_request(),
                PopupGeometry {
                    x: f64::NAN,
                    y: 20.0,
                    width: 352.0,
                    height: 300.0,
                },
            )
            .is_err()
        );
    }

    #[test]
    fn overflow_request_cannot_smuggle_panes() {
        let mut request = tabs_request();
        request.kind = BrowserPopupKind::Overflow;

        assert!(
            validate(
                &request,
                PopupGeometry {
                    x: 10.0,
                    y: 20.0,
                    width: 376.0,
                    height: 153.0,
                },
            )
            .is_err()
        );
    }
}
