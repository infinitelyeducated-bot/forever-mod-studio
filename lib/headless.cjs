// Forever Mod Studio: the engine without a window. Loads an addon exactly as
// the page does (same load plan, same PV_* calls) so the checks test the real path.
const fs = require('fs'), path = require('path');
const addons = require('./addons.cjs');
let fengari;
try { fengari = require('fengari'); }
catch (e) { fengari = require(process.env.FENGARI || 'fengari'); }   // set FENGARI to a path if the package is elsewhere
const { lua, lauxlib, lualib, to_luastring } = fengari;

const CLASSES = ['Rogue', 'Druid', 'Hunter', 'Mage', 'Paladin', 'Priest', 'Shaman', 'Warlock', 'Warrior'];
function classOf(name) {
  const m = /^Forever(\w+?)HUD2?$/.exec(name);
  return m && CLASSES.includes(m[1]) ? m[1].toUpperCase() : 'WARRIOR';
}

// opts: { game, also, saved: 'fresh' | 'game' | 'state', cls }
function open(name, opts = {}) {
  const game = opts.game || process.env.WOW_FOREVER || addons.readConfig().gameFolder;
  const config = addons.readConfig();
  const logs = [];
  const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
  const reg = (n, fn) => { lua.lua_pushcfunction(L, fn); lua.lua_setglobal(L, to_luastring(n)); };
  reg('HOST_measure', S => { const t = lua.lua_tojsstring(S, 1) || ''; lua.lua_pushnumber(S, t.length * lua.lua_tonumber(S, 3) * 0.52); return 1; });
  reg('HOST_log', S => { logs.push(lua.lua_tojsstring(S, 1)); return 0; });
  reg('HOST_confirm', S => { lua.lua_pushboolean(S, true); return 1; });
  reg('HOST_color', () => 0);
  const call = (fn, ...args) => {
    lua.lua_getglobal(L, to_luastring(fn));
    for (const a of args) {
      if (typeof a === 'number') lua.lua_pushnumber(L, a);
      else if (typeof a === 'boolean') lua.lua_pushboolean(L, a);
      else lua.lua_pushstring(L, to_luastring(String(a)));
    }
    if (lua.lua_pcall(L, args.length, 1, 0) !== lua.LUA_OK) { const e = lua.lua_tojsstring(L, -1); lua.lua_pop(L, 1); throw new Error(fn + ': ' + e); }
    const r = lua.lua_type(L, -1) === lua.LUA_TSTRING ? lua.lua_tojsstring(L, -1) : lua.lua_toboolean(L, -1);
    lua.lua_pop(L, 1);
    return r;
  };
  if (lauxlib.luaL_dofile(L, to_luastring(path.join(addons.ROOT, 'client.lua'))) !== lua.LUA_OK) throw new Error(lua.lua_tojsstring(L, -1));

  const also = opts.also || addons.companionsFor(config, name);
  const plan = addons.plan(game, name, also);
  if (plan.error) throw new Error(plan.error);
  const skipped = [];
  call('PV_begin', opts.cls || classOf(name), plan.target);
  for (const a of plan.order) {
    call('PV_meta', a.name, 'Title', a.title); call('PV_meta', a.name, 'Version', a.version); call('PV_meta', a.name, 'Notes', a.notes);
    let saved = null;
    if (opts.saved === 'game') saved = addons.readGameSaved(game, a.name);
    else if (opts.saved === 'state') saved = addons.readState(a.name);
    if (saved) call('PV_saved', saved, a.name + ' SavedVariables');
    for (const f of a.files) {
      if (f.kind === 'lua') {
        const src = fs.readFileSync(path.join(addons.addonsDir(game), a.name, f.path), 'utf8').replace(/^\uFEFF/, '');
        call('PV_file', a.name, f.path, src);
      } else skipped.push(`${a.name}\${f.path} (${f.kind}${f.note ? ': ' + f.note : ''})`);
    }
    call('PV_loaded', a.name, [...a.saved, ...a.savedPerChar].join(','));
  }
  call('PV_start');

  const W = opts.W || 2400, H = opts.H || 768;
  const h = {
    name: plan.target, plan, logs, skipped, call, W, H, draw: '',
    run(n = 1, dt = 0.1) { for (let i = 0; i < n; i++) h.draw = call('PV_frame', dt, W, H, 1); return h.draw; },
    eval(code) { return call('PV_eval', code); },
    num(code) { return Number(call('PV_eval', code)); },
    rect(nameOrCode) {
      let s = call('PV_rect', nameOrCode);
      if (!s) s = call('PV_eval', `(function() local r = PV.Rect(${nameOrCode}) return r and string.format("%.2f %.2f %.2f %.2f", r.x, r.y, r.w, r.h) or "" end)()`);
      if (!s || /^error|^nil$/.test(s)) return null;
      const [x, y, w, hh] = s.split(' ').map(Number);
      return { x, y, w, h: hh, cx: x + w / 2, cy: y + hh / 2 };
    },
    mouse(kind, x, y, button = 0, ctrl = false, shift = false) { return call('PV_mouse', kind, x, y, button, ctrl, shift); },
    wheel(x, y, delta, ctrl = false) { return call('PV_wheel', x, y, delta, ctrl, false); },
    click(x, y, button = 0, ctrl = false) { h.mouse('move', x, y, 0, ctrl); h.mouse('down', x, y, button, ctrl); h.mouse('up', x, y, button, ctrl); },
    slash(text) { return call('PV_slash', text); },
    errors() { return [...new Set(logs.filter(l => /Lua error/.test(l)))]; },
    errorCount() { return Number(call('PV_errors')); },
    serialize(addon) { return call('PV_serialize', addon || plan.target); },
  };
  return h;
}

module.exports = { open, classOf, CLASSES };
