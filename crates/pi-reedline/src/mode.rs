//! An `EditMode` handle shared between our parser and the `Reedline` engine.
//!
//! `Reedline::run_edit_commands` reads the engine's own edit mode to pick the
//! rest policy (block vs bar caret, selection extent). The engine must therefore
//! hold the same mode instance we parse keys with.

use std::sync::{Arc, Mutex};

use crossterm::event::KeyEvent;
use reedline::{
    EditMode, EventStatus, Helix, PromptEditMode, PromptHelixMode, PromptViMode,
    ReedlineEvent, ReedlineRawEvent, Vi,
};

#[derive(Clone)]
pub struct SharedEditMode(Arc<Mutex<Box<dyn EditMode>>>);

impl SharedEditMode {
    pub fn new(mode: Box<dyn EditMode>) -> Self {
        Self(Arc::new(Mutex::new(mode)))
    }

    pub fn from_name(name: &str) -> Result<Self, String> {
        Ok(Self::new(build(name)?))
    }

    /// Replace the mode with a fresh one, in place, so every holder sees it.
    pub fn reset(&self, name: &str) -> Result<(), String> {
        *self.lock() = build(name)?;
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Box<dyn EditMode>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn build(name: &str) -> Result<Box<dyn EditMode>, String> {
    Ok(match name {
        "helix" => Box::<Helix>::default(),
        "vi" => Box::<Vi>::default(),
        other => return Err(format!("unknown edit mode {other:?}")),
    })
}

impl EditMode for SharedEditMode {
    fn parse_event(&mut self, event: ReedlineRawEvent) -> ReedlineEvent {
        self.lock().parse_event(event)
    }

    fn edit_mode(&self) -> PromptEditMode {
        self.lock().edit_mode()
    }

    fn has_pending_sequence(&self) -> bool {
        self.lock().has_pending_sequence()
    }

    fn pending_keys(&self) -> Vec<KeyEvent> {
        self.lock().pending_keys()
    }

    fn handle_mode_specific_event(&mut self, event: ReedlineEvent) -> EventStatus {
        self.lock().handle_mode_specific_event(event)
    }
}

/// Collapse reedline's prompt mode to the three states the UI shows.
pub fn mode_name(mode: &PromptEditMode) -> &'static str {
    match mode {
        PromptEditMode::Helix(PromptHelixMode::Normal) | PromptEditMode::Vi(PromptViMode::Normal) => {
            "normal"
        }
        PromptEditMode::Helix(PromptHelixMode::Select) | PromptEditMode::Vi(PromptViMode::Visual) => {
            "select"
        }
        _ => "insert",
    }
}
