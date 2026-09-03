use std::sync::RwLock;

use tauri::{WebviewWindow, utils::config::Color};

const INITIAL_SURFACE: Color = Color(243, 243, 243, 255);

#[derive(Debug)]
pub struct WindowSurface {
    color: RwLock<Color>,
}

impl Default for WindowSurface {
    fn default() -> Self {
        Self {
            color: RwLock::new(INITIAL_SURFACE),
        }
    }
}

impl WindowSurface {
    pub fn set(&self, window: &WebviewWindow, color: Color) -> tauri::Result<()> {
        let mut current = self
            .color
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *current = color;

        window.set_background_color(Some(color))
    }

    pub fn reapply(&self, window: &WebviewWindow) -> tauri::Result<()> {
        let current = self
            .color
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        window.set_background_color(Some(*current))
    }
}
