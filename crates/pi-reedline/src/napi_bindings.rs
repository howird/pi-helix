//! JS bindings. Offsets cross the boundary as UTF-16 code-unit indices.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::engine::Engine;
use crate::key::Key;

#[napi(object)]
pub struct State {
    pub buffer: String,
    /// UTF-16 index of the insertion point.
    pub cursor: u32,
    /// UTF-16 `[start, end)` of the selection.
    pub selection: Option<Vec<u32>>,
    /// `normal` | `insert` | `select`.
    pub mode: String,
    /// `none` | `unhandled` | `submit` | `abort`.
    pub action: String,
    /// Text yanked by this key, for the system clipboard.
    pub yanked: Option<String>,
    /// Whether the modal parser is waiting for more input.
    pub pending: bool,
    /// Original key events in the unfinished sequence, in input order.
    pub pending_keys: Vec<Key>,
}

fn utf16(s: &str, byte: usize) -> u32 {
    s[..byte.min(s.len())].encode_utf16().count() as u32
}

fn byte(s: &str, utf16_index: u32) -> usize {
    let mut units = 0u32;
    for (i, c) in s.char_indices() {
        if units >= utf16_index {
            return i;
        }
        units += c.len_utf16() as u32;
    }
    s.len()
}

fn state(engine: &Engine, action: &str, yanked: Option<String>) -> State {
    let snap = engine.snapshot();
    State {
        pending: engine.pending(),
        pending_keys: engine.pending_keys(),
        cursor: utf16(&snap.buffer, snap.cursor),
        selection: snap
            .selection
            .map(|(a, b)| vec![utf16(&snap.buffer, a), utf16(&snap.buffer, b)]),
        mode: snap.mode.to_string(),
        action: action.to_string(),
        yanked,
        buffer: snap.buffer,
    }
}

#[napi(js_name = "Engine")]
pub struct JsEngine(Engine);

#[napi]
impl JsEngine {
    /// `mode`: `helix` | `vi`.
    #[napi(constructor)]
    pub fn new(mode: String) -> Result<Self> {
        Engine::new(&mode).map(Self).map_err(Error::from_reason)
    }

    #[napi]
    pub fn feed(&mut self, key: Key) -> State {
        let out = self.0.feed(&key);
        state(&self.0, out.action.as_str(), out.yanked)
    }

    #[napi]
    pub fn state(&self) -> State {
        state(&self.0, "none", None)
    }

    /// Empty buffer and undo history, with a fresh modal parser.
    #[napi]
    pub fn reset(&mut self) -> State {
        self.0.reset();
        self.state()
    }

    /// Clear undo and redo history without changing the current edit state.
    #[napi]
    pub fn clear_undo(&mut self) -> State {
        self.0.clear_undo();
        self.state()
    }

    #[napi]
    pub fn set_text(&mut self, text: String) -> State {
        self.0.set_text(&text);
        self.state()
    }

    #[napi]
    pub fn insert_string(&mut self, text: String) -> State {
        self.0.insert_string(&text);
        self.state()
    }

    /// Move the cursor to a UTF-16 index, collapsing any selection.
    #[napi]
    pub fn move_to(&mut self, index: u32) -> State {
        let b = byte(&self.0.snapshot().buffer, index);
        self.0.move_to(b);
        self.state()
    }
}
