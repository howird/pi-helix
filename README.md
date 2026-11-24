# pi-helix

Helix (or vi) modal editing for [pi](https://github.com/earendil-works/pi)'s input box.

The editing itself is [reedline](https://github.com/nushell/reedline)'s helix mode, run headless
through a small N-API addon. This project only translates keys, paints, and connects pi's
features (submit, history, autocomplete, app keybindings). See [DESIGN.md](./DESIGN.md).

## What you get

- Helix normal / insert / select modes, with a `NOR` / `INS` / `SEL` badge in the bottom border.
  Unfinished key sequences appear at the right of the border. Block cursor in normal, bar in insert.
- Enter submits from any mode. Shift+Enter (or Alt+Enter) inserts a newline in insert mode.
- Esc cancels a pending command or selection first; otherwise, Esc in normal mode interrupts the agent.
- `:` in normal mode replaces the badge with a command line: `:tree` runs Pi's `/tree`.
  Enter runs the highlighted suggestion (an exact command or the first match by default),
  or submits what you typed if no current suggestions are available. `:q` is an alias for
  `/quit`. Tab fills the suggestion without running it.
  If a command clears the prompt, press Up to recall your unsent draft in the same editor.
- pi's `/command` and `@file` completion, Tab to force it.
- Selection yanks go to the system clipboard. Vi normal-mode yanks stay in the internal register.
- Up on the first line / Down on the last line browse prompt history. `j` and `k` only move.

## Install

With Nix, `packages.default` is a pi package directory; add its path to pi's `packages`
setting. To try it without installing:

```sh
nix run            # pi with the extension loaded
```

Without Nix (needs Git, Cargo, Node and Bun):

```sh
bun run build:native
pi -e .
```

## Configuration

| Variable | Values | Default |
|---|---|---|
| `PI_HELIX_MODE` | `helix`, `vi` | `helix` |
| `PI_HELIX_CURSOR_BLINK` | `0` / `false` / `no` / `off` for a steady cursor | blinking |
| `PI_HELIX_NATIVE` | path to `pi_reedline.node` (relative to the launch directory or absolute) | next to `package.json` |

An explicit `PI_HELIX_NATIVE` that cannot be loaded is an error; it never falls back to the bundled addon.

## Differences from helix

This is reedline's helix mode, not helix:

- One selection only: no multi-cursor, no `s` / `C`.
- No registers. `p` pastes the last yank or delete from an internal buffer, not the system
  clipboard; use your terminal's paste for that.
- `:` runs pi slash commands, not helix commands.
- Large pastes are inserted in full, not collapsed to a marker.

## Development

```sh
nix develop             # optional: enter the development shell
bun run prepare:reedline
cargo t                 # engine tests
bun run build:native    # prepares Reedline automatically and builds the addon
bun test
bun run check
```

`patches/reedline/revision` pins the upstream source. Local and Nix builds apply the same two
patches; no Reedline source tree or fork is maintained here. After updating the pin or a patch,
rerun `bun run prepare:reedline` before running Cargo directly.
