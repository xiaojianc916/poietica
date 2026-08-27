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
        self.arm(false);
    }

    fn arm(&self, armed: bool) {
        self.armed
            .store(armed, std::sync::atomic::Ordering::Release);
    }

    fn armed(&self) -> bool {
        self.armed.load(std::sync::atomic::Ordering::Acquire)
    }

    fn take(&self) -> Option<BrowserPopupRequest> {
        self.arm(false);
        self.lock().take()
    }
}

#[derive(Clone, Copy, Debug)]
struct PopupGeometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// 只守原生边界：窗口 API 收得下的几何。请求正文归渲染层，这一层不解释它。
fn validate(geometry: PopupGeometry) -> Result<()> {
    let values = [geometry.x, geometry.y, geometry.width, geometry.height];

    if values.into_iter().all(f64::is_finite)
        && (1.0..=MAX_POPUP_SIZE).contains(&geometry.width)
        && (1.0..=MAX_POPUP_SIZE).contains(&geometry.height)
    {
        return Ok(());
    }

    Err(Error::Validation(
        "invalid browser popup geometry".to_owned(),
    ))
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
    validate(geometry)?;
    dismiss(&app)?;

    let main = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| Error::NotFound("main window".to_owned()))?;
    let origin = main
        .inner_position()
        .map_err(Error::from)?
        .to_logical::<f64>(main.scale_factor().map_err(Error::from)?);

    let builder =
        WebviewWindowBuilder::new(&app, POPUP_WINDOW, WebviewUrl::App(POPUP_DOCUMENT.into()))
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
    if let Err(error) = action.emit(&app) {
        log::warn!("browser popup action could not be delivered: {error}");
        return Err(
            Error::Internal("browser popup action could not be delivered".to_owned()).into(),
        );
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
    use super::{MAX_POPUP_SIZE, PopupGeometry, validate};

    fn geometry(width: f64, height: f64) -> PopupGeometry {
        PopupGeometry {
            x: 10.0,
            y: 20.0,
            width,
            height,
        }
    }

    #[test]
    fn geometry_the_window_api_accepts_is_allowed() {
        assert!(validate(geometry(352.0, 300.0)).is_ok());
    }

    #[test]
    fn non_finite_geometry_is_rejected() {
        assert!(
            validate(PopupGeometry {
                x: f64::NAN,
                ..geometry(352.0, 300.0)
            })
            .is_err()
        );
    }

    #[test]
    fn oversized_geometry_is_rejected() {
        assert!(validate(geometry(MAX_POPUP_SIZE + 1.0, 300.0)).is_err());
    }
}
