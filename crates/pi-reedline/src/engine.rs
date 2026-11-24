//! Headless reedline: its edit model without its terminal I/O.
//!
//! We never call `read_line`, so reedline never touches the terminal. The one
//! hazard is `Drop for Reedline`, which disables raw mode and shows the cursor;
//! the engine is held in `ManuallyDrop` so that never runs.

use std::mem::ManuallyDrop;

use reedline::{EditCommand, EditMode, Reedline, ReedlineEvent};

use crate::key::Key;
use crate::mode::{mode_name, SharedEditMode};

/// What the host should do after a key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// Nothing beyond repainting.
    None,
    /// The key was not consumed; the host may handle it (app keybindings).
    Unhandled,
    /// Submit the buffer.
    Submit,
    /// Esc that changed nothing (no mode switch, no selection dropped, no
    /// pending sequence): the host may abort.
    Abort,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::None => "none",
            Action::Unhandled => "unhandled",
            Action::Submit => "submit",
            Action::Abort => "abort",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub buffer: String,
    /// Byte offset of the insertion point.
    pub cursor: usize,
    /// Byte range of the selection, if any.
    pub selection: Option<(usize, usize)>,
    pub mode: &'static str,
}

pub struct Outcome {
    pub action: Action,
    /// Text placed in reedline's cut buffer by a yank.
    pub yanked: Option<String>,
}

#[derive(PartialEq, Eq)]
enum Status {
    Handled,
    Inapplicable,
    Submit,
}

pub struct Engine {
    reedline: ManuallyDrop<Reedline>,
    mode: SharedEditMode,
    /// Edit mode name (`helix`, `vi`), to rebuild it on `reset`.
    kind: String,
    /// Mode name at the last `settle`, to detect a mode switch.
    settled_mode: &'static str,
    yanked: Option<String>,
}

impl Engine {
    pub fn new(mode: &str) -> Result<Self, String> {
        let kind = mode.to_string();
        let mode = SharedEditMode::from_name(mode)?;
        let reedline = Reedline::create().with_edit_mode(Box::new(mode.clone()));
        let mut engine = Self {
            reedline: ManuallyDrop::new(reedline),
            mode,
            kind,
            settled_mode: "",
            yanked: None,
        };
        engine.settle();
        Ok(engine)
    }

    /// Empty the buffer and undo history, with a fresh modal parser.
    /// A `Reedline` cannot be dropped (see the module docs), so hosts reuse one
    /// engine instead of leaking one per editor.
    pub fn reset(&mut self) {
        // `kind` was accepted by `new`, so this cannot fail.
        let _ = self.mode.reset(&self.kind);
        self.yanked = None;
        self.set_text("");
        self.clear_undo();
    }

    /// Clear undo and redo history without changing the current edit state.
    pub fn clear_undo(&mut self) {
        self.reedline.clear_undo();
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            buffer: self.reedline.current_buffer_contents().to_string(),
            cursor: self.reedline.current_insertion_point(),
            selection: self.reedline.current_selection(),
            mode: mode_name(&self.mode.edit_mode()),
        }
    }

    /// Whether reedline is waiting for the rest of a modal key sequence.
    pub fn pending(&self) -> bool {
        self.mode.has_pending_sequence()
    }

    /// Original key events retained by the parser, in input order.
    pub fn pending_keys(&self) -> Vec<Key> {
        self.mode.pending_keys().into_iter().filter_map(Key::from_event).collect()
    }

    fn cancel_pending(&mut self) {
        if self.pending() {
            // Re-entering the current mode abandons the partial sequence but
            // keeps the parser instance (and Vi's repeat/search state).
            let mode = self.mode.edit_mode();
            self.mode.handle_mode_specific_event(ReedlineEvent::SwitchMode(mode));
        }
    }

    pub fn feed(&mut self, key: &Key) -> Outcome {
        self.yanked = None;
        let Some(raw) = key.to_raw() else {
            return Outcome { action: Action::Unhandled, yanked: None };
        };
        let before = self.snapshot();
        let before_mode = self.mode.edit_mode();
        let had_pending = self.pending();
        let event = self.mode.parse_event(raw);
        let status = self.handle(event);
        if status == Status::Submit && (self.mode.edit_mode() != before_mode || self.pending()) {
            // Reedline enters insert on modal Enter for its own input loop.
            // pi submits in the current mode, without rebuilding the parser.
            self.mode.handle_mode_specific_event(ReedlineEvent::SwitchMode(before_mode));
        }
        self.settle();
        let after = self.snapshot();

        let typed = key.code == "char" && !key.ctrl.unwrap_or(false) && !key.alt.unwrap_or(false);
        let action = match status {
            Status::Submit => Action::Submit,
            _ if key.code == "esc" => {
                // Leaving insert or select mode, or dropping a selection,
                // changes the snapshot; only an Esc with nothing to do aborts.
                if before == after && !had_pending {
                    Action::Abort
                } else {
                    Action::None
                }
            }
            Status::Handled => Action::None,
            // Plain characters belong to the edit mode even when they only
            // advance a pending sequence (`m` of `mi(`) or change nothing.
            Status::Inapplicable if typed => Action::None,
            Status::Inapplicable if before != after => Action::None,
            Status::Inapplicable => Action::Unhandled,
        };
        Outcome { action, yanked: self.yanked.take() }
    }

    pub fn set_text(&mut self, text: &str) {
        self.cancel_pending();
        self.reedline.replace_buffer(text.to_string());
        self.settle();
    }

    /// Insert text from outside the edit mode (paste, host insertions).
    ///
    /// In insert mode this is reedline's `InsertString`, which replaces a
    /// selection. In normal and select mode the cursor always rests on a
    /// selection (at least the 1-cell block) that `InsertString` would delete,
    /// and reedline re-widens a collapsed cursor after every command, so the
    /// text is spliced in before the selection instead, as helix pastes.
    pub fn insert_string(&mut self, text: &str) {
        self.cancel_pending();
        let snapshot = self.snapshot();
        if snapshot.mode == "insert" {
            self.reedline.run_edit_commands(&[EditCommand::InsertString(text.to_string())]);
        } else {
            let at = snapshot.selection.map_or(snapshot.cursor, |(start, _)| start);
            let at = at.min(snapshot.buffer.len());
            let mut buffer = snapshot.buffer;
            buffer.insert_str(at, text);
            // One undoable edit; `Clear` + `InsertString` would leave an empty
            // buffer as an undo step.
            self.reedline.replace_buffer(buffer);
            self.reedline.run_edit_commands(&[EditCommand::MoveToPosition {
                position: at + text.len(),
                select: false,
            }]);
        }
        self.settle();
    }

    pub fn move_to(&mut self, offset: usize) {
        self.cancel_pending();
        let len = self.reedline.current_buffer_contents().len();
        self.reedline.run_edit_commands(&[EditCommand::MoveToPosition {
            position: offset.min(len),
            select: false,
        }]);
        self.settle();
    }

    /// Re-commit the cursor under the current mode's rest policy.
    ///
    /// Reedline does this in `read_line` before painting (`set_edit_mode`, which
    /// is private to us). A no-op edit command takes the same commit path:
    /// `MoveToPosition` onto the caret with `select` keeping any selection.
    fn settle(&mut self) {
        // A mode switch without commands (e.g. helix `i`) leaves the cursor
        // shaped for the old policy. Collapse a resting 1-cell block when
        // entering insert, and widen to a block when leaving it. A selection
        // made within insert mode (Shift+arrows) is the user's: keep it.
        let snapshot = self.snapshot();
        let select = snapshot.mode == "select";
        let switched = snapshot.mode != self.settled_mode;
        self.settled_mode = snapshot.mode;
        if snapshot.selection.is_some() && (snapshot.mode != "insert" || !switched) {
            return;
        }
        self.reedline.run_edit_commands(&[EditCommand::MoveToPosition {
            position: snapshot.cursor,
            select,
        }]);
    }

    fn handle(&mut self, event: ReedlineEvent) -> Status {
        match event {
            ReedlineEvent::Edit(commands) => {
                self.capture_yank(&commands);
                self.reedline.run_edit_commands(&commands);
                Status::Handled
            }
            ReedlineEvent::Multiple(events) => {
                let mut status = Status::Inapplicable;
                for event in events {
                    match self.handle(event) {
                        Status::Handled => status = Status::Handled,
                        Status::Inapplicable => {}
                        Status::Submit => return Status::Submit,
                    }
                }
                status
            }
            ReedlineEvent::UntilFound(events) => {
                for event in events {
                    match self.handle(event) {
                        Status::Inapplicable => {}
                        other => return other,
                    }
                }
                Status::Inapplicable
            }
            ReedlineEvent::SwitchMode(_) => {
                if self.mode.handle_mode_specific_event(event) == reedline::EventStatus::Handled {
                    Status::Handled
                } else {
                    Status::Inapplicable
                }
            }
            ReedlineEvent::Enter | ReedlineEvent::Submit | ReedlineEvent::SubmitOrNewline => {
                Status::Submit
            }
            ReedlineEvent::Esc => {
                // Engine semantics: drop a selection, else inapplicable.
                let snapshot = self.snapshot();
                if self.is_selection(&snapshot) {
                    self.reedline.run_edit_commands(&[EditCommand::MoveToPosition {
                        position: snapshot.cursor,
                        select: false,
                    }]);
                    Status::Handled
                } else {
                    Status::Inapplicable
                }
            }
            // History routing belongs to the host; here these are only line moves.
            ReedlineEvent::Up => self.edit(EditCommand::MoveLineUp { select: false }),
            ReedlineEvent::Down => self.edit(EditCommand::MoveLineDown { select: false }),
            ReedlineEvent::Left => self.edit(EditCommand::MoveLeft { select: false }),
            ReedlineEvent::Right => self.edit(EditCommand::MoveRight { select: false }),
            ReedlineEvent::ToStart => self.edit(EditCommand::MoveToStart { select: false }),
            ReedlineEvent::ToEnd => self.edit(EditCommand::MoveToEnd { select: false }),
            // Not a change in itself; the snapshot diff decides.
            ReedlineEvent::Repaint => Status::Inapplicable,
            // Menus, history hints, history search, ctrl-c/d/l, external editor,
            // mouse, resize: owned by pi.
            _ => Status::Inapplicable,
        }
    }

    fn edit(&mut self, command: EditCommand) -> Status {
        let before = self.snapshot();
        self.reedline.run_edit_commands(&[command]);
        if self.snapshot() == before {
            Status::Inapplicable
        } else {
            Status::Handled
        }
    }

    /// A selection the user made, as opposed to helix's resting 1-cell block.
    fn is_selection(&self, snapshot: &Snapshot) -> bool {
        if snapshot.mode == "select" {
            return true;
        }
        // Insert mode has no resting block: any selection is the user's.
        if snapshot.mode == "insert" {
            return snapshot.selection.is_some();
        }
        match snapshot.selection {
            Some((start, end)) => {
                let first = snapshot.buffer[start..]
                    .chars()
                    .next()
                    .map_or(0, char::len_utf8);
                end > start + first
            }
            None => false,
        }
    }

    fn capture_yank(&mut self, commands: &[EditCommand]) {
        if commands.iter().any(|c| matches!(c, EditCommand::CopySelection)) {
            if let Some((start, end)) = self.reedline.current_selection() {
                let text = self.reedline.current_buffer_contents()[start..end].to_string();
                if !text.is_empty() {
                    self.yanked = Some(text);
                }
            }
        }
    }
}
