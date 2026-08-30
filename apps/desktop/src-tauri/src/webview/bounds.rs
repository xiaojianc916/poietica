use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager};

use super::bridge::{BrowserHost, PanelBounds};
use super::lock;

/// 一个标签此刻该在哪：Some 是摆在这个矩形上并呈现，None 是隐藏。
pub(super) type Placement = Option<PanelBounds>;

/// 让「哪个 webview 可见」追上「哪个标签活动」。
///
/// 只有屏幕上那一页（活动且有地址）的 webview 呈现并占住面板视口；其余隐藏。
/// 面板收起时全部隐藏。
/// 这是唯一一处决定可见性的代码 —— 命令们只改状态，然后一律走这里。
pub(super) fn apply_layout(app: &AppHandle) {
    let host = app.state::<BrowserHost>();

    /* 一段：锁内算出计划并与上次下发对账，锁内一次都不碰内核。 */
    let plan: Vec<(tauri::Webview, u32, Placement)> = {
        let visible = *lock(&host.visible);
        let bounds = *lock(&host.bounds);
        let showing = lock(&host.tabs).showing();
        let webviews = lock(&host.webviews);
        let mut placed = lock(&host.placed);

        placed.retain(|id, _| webviews.contains_key(id));

        webviews
            .iter()
            .filter_map(|(id, webview)| {
                let wanted = (visible && Some(*id) == showing).then(|| PanelBounds {
                    width: bounds.width.max(1.0),
                    height: bounds.height.max(1.0),
                    ..bounds
                });

                (placed.insert(*id, wanted) != Some(wanted)).then(|| (webview.clone(), *id, wanted))
            })
            .collect()
    };

    /* 二段：锁外下发。内核调用在 Windows 上会泵消息，锁内下发会重入回这里。 */
    for (webview, id, wanted) in plan {
        let outcome = match wanted {
            Some(rect) => webview
                .set_position(LogicalPosition::new(rect.x, rect.y))
                .and_then(|()| webview.set_size(LogicalSize::new(rect.width, rect.height)))
                .and_then(|()| webview.show()),
            None => webview.hide(),
        };

        /* 下发失败就撤销记账，下一趟重试 —— 不留一个假的「已经摆好了」。 */
        if let Err(error) = outcome {
            log::warn!("browser tab {id} layout was not applied: {error}");
            lock(&host.placed).remove(&id);
        }
    }
}
