// Headless check, all 18 HUDs:
//   * a tracked ability is invisible while ready, drawn with a countdown while on cooldown,
//     flashes when it comes back and has faded out within a second;
//   * with the options window open every enabled icon is drawn in full (so it can be placed);
//   * each HUD runs on its own class and stays off on any other.
//   node cd_check.cjs            exit code 1 if anything fails
const { open } = require('./lib/headless.cjs');
const CLASSES = ['Rogue', 'Warrior', 'Paladin', 'Hunter', 'Priest', 'Shaman', 'Mage', 'Warlock', 'Druid'];
const SLASH = { Rogue: 'fr', Warrior: 'fw', Paladin: 'fpa', Hunter: 'fh', Priest: 'fpr', Shaman: 'fs', Mage: 'fm', Warlock: 'fwl', Druid: 'fd' };
let pass = 0, fail = 0;

for (const cls of CLASSES) for (const two of ['', '2']) {
  const NAME = `Forever${cls}HUD${two}`, DB = `${NAME}_DB`;
  const check = (label, ok, detail) => { if (ok) pass++; else { fail++; console.log(`FAIL  ${NAME}: ${label}${detail !== undefined ? '   [' + detail + ']' : ''}`); } };
  let h;
  try { h = open(NAME, { saved: 'fresh' }); } catch (e) { fail++; console.log(`FAIL  ${NAME}: did not start: ${e.message}`); continue; }
  const num = c => h.num(c);
  h.call('PV_cmd', 'auto', '0'); h.call('PV_cmd', 'target', 'enemy'); h.call('PV_cmd', 'combat', '1');
  // every tracked ability on, HUD always shown
  h.eval(`(function() ${DB}.autoHideOOC = false for _, s in pairs(${DB}.spells) do s.enabled = true end end)()`);
  h.slash('/' + SLASH[cls] + two + ' apply'); h.slash('/' + SLASH[cls] + two); h.run(3); h.call('PV_key', 'Escape', ''); h.run(5);
  check('options window is closed for the test', h.eval(`${NAME}Panel:IsShown()`) !== 'true');
  const key = h.eval(`(function() local ks = {} for k in pairs(${DB}.spells) do if _G["${NAME}_Spell_" .. k] and _G["${NAME}_Spell_" .. k]:IsShown() then ks[#ks+1] = k end end table.sort(ks) return ks[1] end)()`);
  const B = `_G["${NAME}_Spell_${key}"]`;
  check('a tracked ability icon exists', key && key !== 'nil', key);
  if (!key || key === 'nil') continue;
  const shownCount = num(`(function() local n = 0 for k in pairs(${DB}.spells) do local b = _G["${NAME}_Spell_" .. k] if b and b:IsShown() and b:GetAlpha() > 0.01 then n = n + 1 end end return n end)()`);
  check('no ability is drawn while all are ready', shownCount === 0, shownCount + ' visible');
  // put it on a 6 second cooldown
  h.eval(`(function() PV.sim.cds[${B}.spellId] = { start = GetTime(), duration = 6 } PV.Fire("SPELL_UPDATE_COOLDOWN") end)()`);
  h.run(3);
  check('on cooldown: the icon is drawn', num(`${B}:GetAlpha()`) > 0.9, h.eval(`${B}:GetAlpha()`));
  const t1 = h.eval(`${B}.timer:GetText()`);
  check('on cooldown: it shows a countdown', /^\d+\.\d\d$/.test(t1), t1);
  h.run(10);
  const t2 = h.eval(`${B}.timer:GetText()`);
  check('the countdown runs down', parseFloat(t2) < parseFloat(t1) - 0.5, `${t1} -> ${t2}`);
  const others = num(`(function() local n = 0 for k in pairs(${DB}.spells) do local b = _G["${NAME}_Spell_" .. k] if b and b ~= ${B} and b:IsShown() and b:GetAlpha() > 0.01 then n = n + 1 end end return n end)()`);
  check('only the ability on cooldown is drawn', others === 0, others + ' others visible');
  // run to just past the end of the cooldown, in small steps
  h.run(46, 0.1);                                   // 5.9 s gone
  let sawFlash = false, sawFull = false, alphas = [];
  for (let i = 0; i < 60; i++) {
    h.run(1, 0.02);
    const a = num(`${B}:GetAlpha()`);
    alphas.push(a);
    if (h.eval(`${B}.ready:IsShown()`) === 'true') { sawFlash = true; if (a > 0.9) sawFull = true; }
  }
  check('ready: it flashes', sawFlash && sawFull);
  const mid = alphas.filter(a => a > 0.05 && a < 0.95).length;
  check('after the flash it fades (not a hard cut)', mid >= 3, mid + ' in-between frames');
  check('and is gone within 1.2 s', alphas[alphas.length - 1] === 0, alphas[alphas.length - 1]);
  check('no countdown is left on it', h.eval(`${B}.timer:GetText()`) === '');
  // options window open: everything is drawn so it can be placed
  h.slash('/' + SLASH[cls] + two); h.run(3);
  check('options window open: the icons are drawn in full', num(`${B}:GetAlpha()`) > 0.9);
  h.call('PV_key', 'Escape', ''); h.run(3);
  check('options window closed again: hidden again', num(`${B}:GetAlpha()`) === 0);
  // the option switched off: icons are always drawn, as before
  h.eval(`(function() ${DB}.notify.cdOnly = false end)()`); h.run(3);
  check('"only while on cooldown" off: the icon is always drawn', num(`${B}:GetAlpha()`) > 0.9);
  check('no Lua errors', h.errors().length === 0, h.errors().slice(0, 2).join(' || '));

  // class gate: the same HUD on another class stays off
  const other = cls === 'Mage' ? 'ROGUE' : 'MAGE';
  const w = open(NAME, { saved: 'fresh', cls: other });
  w.call('PV_cmd', 'combat', '1'); w.run(10);
  check(`on a ${other.toLowerCase()} it creates no settings`, w.eval(`type(${DB})`) === 'nil', w.eval(`type(${DB})`));
  const vis = w.num(`(function() local n = 0 for name, f in pairs(_G) do if type(name) == "string" and name:find("^${NAME}_") and type(f) == "table" and rawget(f, "__kind") and f:IsVisible() then n = n + 1 end end return n end)()`);
  check(`on a ${other.toLowerCase()} nothing is on screen`, vis === 0, vis + ' frames visible');
  w.slash('/' + SLASH[cls] + two); w.run(3);
  check(`on a ${other.toLowerCase()} the options window does not open`, w.eval(`${NAME}Panel:IsShown()`) !== 'true');
  check(`on a ${other.toLowerCase()} there are no Lua errors`, w.errors().length === 0, w.errors().slice(0, 2).join(' || '));
  check('on its own class it is running', h.eval(`type(${DB})`) === 'table');
  console.log(`${NAME}: checked`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
