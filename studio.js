/* Forever Mod Studio: runs real addon Lua (fengari) in the stand-in engine (client.lua)
   and paints its frames over a screenshot. Forked from the Forever HUD test space;
   blocks marked [studio] are what the fork added. */
(() => {
  'use strict';
  const { lua, lauxlib, lualib, to_luastring } = window.fengari;
  const $ = id => document.getElementById(id);
  const canvas = $('stage'), ctx = canvas.getContext('2d'), view = $('view');
  const UI_HEIGHT = 768;                       // the game's UI is 768 units tall at UI scale 1
  const store = {
    get(k, d) { try { const v = localStorage.getItem('fms.' + k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('fms.' + k, v); } catch (e) { /* private window */ } },
  };
  const query = new URLSearchParams(location.search);

  let L = null, ready = false, cssW = 0, cssH = 0, scaleK = 1, clientSrc = '';
  let bg = new Image(), bgOK = false;
  let addonList = [], current = null, plan = null, config = {}, luaErrors = 0, booting = false;
  const logLines = [];

  // ---------------------------------------------------------------- log / status
  // kind: 'e' Lua or studio error, 's' studio note, 'w' skipped / warning, '' addon chat
  function log(text, kind) {
    logLines.push(text);
    if (logLines.length > 1000) logLines.shift();
    const el = $('log');
    const d = document.createElement('div');
    d.textContent = text;
    if (kind) d.className = kind;
    el.appendChild(d);
    while (el.childNodes.length > 1000) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
    if (kind === 'e') {
      $('msg').textContent = text; $('msg').className = 'err';
      if (/Lua error/.test(text)) { luaErrors++; showErrors(); }
    }
  }
  function showErrors() {
    $('errs').textContent = luaErrors ? `${luaErrors} Lua error${luaErrors === 1 ? '' : 's'}` : 'no Lua errors';
    $('errs').className = luaErrors ? '' : 'none';
    $('logbtn').textContent = luaErrors ? `Log (${luaErrors})` : 'Log';
  }
  function status(text) { $('msg').textContent = text; $('msg').className = ''; }
  async function getJSON(url, opts) {
    const r = await fetch(url, opts);
    const j = await r.json().catch(() => ({ error: 'bad answer from the studio server' }));
    if (!r.ok && !j.error) j.error = 'request failed (' + r.status + ')';
    return j;
  }

  // ---------------------------------------------------------------- fonts
  const BUILTIN = {
    'fonts\\frizqt__.ttf': '"Friz Quadrata TT", "Friz Quadrata Std", "FrizQuadrata", Georgia, "Times New Roman", serif',
    'fonts\\arialn.ttf': '"Arial Narrow", "Roboto Condensed", Arial, sans-serif',
    'fonts\\morpheus.ttf': '"Morpheus", "Cinzel", Georgia, serif',
    'fonts\\skurri.ttf': '"Skurri", "Bangers", Impact, fantasy',
    'fonts\\nim_____.ttf': '"Nimrod MT", Georgia, serif',
    'fonts\\2002.ttf': 'Arial, sans-serif',
  };
  const families = new Map();
  let fontSeq = 0;
  function family(path) {
    const key = String(path || '').toLowerCase().replace(/\//g, '\\');
    let f = families.get(key);
    if (f) return f;
    f = BUILTIN[key];
    if (!f) {
      const m = /^interface\\addons\\(.+)$/.exec(key);
      if (m) {
        const name = 'fms' + (++fontSeq);
        const url = '/addons/' + String(path).slice(17).split(/[\\/]/).map(encodeURIComponent).join('/');
        f = `"${name}", ${BUILTIN['fonts\\frizqt__.ttf']}`;
        new FontFace(name, `url(${url})`).load().then(face => {
          document.fonts.add(face);
          if (ready) call('PV_cmd', 'fonts', '');
        }).catch(() => log('Font file did not load: ' + path, 'w'));
      } else {
        f = BUILTIN['fonts\\frizqt__.ttf'];
      }
    }
    families.set(key, f);
    return f;
  }
  const mctx = document.createElement('canvas').getContext('2d');
  function measure(text, path, size) {
    mctx.font = `${size}px ${family(path)}`;
    return mctx.measureText(text).width;
  }

  // ---------------------------------------------------------------- [studio] pictures from addon folders
  // "Interface\AddOns\<Addon>\...\file.tga" (also .png / .jpg) is fetched the first
  // time something draws it, decoded, and kept; nothing is read up front. The
  // cache is bounded by pixel count, least recently drawn out first.
  const textures = new Map();
  const TEX_BUDGET = 60e6;            // pixels kept decoded (about 240 MB of RGBA)
  let texPixels = 0, texClock = 0;

  // Uncompressed and RLE true-colour / grey TGA, 8 / 24 / 32 bit, either origin.
  function decodeTGA(buf) {
    const d = new Uint8Array(buf);
    if (d.length < 18) throw new Error('not a TGA file');
    const idLen = d[0], mapType = d[1], type = d[2], w = d[12] | (d[13] << 8), h = d[14] | (d[15] << 8), bpp = d[16], desc = d[17];
    const rle = type === 10 || type === 11, grey = type === 3 || type === 11;
    if (mapType !== 0 || !(type === 2 || type === 3 || rle)) throw new Error('TGA type ' + type + ' is not supported');
    if (!(bpp === 32 || bpp === 24 || (grey && bpp === 8))) throw new Error(bpp + '-bit TGA is not supported');
    if (!w || !h) throw new Error('empty TGA');
    const bytes = bpp >> 3, n = w * h;
    let src = 18 + idLen;
    let px = d;                                        // raw pixel bytes, in file order
    if (rle) {
      px = new Uint8Array(n * bytes);
      let o = 0;
      while (o < px.length && src < d.length) {
        const head = d[src++], count = (head & 127) + 1;
        if (head & 128) { for (let i = 0; i < count; i++) for (let b = 0; b < bytes; b++) px[o++] = d[src + b]; src += bytes; }
        else { const len = count * bytes; px.set(d.subarray(src, src + len), o); o += len; src += len; }
      }
      src = 0;
    } else if (d.length < src + n * bytes) throw new Error('TGA file is cut short');
    const img = new ImageData(w, h), out = img.data;
    const topDown = (desc & 0x20) !== 0, rightLeft = (desc & 0x10) !== 0;
    let anyAlpha = false;
    for (let y = 0; y < h; y++) {
      const row = topDown ? y : h - 1 - y;
      let o = row * w * 4, step = 4;
      if (rightLeft) { o += (w - 1) * 4; step = -4; }
      for (let x = 0; x < w; x++, o += step, src += bytes) {
        if (grey) { out[o] = out[o + 1] = out[o + 2] = px[src]; out[o + 3] = 255; }
        else {
          out[o] = px[src + 2]; out[o + 1] = px[src + 1]; out[o + 2] = px[src];
          if (bytes === 4) { const a = px[src + 3]; out[o + 3] = a; if (a) anyAlpha = true; } else out[o + 3] = 255;
        }
      }
    }
    // a 32-bit file whose alpha channel is entirely zero was saved without one: show it opaque
    if (bytes === 4 && !anyAlpha) for (let i = 3; i < out.length; i += 4) out[i] = 255;
    return img;
  }

  function texUrl(rel) { return '/addons/' + rel.split(/[\\/]+/).map(encodeURIComponent).join('/'); }
  async function loadTexture(path, t) {
    const rel = path.replace(/^interface[\\/]+addons[\\/]+/i, '');
    const ext = (/\.([a-z0-9]+)$/i.exec(rel) || [0, ''])[1].toLowerCase();
    if (ext === 'blp') throw new Error('BLP pictures cannot be decoded here');
    // the client lets an addon leave the extension off
    const tries = ext ? [rel] : [rel + '.tga', rel + '.png', rel + '.jpg'];
    for (const name of tries) {
      const r = await fetch(texUrl(name));
      if (!r.ok) continue;
      const cv = document.createElement('canvas');
      if (/\.tga$/i.test(name)) {
        const img = decodeTGA(await r.arrayBuffer());
        cv.width = img.width; cv.height = img.height;
        cv.getContext('2d').putImageData(img, 0, 0);
      } else {
        const bmp = await createImageBitmap(await r.blob());
        cv.width = bmp.width; cv.height = bmp.height;
        cv.getContext('2d').drawImage(bmp, 0, 0);
      }
      t.canvas = cv; t.w = cv.width; t.h = cv.height; t.state = 'ok';
      texPixels += t.w * t.h;
      // over budget: drop the pictures drawn longest ago
      if (texPixels > TEX_BUDGET) {
        const old = [...textures.entries()].filter(e => e[1].state === 'ok' && e[1] !== t).sort((a, b) => a[1].last - b[1].last);
        for (const [k, v] of old) { if (texPixels <= TEX_BUDGET) break; texPixels -= v.w * v.h; textures.delete(k); }
      }
      return;
    }
    throw new Error('file not found');
  }
  function texture(path) {
    const key = path.toLowerCase();
    let t = textures.get(key);
    if (!t) {
      t = { state: 'loading', last: 0 };
      textures.set(key, t);
      loadTexture(path, t).catch(e => { t.state = 'bad'; log(`Picture did not load: ${path} (${e.message})`, 'w'); });
    }
    t.last = ++texClock;
    return t;
  }

  // the hue / saturation wheel of a ColorSelect: hue 0 at the right, anticlockwise, full brightness
  let wheelCanvas = null;
  function colourWheel() {
    if (wheelCanvas) return wheelCanvas;
    const S = 256, R = S / 2, cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const c = cv.getContext('2d'), img = c.createImageData(S, S), o = img.data;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = x + 0.5 - R, dy = R - (y + 0.5), d = Math.hypot(dx, dy) / R, i = (y * S + x) * 4;
      if (d > 1.01) continue;
      let h = Math.atan2(dy, dx) / (2 * Math.PI); if (h < 0) h += 1;
      const s = Math.min(1, d), hh = h * 6, k = Math.floor(hh), f = hh - k, p = 1 - s, q = 1 - s * f, t = 1 - s * (1 - f);
      const rgb = [[1, t, p], [q, 1, p], [p, 1, t], [p, q, 1], [t, p, 1], [1, p, q]][k % 6];
      o[i] = rgb[0] * 255; o[i + 1] = rgb[1] * 255; o[i + 2] = rgb[2] * 255;
      o[i + 3] = d > 0.99 ? Math.max(0, (1.01 - d) / 0.02) * 255 : 255;
    }
    c.putImageData(img, 0, 0);
    return (wheelCanvas = cv);
  }
  const tintCanvas = document.createElement('canvas'), tctx = tintCanvas.getContext('2d');

  // ---------------------------------------------------------------- Lua state
  function push(a) {
    if (typeof a === 'number') lua.lua_pushnumber(L, a);
    else if (typeof a === 'boolean') lua.lua_pushboolean(L, a);
    else lua.lua_pushstring(L, to_luastring(String(a)));
  }
  function call(fn, ...args) {
    if (!L) return null;
    lua.lua_getglobal(L, to_luastring(fn));
    args.forEach(push);
    if (lua.lua_pcall(L, args.length, 1, 0) !== lua.LUA_OK) {
      const e = lua.lua_tojsstring(L, -1);
      lua.lua_pop(L, 1);
      log(`Lua error (engine, ${fn}): ${e}`, 'e');
      return null;
    }
    const t = lua.lua_type(L, -1);
    const r = t === lua.LUA_TSTRING ? lua.lua_tojsstring(L, -1) : lua.lua_toboolean(L, -1);
    lua.lua_pop(L, 1);
    return r;
  }
  function newState() {
    L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    const reg = (n, fn) => { lua.lua_pushcfunction(L, fn); lua.lua_setglobal(L, to_luastring(n)); };
    reg('HOST_measure', S => {
      lua.lua_pushnumber(S, measure(lua.lua_tojsstring(S, 1) || '', lua.lua_tojsstring(S, 2) || '', lua.lua_tonumber(S, 3)));
      return 1;
    });
    reg('HOST_log', S => { const t = lua.lua_tojsstring(S, 1) || ''; log(t, /Lua error/.test(t) ? 'e' : ''); return 0; });
    reg('HOST_confirm', S => { lua.lua_pushboolean(S, window.confirm(lua.lua_tojsstring(S, 1) || 'Continue?')); return 1; });
    reg('HOST_color', S => {
      const hex = [1, 2, 3].map(i => Math.round(Math.max(0, Math.min(1, lua.lua_tonumber(S, i))) * 255).toString(16).padStart(2, '0')).join('');
      const inp = $('colour');
      inp.value = '#' + hex;
      inp.click();
      return 0;
    });
    if (lauxlib.luaL_loadbuffer(L, to_luastring(clientSrc), null, to_luastring('@client.lua')) !== lua.LUA_OK
      || lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) {
      throw new Error(lua.lua_tojsstring(L, -1));
    }
  }

  // ---------------------------------------------------------------- [studio] open / save any addon
  const CLASSES = ['Rogue', 'Druid', 'Hunter', 'Mage', 'Paladin', 'Priest', 'Shaman', 'Warlock', 'Warrior'];
  const hudClass = n => { const m = /^Forever(\w+?)HUD2?$/.exec(n); return m && CLASSES.includes(m[1]) ? m[1] : null; };
  let slashCmd = '', slashFound = false;
  function findSlash(src) {
    const m = /SLASH_\w+1\s*=\s*["'](\/\w+)["']/.exec(src);
    if (m) { slashCmd = m[1]; slashFound = true; }
  }
  const alsoFor = name => {
    const mine = store.get('also.' + name, null);
    if (mine !== null) return mine;
    const a = addonList.find(x => x.name === name);
    return a && a.companions ? a.companions.join(', ') : '';
  };

  // Loads the addon the way the client does: dependencies and companions first,
  // each addon's SavedVariables before its files, files in .toc order, every file
  // called as chunk(addonName, sharedTable). XML is listed as skipped. An error in
  // one file goes to the log and the next file still runs.
  async function boot(name) {
    if (booting) return;
    booting = true; ready = false;
    name = name || current;
    const mode = $('startfrom').value;
    status(`Loading ${name}...`);
    try {
      const also = alsoFor(name);
      const p = await getJSON(`/api/plan?addon=${encodeURIComponent(name)}&also=${encodeURIComponent(also)}`);
      if (p.error) { log('Could not open ' + name + ': ' + p.error, 'e'); return; }
      $('log').textContent = ''; logLines.length = 0; luaErrors = 0; showErrors();
      newState();
      plan = p; current = p.target;
      store.set('addon', current);
      $('pick').textContent = current;
      document.title = current + ' - Forever Mod Studio';
      const pick = $('cls').value;
      const cls = (pick === 'auto' ? (hudClass(current) || 'Warrior') : pick).toUpperCase();
      call('PV_begin', cls, current);
      log(`Opening ${current} as a ${cls.toLowerCase()} from ${config.addonsFolder}`, 's');
      for (const m of p.missing || []) log(`Dependency not in the AddOns folder: ${m.name} (${m.why})`, 'w');
      let used = '';
      for (const a of p.order) {
        call('PV_meta', a.name, 'Title', a.title); call('PV_meta', a.name, 'Version', a.version || ''); call('PV_meta', a.name, 'Notes', a.notes || '');
        // settings: the studio's last state, the game's (read-only import), or none
        let saved = null, from = 'fresh defaults';
        const tryState = mode === 'state' || mode === 'auto', tryGame = mode === 'game' || mode === 'auto';
        if (tryState && a.hasState) {
          const r = await fetch(`/state/${encodeURIComponent(a.name)}.lua?t=${Date.now()}`);
          if (r.ok) { saved = await r.text(); from = "the studio's last state"; }
        }
        if (saved === null && tryGame && a.hasGameSaved) {
          const r = await fetch(`/saved/${encodeURIComponent(a.name)}.lua?t=${Date.now()}`);
          if (r.ok) { saved = await r.text(); from = "the game's saved settings (imported, read-only)"; }
        }
        if (saved) call('PV_saved', saved.replace(/^﻿/, ''), a.name + ' SavedVariables');
        const sv = [...a.saved, ...a.savedPerChar];
        if (a.name === current) used = from;
        log(`${a.name}${a.why === 'target' ? '' : ' (' + a.why + ')'}: ${a.files.filter(f => f.kind === 'lua').length} Lua file(s)` + (sv.length ? `, settings from ${from}` : ''), 's');
        for (const f of a.files) {
          if (f.kind === 'lua') {
            const r = await fetch(texUrl(a.name + '\\' + f.path) + '?t=' + Date.now());
            if (!r.ok) { log(`  missing: ${a.name}\\${f.path}`, 'w'); continue; }
            const src = (await r.text()).replace(/^﻿/, '');
            if (a.name === current && !slashFound) findSlash(src);
            call('PV_file', a.name, f.path, src);
          } else if (f.kind === 'xml') {
            log(`  skipped XML: ${a.name}\\${f.path} (${f.note || 'not run'})`, 'w');
          } else if (f.kind === 'missing') {
            log(`  listed but not in the folder: ${a.name}\\${f.path}`, 'w');
          } else {
            log(`  skipped: ${a.name}\\${f.path}`, 'w');
          }
        }
        call('PV_loaded', a.name, sv.join(','));
      }
      call('PV_start');
      if (mode === 'showcase') call('PV_cmd', 'showcase', '');
      call('PV_cmd', 'target', $('target').value);
      call('PV_cmd', 'auto', $('auto').checked ? '1' : '0');
      call('PV_cmd', 'combat', $('combat').checked ? '1' : '0');
      call('PV_mods', false, false, false);
      $('slash').placeholder = slashCmd ? `${slashCmd} text, /run lua` : 'slash command';
      $('options').disabled = !slashCmd;
      ready = true;
      status(`${current} running with ${used}` + (luaErrors ? `  -  ${luaErrors} Lua error(s), see the log` : ''));
      if (luaErrors) { $('logwrap').classList.add('open'); layout(); }
    } catch (e) {
      log('Could not start: ' + e.message, 'e');
    } finally {
      booting = false;
    }
  }

  // The SavedVariables tables of every loaded addon, written as Lua source to the
  // studio's own state\ folder. Never to the game folder.
  async function save(quiet) {
    if (!ready || !plan) return false;
    call('PV_logout');                      // addons that copy their settings back at logout do it now
    let n = 0;
    for (const a of plan.order) {
      const text = call('PV_serialize', a.name);
      if (typeof text !== 'string' || !text.trim()) continue;
      const r = await getJSON(`/state/${encodeURIComponent(a.name)}.lua`, { method: 'POST', body: text });
      if (r.error) { log(`Could not save ${a.name}: ${r.error}`, 'e'); return false; }
      a.hasState = true; n++;
      if (!quiet) log(`Saved ${a.name} settings to ${r.file}`, 's');
    }
    if (!quiet) status(n ? `Saved ${n} settings file${n === 1 ? '' : 's'} to ${config.stateFolder}` : `${current} declares no SavedVariables: nothing to save`);
    return true;
  }
  async function exportOut() {
    if (!ready || !plan) return;
    call('PV_logout');
    const text = call('PV_serialize', current);
    if (typeof text !== 'string' || !text.trim()) { status(`${current} declares no SavedVariables: nothing to export`); return; }
    const r = await getJSON(`/export/${encodeURIComponent(current)}.lua`, { method: 'POST', body: text });
    if (r.error) { log('Export failed: ' + r.error, 'e'); return; }
    log(`Exported to ${r.file}`, 's');
    log(`  In the game this file would go to ${r.dest} (close the game first; the studio did not copy it).`, 's');
    status(`Exported to ${r.file}  -  not copied into the game`);
    $('logwrap').classList.add('open'); layout();
  }
  async function switchTo(name) {
    if (ready) await save(true);            // adjustments are kept when leaving an addon
    slashCmd = ''; slashFound = false;
    await boot(name);
  }

  // ---------------------------------------------------------------- [studio] addon picker
  async function loadList() {
    config = await getJSON('/api/config');
    $('folderline').textContent = (config.found ? 'Game folder: ' : 'Game folder NOT FOUND: ') + config.gameFolder;
    const r = await getJSON('/api/addons');
    addonList = r.addons || [];
    if (r.error) log(r.error, 'e');
  }
  let pickSel = 0, pickShown = [];
  function renderList() {
    const words = $('search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    pickShown = addonList.filter(a => {
      const hay = (a.name + ' ' + a.title + ' ' + a.notes).toLowerCase();
      return words.every(w => hay.includes(w));
    });
    if (pickSel >= pickShown.length) pickSel = Math.max(0, pickShown.length - 1);
    const el = $('list');
    el.textContent = '';
    if (!pickShown.length) {
      const d = document.createElement('div'); d.id = 'empty';
      d.textContent = addonList.length ? 'No addon matches.' : 'No addons found. Use "Game folder..." to point the studio at the game.';
      el.appendChild(d);
      return;
    }
    pickShown.forEach((a, i) => {
      const row = document.createElement('div');
      row.className = 'item' + (i === pickSel ? ' sel' : '');
      const add = (cls, text, title) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; if (title) s.title = title; row.appendChild(s); };
      add('t', a.title || a.name);
      if (a.title && a.title !== a.name) add('f', a.name);
      add('n', a.notes || '');
      if (a.xml) add('tag x', `${a.xml} XML`, 'XML files are not run; <Script> and <Include> lines in them are followed');
      if (a.deps.length) add('tag', `needs ${a.deps.join(', ')}`);
      if (a.hasState) add('tag s', 'studio state', 'The studio has saved settings for this addon');
      else if (a.hasGameSaved) add('tag', 'game settings', 'The game has saved settings for this addon');
      row.addEventListener('click', () => choose(a.name));
      el.appendChild(row);
    });
    const sel = el.querySelector('.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
    const top = pickShown[pickSel];
    $('also').value = top ? alsoFor(top.name) : '';
  }
  function openPicker() {
    $('picker').classList.add('open');
    $('search').value = '';
    pickSel = Math.max(0, addonList.findIndex(a => a.name === current));
    renderList();
    $('search').focus();
    loadList().then(renderList);            // pick up state files written since the list was read
  }
  function closePicker() { $('picker').classList.remove('open'); canvas.focus(); }
  function choose(name) {
    const top = pickShown[pickSel];
    if (top && top.name === name) store.set('also.' + name, $('also').value.trim());
    closePicker();
    switchTo(name);
  }
  $('pick').addEventListener('click', openPicker);
  $('picker').addEventListener('mousedown', e => { if (e.target === $('picker')) closePicker(); });
  $('search').addEventListener('input', () => { pickSel = 0; renderList(); });
  $('search').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { pickSel = Math.min(pickShown.length - 1, pickSel + 1); renderList(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { pickSel = Math.max(0, pickSel - 1); renderList(); e.preventDefault(); }
    else if (e.key === 'Enter' && pickShown[pickSel]) choose(pickShown[pickSel].name);
    else if (e.key === 'Escape') closePicker();
  });
  $('also').addEventListener('keydown', e => {
    if (e.key === 'Enter' && pickShown[pickSel]) choose(pickShown[pickSel].name);
    else if (e.key === 'Escape') closePicker();
  });
  $('folder').addEventListener('click', async () => {
    let folder = null;
    const r = await getJSON('/api/pick-folder', { method: 'POST' });
    if (r.available) folder = r.folder;
    else folder = window.prompt('Game folder (the one that contains Interface and WTF):', config.gameFolder);
    if (!folder) return;
    const set = await getJSON('/api/config', { method: 'POST', body: JSON.stringify({ gameFolder: folder }) });
    if (set.error) { window.alert(set.error); return; }
    textures.clear(); texPixels = 0;
    await loadList();
    renderList();
    log('Game folder set to ' + set.gameFolder, 's');
  });

  // ---------------------------------------------------------------- layout
  function layout() {
    const aspect = bgOK ? bg.naturalWidth / bg.naturalHeight : 2000 / 563;
    const z = $('zoom').value;
    const availW = view.clientWidth;
    if (z === 'fit') { cssW = availW; cssH = cssW / aspect; }
    // [studio] fit height: the whole 768-unit UI is visible top to bottom; scroll sideways
    // [studio] fit the HUD: the middle 900 units (HUD, player and target frames) fill the width
    else if (z === 'hud') { const k = Math.max(0.4, Math.min(1.5, view.clientWidth / 900)); cssH = UI_HEIGHT * k; cssW = cssH * aspect; }
    else if (z === 'fith') { cssH = Math.max(240, view.clientHeight - 18); cssW = cssH * aspect; }
    else { cssH = UI_HEIGHT * Number(z); cssW = cssH * aspect; }
    scaleK = cssH / UI_HEIGHT;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  function centre() {
    view.scrollLeft = Math.max(0, (cssW - view.clientWidth) / 2);
    // "Fit the HUD" looks a little below the middle of the screen, where the HUD and unit frames sit
    const down = $('zoom').value === 'hud' ? 150 * scaleK : 0;
    view.scrollTop = Math.max(0, Math.min(cssH - view.clientHeight, (cssH - view.clientHeight) / 2 + down));
  }

  // ---------------------------------------------------------------- painting
  const rgba = (r, g, b, a) => `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
  const CLASSCOL = { WARRIOR: '#c79c6e', ROGUE: '#fff569', MAGE: '#40c7eb', PRIEST: '#ffffff', WARLOCK: '#8787ed', HUNTER: '#abd473', DRUID: '#ff7d0a', SHAMAN: '#0070de', PALADIN: '#f58cba' };
  function hue(n) { let h = 0; const s = String(n); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }

  function textRuns(text, base) {
    // WoW colour codes: |cAARRGGBB ... |r
    const runs = [];
    let colour = base, i = 0, buf = '';
    while (i < text.length) {
      if (text[i] === '|' && i + 1 < text.length) {
        const c = text[i + 1];
        if (c === 'c' && /^[0-9a-fA-F]{8}$/.test(text.substr(i + 2, 8))) {
          if (buf) runs.push({ t: buf, c: colour }); buf = '';
          colour = '#' + text.substr(i + 4, 6); i += 10; continue;
        }
        if (c === 'r') { if (buf) runs.push({ t: buf, c: colour }); buf = ''; colour = base; i += 2; continue; }
        if (c === 'n') { buf += '\u0001'; i += 2; continue; }
        if (c === 'T') { const e = text.indexOf('|t', i); if (e > 0) { i = e + 2; continue; } }
        if (c === '|') { buf += '|'; i += 2; continue; }
      }
      buf += text[i++];
    }
    if (buf) runs.push({ t: buf, c: colour });
    return runs;
  }

  function drawText(x, y, w, h, size, colour, alpha, jh, jv, flags, shadow, wrap, path, text) {
    if (size < 1) return;
    ctx.font = `${size}px ${family(path)}`;
    ctx.textBaseline = 'middle';
    // split into lines of runs
    let lines = [[]];
    for (const run of textRuns(text, colour)) {
      const parts = run.t.split('\u0001');
      parts.forEach((p, i) => { if (i > 0) lines.push([]); if (p) lines[lines.length - 1].push({ t: p, c: run.c }); });
    }
    if (wrap && w > 4) {
      const wrapped = [];
      for (const line of lines) {
        let cur = [], curW = 0;
        for (const run of line) {
          for (const word of run.t.split(/(\s+)/)) {
            if (!word) continue;
            const ww = ctx.measureText(word).width;
            if (curW + ww > w + 0.5 && curW > 0 && word.trim()) { wrapped.push(cur); cur = []; curW = 0; }
            if (cur.length === 0 && !word.trim()) continue;
            cur.push({ t: word, c: run.c }); curW += ww;
          }
        }
        wrapped.push(cur);
      }
      lines = wrapped;
    }
    const lh = size * 1.18, total = lines.length * lh;
    let ty = jv === 'TOP' ? y + lh / 2 : jv === 'BOTTOM' ? y + h - total + lh / 2 : y + h / 2 - total / 2 + lh / 2;
    const outline = /THICK/.test(flags) ? size / 4 : /OUTLINE/.test(flags) ? size / 7 : 0;
    ctx.globalAlpha = alpha;
    for (const line of lines) {
      const lw = line.reduce((s, r) => s + ctx.measureText(r.t).width, 0);
      let tx = jh === 'LEFT' ? x : jh === 'RIGHT' ? x + w - lw : x + w / 2 - lw / 2;
      for (const run of line) {
        if (outline) { ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(1.5, outline); ctx.strokeStyle = '#000'; ctx.strokeText(run.t, tx, ty); }
        else if (shadow) { ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fillText(run.t, tx + Math.max(1, size / 14), ty + Math.max(1, size / 14)); }
        ctx.fillStyle = run.c;
        ctx.fillText(run.t, tx, ty);
        tx += ctx.measureText(run.t).width;
      }
      ty += lh;
    }
    ctx.globalAlpha = 1;
  }

  function glyph(x, y, w, h, ch, colour, a) {
    ctx.globalAlpha = a;
    ctx.font = `${Math.min(w, h) * 0.95}px "Segoe UI Symbol", "Segoe UI Emoji", sans-serif`;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.strokeText(ch, x + w / 2, y + h / 2);
    ctx.fillStyle = colour; ctx.fillText(ch, x + w / 2, y + h / 2);
    ctx.textAlign = 'left'; ctx.globalAlpha = 1;
  }

  // [studio] a picture file, cropped by its texture coordinates, tinted by its vertex colour
  function drawPicture(f, x, y, w, h) {
    const r = +f[5], g = +f[6], b = +f[7], a = +f[8];
    if (a <= 0 || w <= 0 || h <= 0) return;
    const t = texture(f.slice(15).join('\t'));
    if (t.state === 'loading') return;                       // appears when it has been read
    if (t.state !== 'ok') {                                  // missing or unreadable: the old flat stand-in
      ctx.fillStyle = rgba(r, g, b, a * 0.6); ctx.fillRect(x, y, w, h);
      return;
    }
    const cl = v => Math.max(0, Math.min(1, v));
    const u0 = cl(Math.min(+f[11], +f[12])), u1 = cl(Math.max(+f[11], +f[12])), v0 = cl(Math.min(+f[13], +f[14])), v1 = cl(Math.max(+f[13], +f[14]));
    const sx = u0 * t.w, sy = v0 * t.h, sw = Math.max(1, (u1 - u0) * t.w), sh = Math.max(1, (v1 - v0) * t.h);
    const flipX = +f[11] > +f[12], flipY = +f[13] > +f[14];
    ctx.save();
    ctx.globalAlpha = a;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    if (f[9] === '1') ctx.globalCompositeOperation = 'lighter';
    if (f[10] === '1') ctx.filter = 'grayscale(1)';
    if (flipX || flipY) { ctx.translate(x + w / 2, y + h / 2); ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1); ctx.translate(-(x + w / 2), -(y + h / 2)); }
    if (r > 0.995 && g > 0.995 && b > 0.995) {
      ctx.drawImage(t.canvas, sx, sy, sw, sh, x, y, w, h);
    } else {
      // multiply by the vertex colour on a scratch canvas, keeping the picture's own alpha
      const dpr = window.devicePixelRatio || 1;
      const tw = Math.max(1, Math.min(2048, Math.ceil(w * dpr))), th = Math.max(1, Math.min(2048, Math.ceil(h * dpr)));
      if (tintCanvas.width !== tw || tintCanvas.height !== th) { tintCanvas.width = tw; tintCanvas.height = th; }
      tctx.globalCompositeOperation = 'copy';
      tctx.drawImage(t.canvas, sx, sy, sw, sh, 0, 0, tw, th);
      tctx.globalCompositeOperation = 'multiply';
      tctx.fillStyle = rgba(r, g, b, 1); tctx.fillRect(0, 0, tw, th);
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(t.canvas, sx, sy, sw, sh, 0, 0, tw, th);
      ctx.drawImage(tintCanvas, 0, 0, tw, th, x, y, w, h);
    }
    ctx.restore();
  }

  function paint(list) {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    if (bgOK) ctx.drawImage(bg, 0, 0, cssW, cssH); else { ctx.fillStyle = '#20242b'; ctx.fillRect(0, 0, cssW, cssH); }
    if (!list) return;
    let clipped = false, turned = false;
    const k = scaleK;
    for (const line of list.split('\n')) {
      const f = line.split('\t');
      const op = f[0];
      if (op === 'K') {
        if (turned) { ctx.restore(); turned = false; }
        if (clipped) { ctx.restore(); clipped = false; }
        if (f.length > 1) { ctx.save(); ctx.beginPath(); ctx.rect(+f[1], +f[2], +f[3], +f[4]); ctx.clip(); clipped = true; }
        continue;
      }
      // [studio] X cx cy angle ... x : what is drawn in between is turned about (cx, cy)
      if (op === 'X') {
        if (turned) ctx.restore();
        ctx.save(); ctx.translate(+f[1], +f[2]); ctx.rotate(+f[3]); ctx.translate(-f[1], -f[2]); turned = true;
        continue;
      }
      if (op === 'x') { if (turned) { ctx.restore(); turned = false; } continue; }
      const x = +f[1], y = +f[2], w = +f[3], h = +f[4];
      switch (op) {
        case 'R': {
          const a = +f[8];
          if (a <= 0) break;
          if (f[9] === '1') ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = rgba(+f[5], +f[6], +f[7], a);
          ctx.fillRect(x, y, w, h);
          if (f[10] === '1' && h > 3) {           // status bar texture: a soft gloss
            const g = ctx.createLinearGradient(0, y, 0, y + h);
            g.addColorStop(0, `rgba(255,255,255,${0.22 * a})`); g.addColorStop(0.5, 'rgba(255,255,255,0)'); g.addColorStop(1, `rgba(0,0,0,${0.28 * a})`);
            ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
          }
          ctx.globalCompositeOperation = 'source-over';
          break;
        }
        case 'B': {
          const lw = +f[9];
          ctx.strokeStyle = rgba(+f[5], +f[6], +f[7], +f[8]);
          ctx.lineWidth = lw;
          if (f[10] === '1') { ctx.beginPath(); ctx.roundRect(x + lw / 2, y + lw / 2, w - lw, h - lw, 4 * k); ctx.stroke(); }
          else ctx.strokeRect(x + lw / 2, y + lw / 2, w - lw, h - lw);
          break;
        }
        case 'T':
          drawText(x, y, w, h, +f[5], rgba(+f[6], +f[7], +f[8], 1), +f[9], f[10], f[11], f[12], f[13] === '1', f[14] === '1', f[15], f.slice(16).join('\t'));
          break;
        case 'P':
          drawPicture(f, x, y, w, h);
          break;
        case 'W': {                                // [studio] ColorSelect: the hue / saturation wheel
          const d = Math.min(w, h);
          ctx.globalAlpha = +f[5];
          ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(colourWheel(), x + (w - d) / 2, y + (h - d) / 2, d, d);
          ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, d / 2, 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = 1;
          break;
        }
        case 'G': {                                // [studio] ColorSelect: the brightness bar, colour at the top, black below
          ctx.globalAlpha = +f[5];
          const g = ctx.createLinearGradient(0, y, 0, y + h);
          g.addColorStop(0, rgba(+f[6], +f[7], +f[8], 1)); g.addColorStop(1, '#000');
          ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
          ctx.globalAlpha = 1;
          break;
        }
        case 'I': {
          const a = +f[5], hh = hue(f[6]), sat = f[8] === '1' ? 6 : 55;
          ctx.globalAlpha = a;
          const g = ctx.createLinearGradient(x, y, x + w, y + h);
          g.addColorStop(0, `hsl(${hh},${sat}%,46%)`); g.addColorStop(1, `hsl(${(hh + 40) % 360},${sat}%,16%)`);
          ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
          if (f[7]) {
            const label = f[7].slice(0, 3);
            ctx.font = `600 ${Math.max(7, w * 0.36)}px system-ui, sans-serif`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillText(label, x + w / 2 + 1, y + h / 2 + 1);
            ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillText(label, x + w / 2, y + h / 2);
            ctx.textAlign = 'left';
          }
          // [studio] the vertex colour multiplies the icon: (0.35, 0.35, 0.35) is the HUDs' "on cooldown" dark
          if (f.length > 11 && (+f[9] < 0.995 || +f[10] < 0.995 || +f[11] < 0.995)) {
            ctx.globalCompositeOperation = 'multiply';
            ctx.fillStyle = rgba(+f[9], +f[10], +f[11], 1); ctx.fillRect(x, y, w, h);
            ctx.globalCompositeOperation = 'source-over';
          }
          ctx.globalAlpha = 1;
          break;
        }
        case 'C': {
          const frac = +f[6];
          ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
          ctx.fillStyle = `rgba(0,0,0,${0.66 * +f[5]})`;
          ctx.beginPath(); ctx.moveTo(x + w / 2, y + h / 2);
          ctx.arc(x + w / 2, y + h / 2, w + h, -Math.PI / 2 + (1 - frac) * Math.PI * 2, -Math.PI / 2 + Math.PI * 2);
          ctx.closePath(); ctx.fill(); ctx.restore();
          break;
        }
        case 'S': {
          const a = +f[8];
          ctx.globalCompositeOperation = 'lighter';
          const g = ctx.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.max(w, h) / 2);
          g.addColorStop(0, rgba(1, 1, 0.9, 0.95 * a)); g.addColorStop(0.35, rgba(+f[5], +f[6], +f[7], 0.5 * a)); g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
          ctx.globalCompositeOperation = 'source-over';
          break;
        }
        case 'O': {
          ctx.globalAlpha = +f[5];
          ctx.fillStyle = '#15171c'; ctx.fillRect(x, y, w, h);
          const col = CLASSCOL[f[6]] || '#b0483a';
          const g = ctx.createRadialGradient(x + w / 2, y + h * 0.42, 1, x + w / 2, y + h / 2, Math.max(w, h) * 0.6);
          g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0.85)');
          ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
          ctx.fillStyle = 'rgba(0,0,0,0.55)';
          ctx.beginPath(); ctx.arc(x + w / 2, y + h * 0.4, Math.min(w, h) * 0.2, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.ellipse(x + w / 2, y + h * 1.02, w * 0.36, h * 0.42, 0, Math.PI, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
          break;
        }
        case 'M': {
          ctx.save(); ctx.globalAlpha = +f[5];
          ctx.beginPath();
          if (f[6] === 'square') ctx.rect(x, y, w, h); else ctx.arc(x + w / 2, y + h / 2, w / 2, 0, Math.PI * 2);
          ctx.clip();
          const zoom = 1 + (+f[7] || 0) * 0.5;
          if (bgOK) {
            const sw = bg.naturalWidth * 0.16 / zoom, sh = sw * (h / w);
            ctx.filter = 'saturate(0.7) brightness(0.8)';
            ctx.drawImage(bg, bg.naturalWidth * 0.5 - sw / 2, bg.naturalHeight * 0.62 - sh / 2, sw, sh, x, y, w, h);
            ctx.filter = 'none';
          } else { ctx.fillStyle = '#3d4a2c'; ctx.fillRect(x, y, w, h); }
          ctx.fillStyle = '#ffd24a'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x + w / 2, y + h / 2 - 6 * k); ctx.lineTo(x + w / 2 + 4 * k, y + h / 2 + 5 * k); ctx.lineTo(x + w / 2 - 4 * k, y + h / 2 + 5 * k); ctx.closePath(); ctx.fill(); ctx.stroke();
          ctx.restore();
          if (f[6] !== 'square') {
            ctx.strokeStyle = 'rgba(190,160,90,0.95)'; ctx.lineWidth = 3 * k;
            ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, w / 2, 0, Math.PI * 2); ctx.stroke();
          }
          break;
        }
        case 'Y': {
          const kind = f[6];
          const map = { combat: ['⚔', '#ff5a4a'], rest: ['zZ', '#ffe07a'], leader: ['♛', '#ffd24a'], phase: ['◌', '#9fd0ff'], rez: ['✚', '#7dff8a'], pvp: ['⚑', f[7] === 'A' ? '#5aa0ff' : '#ff5a4a'] };
          if (kind === 'raid') glyph(x, y, w, h, f[7] === '8' ? '☠' : '★', f[7] === '8' ? '#ffffff' : '#ffe04a', +f[5]);
          else if (map[kind]) glyph(x, y, w, h, map[kind][0], map[kind][1], +f[5]);
          break;
        }
        case 'Z': {
          ctx.strokeStyle = `rgba(200,200,200,${0.8 * +f[5]})`; ctx.lineWidth = 1.2;
          for (let i = 1; i <= 3; i++) { ctx.beginPath(); ctx.moveTo(x + w - 2, y + h - 2 - i * h * 0.25); ctx.lineTo(x + w - 2 - i * w * 0.25, y + h - 2); ctx.stroke(); }
          break;
        }
        case 'U': {
          const st = f[6];
          ctx.globalAlpha = +f[5];
          const g = ctx.createLinearGradient(0, y, 0, y + h);
          if (st === '3') { g.addColorStop(0, '#3a3a3a'); g.addColorStop(1, '#222'); }
          else if (st === '2') { g.addColorStop(0, '#3a0505'); g.addColorStop(1, '#6a1010'); }
          else if (st === '1') { g.addColorStop(0, '#9a2020'); g.addColorStop(1, '#4a0a0a'); }
          else { g.addColorStop(0, '#7a1414'); g.addColorStop(1, '#3a0707'); }
          ctx.fillStyle = g; ctx.beginPath(); ctx.roundRect(x, y, w, h, 3 * k); ctx.fill();
          ctx.strokeStyle = st === '3' ? '#555' : '#9a7a2e'; ctx.lineWidth = 1; ctx.stroke();
          ctx.globalAlpha = 1;
          break;
        }
        case 'H': {
          const s = Math.min(w, h) * 0.62, bx = x + (w - s) / 2, by = y + (h - s) / 2;
          ctx.globalAlpha = +f[5] * (f[8] === '1' ? 0.5 : 1);
          ctx.fillStyle = '#101114'; ctx.fillRect(bx, by, s, s);
          ctx.strokeStyle = f[7] === '1' ? '#e8c56a' : '#8a7340'; ctx.lineWidth = 1.2; ctx.strokeRect(bx + 0.5, by + 0.5, s - 1, s - 1);
          if (f[6] === '1') {
            ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = Math.max(1.6, s * 0.16); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            ctx.beginPath(); ctx.moveTo(bx + s * 0.2, by + s * 0.52); ctx.lineTo(bx + s * 0.42, by + s * 0.76); ctx.lineTo(bx + s * 0.84, by + s * 0.2); ctx.stroke();
            ctx.lineCap = 'butt';
          }
          ctx.globalAlpha = 1;
          break;
        }
        case 'L': {
          const frac = +f[6], pad = 8 * k, ty = y + h / 2;
          ctx.globalAlpha = +f[5] * (f[7] === '1' ? 0.5 : 1);
          ctx.fillStyle = '#0d0e11'; ctx.fillRect(x, ty - 3 * k, w, 6 * k);
          ctx.strokeStyle = '#6a5a34'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, ty - 3 * k + 0.5, w - 1, 6 * k - 1);
          const tx = x + pad + (w - 2 * pad) * frac;
          const g = ctx.createLinearGradient(0, ty - 8 * k, 0, ty + 8 * k);
          g.addColorStop(0, '#f1d27a'); g.addColorStop(1, '#8a6a22');
          ctx.fillStyle = g; ctx.beginPath(); ctx.roundRect(tx - 5 * k, ty - 8 * k, 10 * k, 16 * k, 2 * k); ctx.fill();
          ctx.strokeStyle = '#2a2008'; ctx.stroke();
          ctx.globalAlpha = 1;
          break;
        }
        case 'V': {
          const pos = +f[6], thumb = +f[7];
          ctx.globalAlpha = +f[5];
          ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(x, y, w, h);
          const th = h * thumb, ty = y + (h - th) * pos;
          ctx.fillStyle = '#b79846'; ctx.beginPath(); ctx.roundRect(x + 2, ty, w - 4, th, 3); ctx.fill();
          ctx.globalAlpha = 1;
          break;
        }
        case 'E': {
          ctx.globalAlpha = +f[5];
          ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = f[6] === '1' ? '#e8c56a' : '#6a6a6a'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
          ctx.globalAlpha = 1;
          break;
        }
        case 'Q': {
          const s = Math.min(w, h) * 0.6, bx = x + (w - s) / 2, by = y + (h - s) / 2;
          ctx.globalAlpha = +f[5];
          ctx.fillStyle = f[6] === '1' ? '#b02a2a' : '#7a1414'; ctx.beginPath(); ctx.roundRect(bx, by, s, s, 3); ctx.fill();
          ctx.strokeStyle = '#d8b25a'; ctx.lineWidth = 1; ctx.stroke();
          ctx.strokeStyle = '#ffe9a8'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(bx + s * 0.28, by + s * 0.28); ctx.lineTo(bx + s * 0.72, by + s * 0.72);
          ctx.moveTo(bx + s * 0.72, by + s * 0.28); ctx.lineTo(bx + s * 0.28, by + s * 0.72); ctx.stroke();
          ctx.globalAlpha = 1;
          break;
        }
        case 'A': {
          const sel = f[6] === '1';
          ctx.globalAlpha = +f[5];
          ctx.fillStyle = sel ? '#3a2f14' : (f[7] === '1' ? '#2a2c33' : '#1c1e24');
          ctx.beginPath(); ctx.roundRect(x + 1, y + 2, w - 2, h - 2, [5 * k, 5 * k, 0, 0]); ctx.fill();
          ctx.strokeStyle = sel ? '#c9a54a' : '#55503f'; ctx.lineWidth = 1; ctx.stroke();
          ctx.globalAlpha = 1;
          break;
        }
      }
    }
    if (turned) ctx.restore();
    if (clipped) ctx.restore();
  }

  // ---------------------------------------------------------------- loop
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000));
    last = now;
    const list = ready ? call('PV_frame', dt, cssW, cssH, scaleK) : null;
    paint(typeof list === 'string' ? list : null);
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- input
  function pos(e) { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  const held = new Set();                    // [studio] buttons that went down on the canvas, so each gets its own "up"
  canvas.addEventListener('mousemove', e => { if (ready) { const [x, y] = pos(e); call('PV_mouse', 'move', x, y, 0, e.ctrlKey, e.shiftKey); } });
  canvas.addEventListener('mousedown', e => {
    if (!ready) return;
    const [x, y] = pos(e);
    held.add(e.button);
    call('PV_mouse', 'move', x, y, 0, e.ctrlKey, e.shiftKey);
    call('PV_mouse', 'down', x, y, e.button, e.ctrlKey, e.shiftKey);   // 0 left, 1 middle, 2 right
    e.preventDefault(); canvas.focus();
  });
  window.addEventListener('mousemove', e => {  // a drag that leaves the canvas keeps following the cursor
    if (ready && held.size && e.target !== canvas) { const [x, y] = pos(e); call('PV_mouse', 'move', x, y, 0, e.ctrlKey, e.shiftKey); }
  });
  window.addEventListener('mouseup', e => {
    if (!ready || !held.has(e.button)) return;
    held.delete(e.button);
    const [x, y] = pos(e);
    call('PV_mouse', 'up', x, y, e.button, e.ctrlKey, e.shiftKey);
  });
  // [studio] the right button belongs to the addon (CTRL + right drag turns an item): no browser menu
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('auxclick', e => e.preventDefault());
  canvas.addEventListener('wheel', e => {
    if (!ready) return;
    const [x, y] = pos(e);
    const used = call('PV_wheel', x, y, e.deltaY < 0 ? 1 : -1, e.ctrlKey, e.shiftKey) === true;
    // [studio] CTRL + wheel sizes an item; it must never zoom the page, used or not
    if (used || e.ctrlKey) e.preventDefault();
  }, { passive: false });
  canvas.tabIndex = 0;
  canvas.style.outline = 'none';
  // [studio] CTRL / SHIFT / ALT are told to the engine as they change, not only with the next mouse move
  const mods = e => { if (ready) call('PV_mods', e.ctrlKey, e.shiftKey, e.altKey); };
  window.addEventListener('keydown', mods, true);
  window.addEventListener('keyup', mods, true);
  // [studio] Esc must reach the addon even when focus sits on a toolbar button
  // (e.g. after "Open options"), not only when the canvas has focus
  window.addEventListener('keydown', e => {
    if (!ready || e.key !== 'Escape' || e.target === canvas) return;
    if (e.target.closest && e.target.closest('input, select, textarea, #picker')) return;
    if (call('PV_key', 'Escape', '') === true) { e.preventDefault(); canvas.focus(); }
  });
  window.addEventListener('blur', () => { if (ready) call('PV_mods', false, false, false); });
  canvas.addEventListener('keydown', e => {
    if (!ready) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;      // the paste event below takes it
    if (e.ctrlKey || e.metaKey) return;
    if (call('PV_key', e.key, e.key.length === 1 ? e.key : '') === true) e.preventDefault();
  });
  // pasted text goes into the addon's focused edit box
  canvas.addEventListener('paste', e => {
    const t = e.clipboardData && e.clipboardData.getData('text');
    if (ready && t) { call('PV_text', t); e.preventDefault(); }
  });

  // ---------------------------------------------------------------- toolbar
  function runSlash(t) {
    const r = call('PV_slash', t);
    if (r === 'reload') { switchTo(current); return; }
    if (r !== true) log('No addon answered ' + t.split(' ')[0], 'w');
  }
  $('startfrom').addEventListener('change', () => { store.set('startfrom', $('startfrom').value); if (current) switchTo(current); });
  $('cls').addEventListener('change', () => { store.set('cls', $('cls').value); if (current) switchTo(current); });
  $('reload').addEventListener('click', () => { if (current) switchTo(current); });
  $('save').addEventListener('click', () => save(false));
  $('export').addEventListener('click', exportOut);
  $('options').addEventListener('click', () => { if (ready && slashCmd) runSlash(slashCmd); canvas.focus(); });
  $('target').addEventListener('change', () => { store.set('target', $('target').value); if (ready) call('PV_cmd', 'target', $('target').value); });
  $('combat').addEventListener('change', () => { if (ready) call('PV_cmd', 'combat', $('combat').checked ? '1' : '0'); });
  $('auto').addEventListener('change', () => { if (ready) call('PV_cmd', 'auto', $('auto').checked ? '1' : '0'); });
  $('zoom').addEventListener('change', () => { store.set('zoom', $('zoom').value); layout(); centre(); });
  $('slash').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !ready) return;
    const t = $('slash').value.trim();
    if (t) runSlash(t);
    $('slash').select();
  });
  $('logbtn').addEventListener('click', () => {
    $('logwrap').classList.toggle('open');
    store.set('log', $('logwrap').classList.contains('open') ? '1' : '0');
    layout();
  });
  $('logclear').addEventListener('click', () => { $('log').textContent = ''; logLines.length = 0; luaErrors = 0; showErrors(); });
  $('logcopy').addEventListener('click', () => { if (navigator.clipboard) navigator.clipboard.writeText(logLines.join('\n')).catch(() => {}); });
  $('colour').addEventListener('input', () => {
    const v = $('colour').value;
    const c = [1, 3, 5].map(i => (parseInt(v.substr(i, 2), 16) / 255).toFixed(3)).join(',');
    if (ready) call('PV_cmd', 'color', c);
  });
  $('bgpick').addEventListener('click', () => $('bgfile').click());
  $('bgfile').addEventListener('change', () => {
    const file = $('bgfile').files[0];
    if (file) setBackground(URL.createObjectURL(file));
  });
  $('bgreset').addEventListener('click', () => setBackground('bg.jpg'));
  window.addEventListener('resize', () => { layout(); centre(); });
  // [studio] compact mode (?compact=1): tiled windows show only the preview; two small buttons stay
  if (query.get('compact')) document.body.classList.add('compact', 'wasCompact');
  $('minibar').addEventListener('click', () => { document.body.classList.toggle('compact'); layout(); centre(); });
  $('miniopt').addEventListener('click', () => $('options').click());
  // [studio] closing the window keeps the adjustments too (same files as the Save button)
  window.addEventListener('pagehide', () => {
    if (!ready || !plan) return;
    call('PV_logout');
    for (const a of plan.order) {
      const text = call('PV_serialize', a.name);
      if (typeof text === 'string' && text.trim()) navigator.sendBeacon(`/state/${encodeURIComponent(a.name)}.lua`, new Blob([text], { type: 'text/plain' }));
    }
  });

  function setBackground(url) {
    const img = new Image();
    img.onload = () => { bg = img; bgOK = true; layout(); centre(); };
    img.onerror = () => log('That image did not load.', 'e');
    img.src = url;
  }

  // for looking at things from the developer console and from automated checks
  window.studio = {
    call, save, exportOut, open: switchTo, runSlash,
    get ready() { return ready; }, get scale() { return scaleK; }, get current() { return current; },
    get errors() { return luaErrors; }, get log() { return logLines.slice(); },
    textures: () => [...textures.entries()].map(e => `${e[0]} ${e[1].state} ${e[1].w || 0}x${e[1].h || 0}`),
  };

  // ---------------------------------------------------------------- start
  (async () => {
    try {
      clientSrc = await (await fetch('client.lua?t=' + Date.now())).text();
      await loadList();
      $('startfrom').value = query.get('start') || store.get('startfrom', 'auto');
      $('cls').value = store.get('cls', 'auto');
      $('target').value = store.get('target', 'enemy');
      // the log starts open where there is room for it; a Lua error always opens it
      if (store.get('log', window.innerHeight >= 800 ? '1' : '0') === '0') $('logwrap').classList.remove('open');
      // fit the width when the whole UI then fits the window; otherwise fit the height
      // (the whole 768-unit UI visible, sideways scroll), or 100% on a very small window
      const fitW = view.clientWidth / (2000 / 563);
      const auto = fitW <= view.clientHeight ? 'fit' : (view.clientHeight / UI_HEIGHT >= 0.5 ? 'fith' : '1');
      $('zoom').value = query.get('zoom') || store.get('zoom', auto);
      bg.onload = () => { bgOK = true; layout(); centre(); };
      bg.src = 'bg.jpg';
      layout();
      requestAnimationFrame(frame);
      const names = addonList.map(a => a.name);
      const want = query.get('addon') || store.get('addon', 'ForeverWarriorHUD2');
      if (!names.length) { status('No addons found. Choose the game folder.'); openPicker(); return; }
      if (names.includes(want)) {
        await boot(want);
        // ?run=/fw2;;/run print(1)  runs slash commands once the addon is up (used by the automated look-at-it check)
        for (const cmd of (query.get('run') || '').split(';;').map(s => s.trim()).filter(Boolean)) if (ready) runSlash(cmd);
      } else { status('Choose an addon.'); openPicker(); }
    } catch (e) {
      log('Start-up failed: ' + e.message, 'e');
    }
  })();
})();
