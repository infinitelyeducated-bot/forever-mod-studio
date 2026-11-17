// Checks the two changes of this pass in the studio engine:
//  1. the Slice and Dice icon shows the player's buff (sweep = time left), and clears without it
//  2. the bar and icon Scale sliders in the menu change the drawn size
const { open } = require('./lib/headless.cjs');
let pass = 0, fail = 0;
const check = (label, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${d ? '   [' + d + ']' : ''}`); };
const h = open('ForeverRogueHUD2', { saved: 'fresh' });
h.call('PV_cmd', 'target', 'enemy'); h.call('PV_cmd', 'combat', '1');
h.run(10);
const DB = 'ForeverRogueHUD2_DB';
h.eval(`${DB}.spells.snd.enabled = true`);
h.run(3);
// the icon's sweep as the engine stores it: "start/duration", or "clear"
const sweep = () => h.eval('(function() local f = _G["ForeverRogueHUD2_Spell_snd"] if not f or not f.cd then return "none" end if not f.cd.__cd then return "clear" end return string.format("%.2f/%.2f", f.cd.__cd[1], f.cd.__cd[2]) end)()');

// no buff: the sweep is clear
check('no Slice and Dice buff: sweep clear', sweep() === 'clear', sweep());

// fake a 20 s buff with spellId 5171 that has 12 s left, then send the event the addon listens to
h.eval(`(function() local real = C_UnitAuras.GetAuraDataByIndex
  FIRE_T = GetTime()
  C_UnitAuras.GetAuraDataByIndex = function(u, i, f) if u == "player" and i == 1 then return { spellId = 5171, expirationTime = FIRE_T + 12, duration = 20 } end return real(u, i, f) end
  PV.Fire("UNIT_AURA", "player") return "ok" end)()`);
h.run(2);
const now = Number(h.eval("return tostring(FIRE_T)"));
const [start, dur] = sweep().split('/').map(Number);
check('buff on: sweep set to the buff (20 s long)', Math.abs(dur - 20) < 0.01, sweep());
check('buff on: sweep starts 8 s before now (time left = 12 s)', Math.abs((start + dur) - (now + 12)) < 0.1, `end ${(start + dur).toFixed(2)} vs ${(now + 12).toFixed(2)}`);

// buff gone: the sweep clears again
h.eval(`(function() C_UnitAuras.GetAuraDataByIndex = function(u, i, f) return nil end PV.Fire("UNIT_AURA", "player") return "ok" end)()`);
h.run(2);
check('buff gone: sweep clear again', sweep() === 'clear', sweep());

// Scale sliders: bar and icon
const energy = h.rect('ForeverRogueHUD2_Energy');
h.eval('FRH2S_energy:SetValue(2)');
h.run(2);
const energy2 = h.rect('ForeverRogueHUD2_Energy');
check('bar Scale slider 2.0 makes the energy bar bigger', energy2 && energy && energy2.w > energy.w * 1.5, energy && energy2 ? `${energy.w} -> ${energy2.w}` : 'no rect');
const ic = h.rect('ForeverRogueHUD2_Spell_snd');
h.eval('FRH2CFGS_snd:SetValue(2)');
h.run(2);
const ic2 = h.rect('ForeverRogueHUD2_Spell_snd');
check('icon Scale slider 2.0 makes the Slice and Dice icon bigger', ic && ic2 && ic2.w > ic.w * 1.5, ic && ic2 ? `${ic.w} -> ${ic2.w}` : 'no rect');
check('no Lua errors', h.errors().length === 0, h.errors()[0]);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
