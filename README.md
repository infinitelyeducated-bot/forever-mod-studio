# Forever Mod Studio

A standalone desktop app that opens any addon from the WoW: Forever AddOns folder and runs it in a
**simulated** game UI, so it can be looked at and adjusted with the mouse as if it were in the game.
It is a fork of the Forever HUD test space (`Z:\ai\forever-hud-preview`, left untouched).

The game is never written to. The AddOns and WTF folders are only read; everything the studio saves
goes into this folder (`state\`, `exports\`, `config.json`).

## Start it

Double-click **`Z:\ai\forever-mod-studio\Forever Mod Studio.cmd`**.

That starts the Electron app: `main.cjs` runs the file server inside the app on a free port of
`127.0.0.1` (never any other address) and opens one window on it.

Other ways:

| What | Command (in this folder) |
|---|---|
| The app | `npm start` |
| Browser instead of the app | `node server.cjs` then open `http://127.0.0.1:8811/` |
| Headless check of all HUDs | `node smoke.cjs` (`node smoke.cjs Warrior` for one, `--all` to also try every other addon) |
| Headless mouse-editing check | `node interact.cjs` |

If `node_modules\electron` is missing, the `.cmd` falls back to `node server.cjs 8811` plus an Edge
app window (`msedge --app=http://127.0.0.1:8811/`). `npm install` puts Electron back.

## Using it

- **Addon button (top left)** opens the picker: every folder in the AddOns directory that has a
  `.toc`. Type to search by name, title or notes; Enter or a click opens it.
  - *Also load*: addons the game would have loaded anyway because they are enabled, although the
    `.toc` does not name them. For the `Forever<Class>HUD` addons this is pre-filled with
    `ForeverArt, ForeverFonts` (menu artwork and the font pack).
  - *Game folder...* chooses the game folder (the one containing `Interface` and `WTF`). It is
    remembered in `config.json`. Default: `X:\WorldofWarcraft\World of Warcraft\_forever_`.
- **Start from**: the studio's last state, the game's saved settings (a read-only import from
  `WTF\Account\*\SavedVariables\<Addon>.lua`), a fresh install, or "everything switched on" (HUDs).
  The default uses the studio's state when there is one, else the game's.
- **Class**: the class of the simulated character (taken from the name for the HUDs).
- **Open options** runs the addon's first slash command. The slash box takes any slash command;
  `/run <lua>` and `/reload` work as in the game.
- **Save** writes every loaded addon's SavedVariables to `state\<Addon>.lua`. The same happens when
  you switch addon, reload, or close the window.
- **Export...** writes `exports\<Addon>.lua` with a note at the top saying where the file would go
  in the game. It is **not** copied there; do that yourself, with the game closed.
- **Target / In combat / Activity / Zoom / Background** are the test space's simulation controls.
- **Log** (bottom): what was loaded, what was skipped, addon chat output and every Lua error with
  file and line. It opens by itself when an error happens.

### Editing the HUDs with the mouse

With the HUD's options window open (and Lock off), exactly as in the game:

| Action | Effect |
|---|---|
| CTRL + hold left button | move the item |
| CTRL + mouse wheel | bigger / smaller |
| CTRL + hold right button and drag | turn it (icons freely, bars in quarter turns) |
| Right double-click | back to its original orientation |
| Click a colour chip on the Skins tab | colour wheel: click or drag on the wheel and on the brightness bar |

## What it simulates

- **Loading**: the `.toc` is parsed (`Title`, `SavedVariables`, `SavedVariablesPerCharacter`,
  `Dependencies` / `RequiredDeps` / `OptionalDeps`, file list). Dependencies that are in the folder
  load first, then the "also load" addons, then the addon: each `.lua` in `.toc` order, called as
  `chunk(addonName, sharedTable)` with one shared table per addon. `ADDON_LOADED` per addon, then
  `VARIABLES_LOADED`, `PLAYER_LOGIN`, `PLAYER_ENTERING_WORLD`. `C_AddOns.IsAddOnLoaded(name)` is true
  for exactly what was loaded.
- **Frames**: `CreateFrame`, anchors, sizes, scale, alpha, strata and levels, draw layers, backdrops,
  textures, font strings, buttons, check buttons, sliders, status bars (orientation, reverse fill),
  scroll frames, edit boxes (typing, Backspace, Delete, Enter, Escape, paste), cooldown sweeps,
  tooltips, a `ColorSelect` colour wheel, a handful of Blizzard templates.
- **Input**: `OnMouseDown` / `OnMouseUp` with the real button name, `OnClick` (honouring
  `RegisterForClicks`), `OnMouseWheel`, `OnEnter` / `OnLeave`, drag, `StartMoving` / `StartSizing`,
  `IsControlKeyDown`, `IsShiftKeyDown`, `IsAltKeyDown`, `GetCursorPosition`, `IsMouseButtonDown`,
  `GetTime`, per-frame `OnUpdate`, timers.
- **Pictures**: `.tga` (24 / 32 bit, uncompressed or RLE), `.png` and `.jpg` files referenced as
  `Interface\AddOns\<Addon>\...` are loaded when first drawn, cropped by `SetTexCoord`, tinted by
  `SetVertexColor`, greyed by `SetDesaturated` and turned by `SetRotation`. Fonts in addon folders
  are loaded the same way.
- **A character and a fight**: player, target, target-of-target, health, power, combo points,
  auras, casts, swing timer, spell cooldowns, driven by a small simulation.
- **Lua errors**: every call into addon code is guarded. An error is shown once in the log with its
  file and line (repeats are counted, not repeated) and the app carries on.

## What it cannot do

- **XML-defined addons.** `.xml` files are not run. Only their `<Script file>` and `<Include file>`
  lines are followed (enough for library "embeds" files); frames, templates and scripts written in
  XML are not built. The log lists each XML file and how many widgets it would have made. An addon
  whose window lives in XML (Pawn, Auctionator, ...) loads its Lua, usually with errors, and shows
  little or nothing.
- **Secure / protected behaviour.** No secret values, no taint, no combat lockdown, no secure
  templates, no action buttons that cast. `InCombatLockdown()` is always false.
- **Real spell, item and unit data.** There is no game database. Spells are known only by the ID an
  addon passes in; a spell asked for by name is "unknown"; icons are coloured placeholders with the
  first letters of the ability; unit names, levels and auras are invented.
- **Exact client fonts and art.** Friz Quadrata and the other client fonts are replaced by whatever
  similar font Windows has, so text widths differ a little. Blizzard's own textures (`Interface\...`
  outside `AddOns`), atlases and `.blp` files are not available and are drawn as flat stand-ins.
  Nothing from the game's data files is used or downloaded.
- **Much of the wider API.** Outside what the HUDs use, only a small set of common functions exists
  (strings, tables, colours, a few unit / group / chat stubs). Anything else raises a Lua error in
  the log naming the missing function; that list is the to-do list for supporting an addon.
- **Also not modelled**: key bindings and `OnKeyDown` on frames, animation groups (calls are
  accepted, nothing animates), masks, tiling, lines, models (a portrait placeholder), the world
  map, sound, addon messages and chat (logged, not sent), load-on-demand addons.

## Files

| File | What it is |
|---|---|
| `Forever Mod Studio.cmd` | double-click launcher |
| `main.cjs` | Electron shell: starts the server in-process, opens the window, folder dialog |
| `server.cjs` | loopback-only file server (also runs alone: `node server.cjs [port]`) |
| `lib\addons.cjs` | `.toc` parsing, load plan, SavedVariables lookup, config, state / export writing |
| `lib\headless.cjs` | the engine without a window, for the checks |
| `client.lua` | the stand-in WoW UI engine and the combat simulation (runs under fengari) |
| `studio.js`, `index.html` | the page: loads the addon, drives the engine, paints the draw list |
| `smoke.cjs`, `interact.cjs` | headless checks |
| `verify_new.cjs` | checks the Slice and Dice tracker (buff sweep, cleared without it) and the Scale sliders |
| `stress.cjs` | seeded random stress runner: 20 simulations per batch, each a long random sequence of clicks, drags, wheel turns, slash commands, flags and combat changes; a failing run prints its seed so it can be replayed with `--addon <name> --seed <n>` |
| `state\`, `exports\`, `config.json` | what the studio writes |
| `NOTES.md` | what changed relative to the test space, known gaps, where to pick up |

## Checks

```
node smoke.cjs            every HUD loads and opens its options with 0 Lua errors
node interact.cjs         mouse, wheel, colour wheel, typing, saved-variable round trip
node verify_new.cjs       Slice and Dice tracker and menu Scale sliders
node stress.cjs --batch 20 --seed 1000 --steps 60
```

Esc closes the options window whether the canvas or a toolbar button has focus (the key is forwarded to the addon from the window).
