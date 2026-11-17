# Forever Mod Studio: notes

Fork of `Z:\ai\forever-hud-preview` (the Forever HUD test space), made 2026-11-15. The preview
folder was not changed. Read `README.md` first for what the app is and how to start it.

## Current state (handoff)

- Works: the Electron app, the browser fallback, the addon picker, loading any `.toc` addon,
  mouse editing of the HUDs, the colour wheel, addon picture files, save / import / export.
- Checks on 2026-11-15: `node smoke.cjs` and `node interact.cjs` both pass (numbers at the end).
- Next step, if wanted: pick an XML-less addon the owner cares about, open it, and add the API
  functions its log lines name (see "Known gaps").
- Open questions for the owner: none blocking. Two choices were made without asking and are
  listed under "Decisions".

## What changed relative to the preview

### New files
- `main.cjs` Electron shell; `Forever Mod Studio.cmd` launcher.
- `lib\addons.cjs` `.toc` parser, load plan (dependencies, companions, XML `<Script>` / `<Include>`
  following), game SavedVariables lookup, config, state and export writers.
- `lib\headless.cjs` the engine without a window; `interact.cjs` the mouse-editing check.
- `studio.js` replaces `preview.js`; `index.html` rewritten around the picker and the log panel.

### `server.cjs`
- Exports `start(port, opts)` so Electron runs it in-process on a free port; still runs alone.
- Lists every folder with a `.toc` (was: only `Forever<Class>HUD2`), returns a load plan, serves
  `.xml .tga .png .jpg` as well as `.lua .toc` and fonts.
- New: `GET/POST /state/<Addon>.lua`, `POST /export/<Addon>.lua`, `GET/POST /api/config`,
  `POST /api/pick-folder`. Writes go only to this project folder.
- Still binds to `127.0.0.1` only. Added: the `Host` header must be the loopback address and a
  `POST` with a foreign `Origin` is refused, so another web page cannot make it write files. Only
  five named page files are served from the project folder.

### `client.lua` (engine). Every addition is marked `[studio]` in the source.
- **Loader**: `PV_begin`, `PV_meta`, `PV_saved`, `PV_file`, `PV_loaded`, `PV_start` load any
  number of addons file by file with one shared table per addon. `PV_boot` (the preview's
  single-file entry) is kept. `C_AddOns.IsAddOnLoaded` now reports what was really loaded (the
  preview hard-coded ForeverFonts). `GetAddOnMetadata` answers from the `.toc`.
- **Errors**: every call into addon code goes through `Safe` (xpcall + traceback). Messages carry
  file and line; when the error is raised inside the engine the calling addon line is appended.
  A repeated message is counted, not logged again.
- **Mouse**: each button tracked separately (`P.btn`, `P.downBy`); right and middle button
  down / up delivered with their names; `GetCursorPosition` (screen pixels, bottom-left origin),
  `IsMouseButtonDown`, `IsAltKeyDown`, `IsModifierKeyDown`, `GetMouseFocus`; `PV_mods` reports
  CTRL / SHIFT / ALT as the keys change; `PV_wheel` takes the modifiers and honours
  `EnableMouseWheel(false)`; `RegisterForClicks` is real (default: left button only, as in the
  client. The preview fired `OnClick` for any button).
- **Widgets**: `ColorSelect` (wheel, brightness bar, two thumbs, `SetColorRGB` / `GetColorRGB` /
  `SetColorHSV` / `GetColorHSV`, `OnColorSelect`, mouse picking and dragging);
  `Texture:SetRotation` / `GetRotation`; `SetTexCoord` with eight numbers; `GetTexCoord`;
  `IsDesaturated`; `GetFrameStrata` returns the real strata (was always "MEDIUM"); button
  normal / highlight textures become regions when they are addon files or icons; edit boxes got
  `OnChar`, Delete, Tab, paste (`PV_text`) and UTF-8-safe Backspace; about 60 further widget
  methods as simple answers or no-ops.
- **Drawing**: new draw-list lines `P` (picture file with texture coordinates, colour,
  desaturation, blend), `X ... x` (turn what is between about a point), `W` (colour wheel),
  `G` (brightness bar). `I` (placeholder icon) now carries the vertex colour, so an icon on
  cooldown is drawn dark, and its vertex alpha.
- **General API** (`P.StudioGlobals`): `strsplit` / `strjoin` / `strtrim`, `bit`, table helpers,
  `Mixin`, `CreateColor`, `GetLocale`, `GetBuildInfo`, `C_ChatInfo`, `Settings`, `CreateFont`,
  `C_Timer.NewTimer`, unit / group / zone stubs and the like.
- **SavedVariables**: `PV_serialize` writes the declared variables as Lua source in the client's
  layout; `PV_logout` fires `PLAYER_LOGOUT`.
- **Tools**: `PV_eval`, `PV_rect`, `PV_errors`; `/run`, `/script`, `/reload` in `PV_slash`.
- **One behaviour change in the simulation**: `C_Spell.GetSpellInfo("Name")` now returns nil
  ("not known") instead of an entry with spell ID 0. In the preview every HUD ability resolved to
  ID 0, so all icons shared one cooldown and one placeholder picture. Now each keeps its own
  rank-1 ID (the HUDs' designed fallback), cooldowns run per icon, and the showcase counts in
  `smoke.cjs` are higher than the preview's for that reason. No HUD raises an error either way.

### Page (`studio.js`)
- Addon picker with search; "also load"; game-folder setting; class selector.
- Start-from choice (studio state / game import / fresh / showcase); Save, Export, save on
  switch, reload and window close.
- Lazy picture cache with TGA decoder (bounded at 60 million pixels, least recently drawn out
  first); colour wheel bitmap; tinting on a scratch canvas.
- Right button and middle button delivered; context menu suppressed; CTRL + wheel never zooms
  the page; drags that leave the canvas keep following.
- "Fit height" zoom (new) and an automatic first choice of zoom; visible log panel with an error
  counter, Copy and Clear.
- `?addon=&start=&zoom=&run=` in the address and `window.studio` for automated looks.

## Decisions made without asking
1. **Companion addons.** The HUD `.toc` files do not name ForeverArt, yet the menus need it. The
   studio loads `ForeverArt` and `ForeverFonts` alongside any `Forever<Class>HUD[2]` (editable in
   the picker's "Also load" box; the rule is `companions` in `config.json` / `lib\addons.cjs`).
2. **Save on close.** Besides the Save button and switching addon, closing the window also saves
   to `state\`. `PLAYER_LOGOUT` is fired before every save so addons that write their settings at
   logout are captured; an addon whose logout handler is destructive would misbehave after a Save.

## Known gaps
- XML: frames, templates and scripts in `.xml` are not built (only `<Script>` / `<Include>`
  followed). This rules out most large third-party addons for now. Seen in this folder:
  Pawn loads 12 Lua files with 4 errors and shows nothing (276 XML widgets).
- `.blp` textures, Blizzard interface art and atlases: flat stand-ins.
- Picture tiling, masks, gradients, lines, animations, models: accepted, not drawn.
- Texture rotation turns the picture about its centre; the client's corner-clipping of rotated
  textures is not imitated.
- Vertex colour on placeholder icons uses a multiply over whatever is behind a translucent icon.
- Edit boxes: the caret is always at the end; no selection, no arrow keys.
- No `OnKeyDown` / `OnKeyUp` for frames, no key bindings.
- `SavedVariablesPerCharacter` are kept in the same `state\<Addon>.lua` as account variables; the
  game import reads the account file plus the first character file it finds.
- Load-on-demand addons and `LoadAddOn` are not supported (it returns false for anything not
  already loaded). `[AllowLoadGameType]` / locale conditions in a `.toc` are read for enUS / classic.
- Fonts are system look-alikes; text measures slightly differently from the game.
- Headless checks measure text with a fixed width per character, so their draw-list counts are
  not the page's.

## Not verified
- The folder dialog ("Game folder...") in Electron was not clicked through; the server side of it
  (`POST /api/config`) and the browser prompt path share the same code and were exercised only
  through `GET /api/config`.
- The `.cmd` was not double-clicked from Explorer; the same command it runs
  (`node_modules\electron\dist\electron.exe .`) was run from a shell several times. The Edge
  fallback branch was not run.
- Real hardware right-button / CTRL + wheel input in the Electron window was not exercised by
  hand. It was exercised with synthetic DOM events in a browser against the same page (move,
  scale, turn all changed the saved values; the context menu and CTRL + wheel defaults were
  prevented) and headless through the engine.
- Only the Warrior "2" HUD was looked at on screen. The other 17 HUDs were booted headless only.
- Paste into an edit box (Ctrl+V) and background-picture replacement were not tried in the fork.

## Check results (2026-11-15)
- `node smoke.cjs`: see the final line it prints. 19 addons, 18 HUDs with 0 Lua errors each,
  HelloForever 0, every options window opened by its slash command.
- `node interact.cjs`: 33 checks passed, 0 failed.
