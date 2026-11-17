// Stress runner for the studio engine. Each simulation boots one addon in a
// fresh headless engine and performs a long random sequence of user-like
// actions: slash commands, options and settings flips, clicks, wheel turns,
// CTRL drags, combat and target changes. After every action it checks the
// engine's Lua error counter. A failing simulation is replayable from its seed.
//
//   node stress.cjs                     one batch of 20 simulations (seeds from --seed)
//   node stress.cjs --batch 20 --seed 1000 --steps 60
//   node stress.cjs --addon ForeverWarriorHUD2 --seed 42    replay one simulation verbosely
//
// Output: one JSON line per failing simulation, plus a summary line.
'use strict';
const { open, CLASSES } = require('./lib/headless.cjs');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BATCH = Number(arg('--batch', 20));
const SEED0 = Number(arg('--seed', 1000));
const STEPS = Number(arg('--steps', 60));
const ONE = arg('--addon', null);
const VERBOSE = args.includes('--verbose') || !!ONE;

// all 19 addons the studio can run for the HUDs (originals, "2" builds) plus HelloForever
const ADDONS = [];
for (const cls of CLASSES) for (const sfx of ['', '2']) ADDONS.push(`Forever${cls}HUD${sfx}`);
ADDONS.push('HelloForever');
const SLASH = { Rogue: 'fr', Druid: 'fd', Hunter: 'fh', Mage: 'fm', Paladin: 'fpa', Priest: 'fpr', Shaman: 'fs', Warlock: 'fwl', Warrior: 'fw' };
const COMMANDS = ['', 'help', 'abilities', 'apply', 'config', 'font', 'frames', 'map', 'panel', 'profiles',
  'skins', 'text', 'lock', 'unlock', 'show', 'hide', 'reset', 'minimap', 'frame', 'fonts'];
const TARGETS = ['enemy', 'friend', 'boss', 'none'];

// small seeded PRNG (mulberry32): the same seed always produces the same run
function rng(seed) {
  let a = seed >>> 0;
  const r = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { r, pick: xs => xs[Math.floor(r() * xs.length)], int: (lo, hi) => lo + Math.floor(r() * (hi - lo + 1)), chance: p => r() < p };
}

// Lua helpers evaluated inside the engine: the addon's own prefix, its frame names, its settings table
const PREFIX_LUA = `(function() for k in pairs(_G) do local p = type(k) == "string" and k:match("^(%u+2?)_VERSION$") if p then return p end end return "" end)()`;
const FRAMES_LUA = (p) => `(function() local t = {} for k, v in pairs(_G) do if type(k) == "string" and k:sub(1, #"${p}") == "${p}" and type(v) == "table" and type(v.GetObjectType) == "function" then local r = PV.Rect(v) if r then t[#t + 1] = k end end end table.sort(t) return table.concat(t, ",") end)()`;

function step(h, rand, addon, label) {
  const DB = `${addon}_DB`;
  const kind = rand.pick(['slash', 'slash', 'target', 'combat', 'click', 'click', 'wheel', 'drag', 'drag', 'flag', 'number', 'run', 'run']);
  const frames = (h.eval(FRAMES_LUA(h.prefix)) || '').split(',').filter(Boolean);
  const before = h.errorCount();
  let desc = kind;
  switch (kind) {
    case 'slash': {
      const cmd = rand.pick(COMMANDS);
      desc = `slash "/${h.slashWord}${h.two ? '2' : ''} ${cmd}"`;
      h.slash(`/${h.slashWord}${h.two ? '2' : ''} ${cmd}`);
      h.run(rand.int(1, 6));
      break;
    }
    case 'target': { const t = rand.pick(TARGETS); desc = `target ${t}`; h.call('PV_cmd', 'target', t); h.run(2); break; }
    case 'combat': { const on = rand.chance(0.5); desc = `combat ${on}`; h.call('PV_cmd', 'combat', on ? '1' : '0'); h.run(3); break; }
    case 'click': { const x = rand.int(0, h.W - 1), y = rand.int(0, h.H - 1); desc = `click ${x},${y}`; h.click(x, y, rand.pick([0, 1]), rand.chance(0.3)); h.run(1); break; }
    case 'wheel': { const x = rand.int(0, h.W - 1), y = rand.int(0, h.H - 1); desc = `wheel ${x},${y}`; h.wheel(x, y, rand.pick([-1, 1]), rand.chance(0.7)); h.run(1); break; }
    case 'drag': {
      if (!frames.length) { desc = 'drag (no frames)'; break; }
      const name = rand.pick(frames); const r = h.rect(name);
      if (!r) { desc = 'drag (no rect)'; break; }
      const ctrl = rand.chance(0.8), button = rand.pick([0, 1]);
      const dx = rand.int(-200, 200), dy = rand.int(-150, 150);
      desc = `drag ${name} by ${dx},${dy} ctrl=${ctrl} button=${button}`;
      h.mouse('move', r.cx, r.cy, 0, ctrl); h.run(1);
      h.mouse('down', r.cx, r.cy, button, ctrl); h.run(1);
      for (let i = 1; i <= 6; i++) { h.mouse('move', r.cx + dx * i / 6, r.cy + dy * i / 6, 0, ctrl); h.run(1); }
      h.mouse('up', r.cx + dx, r.cy + dy, button, ctrl); h.run(1);
      break;
    }
    case 'flag': {
      // flip one top-level boolean setting of the addon (the same key a checkbox writes)
      const key = h.eval(`(function() local t = {} for k, v in pairs(${DB} or {}) do if type(v) == "boolean" then t[#t + 1] = k end end table.sort(t) return table.concat(t, ",") end)()`).split(',').filter(Boolean);
      if (!key.length) { desc = 'flag (none)'; break; }
      const k = rand.pick(key);
      desc = `flag ${k}`;
      h.eval(`${DB}["${k}"] = not ${DB}["${k}"]`);
      h.run(3);
      break;
    }
    case 'number': {
      const f = rand.pick(frames); const v = (rand.int(50, 200) / 100).toFixed(2);
      desc = `scale ${f} ${v}`;
      h.eval(`(function() local f = _G["${f}"] if f and f.SetScale then f:SetScale(${v}) end return "" end)()`);
      h.run(2);
      break;
    }
    case 'run': { const n = rand.int(5, 40); desc = `run ${n}`; h.run(n); break; }
  }
  const after = h.errorCount();
  return { desc, failed: after > before, errs: after - before };
}

function simulate(seed) {
  const rand = rng(seed);
  const addon = ONE || rand.pick(ADDONS);
  const h = open(addon, { saved: 'fresh' });
  h.prefix = h.eval(PREFIX_LUA);
  const cls = addon.match(/Forever(\w+?)HUD/);
  h.slashWord = cls ? SLASH[cls[1]] : 'hf';
  h.two = /2$/.test(addon);
  h.call('PV_cmd', 'target', 'enemy'); h.call('PV_cmd', 'combat', '1');
  h.run(20);
  const log = [];
  for (let i = 0; i < STEPS; i++) {
    const s = step(h, rand, addon, i);
    log.push(s.desc + (s.failed ? `  <-- +${s.errs} Lua error(s)` : ''));
    if (VERBOSE) console.log(`  [${i}] ${s.desc}${s.failed ? '  <-- +' + s.errs + ' error(s)' : ''}`);
    if (s.failed) {
      return { seed, addon, ok: false, step: i, action: s.desc, errors: h.errors().slice(0, 4), tail: log.slice(-6) };
    }
  }
  return { seed, addon, ok: h.errorCount() === 0, step: STEPS, errors: h.errors().slice(0, 4), tail: log.slice(-3) };
}

let failed = 0;
for (let i = 0; i < (ONE ? 1 : BATCH); i++) {
  const seed = SEED0 + i;
  let r;
  try { r = simulate(seed); }
  catch (e) { r = { seed, addon: ONE || '?', ok: false, crash: e.message }; }
  if (!r.ok) { failed++; console.log(JSON.stringify(r)); }
}
console.log(`batch seeds ${SEED0}..${SEED0 + (ONE ? 0 : BATCH - 1)}: ${(ONE ? 1 : BATCH) - failed} clean, ${failed} failing`);
process.exit(failed ? 1 : 0);
