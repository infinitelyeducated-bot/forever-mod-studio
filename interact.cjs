// Headless interaction check: drives ForeverWarriorHUD2 through the engine's
// input entry points exactly as the page does (PV_mouse / PV_wheel / PV_key),
// with the options window open, and reads the results out of the addon's own
// SavedVariables table.
//   node interact.cjs              prints PASS / FAIL per step; exit code 1 if any fail
const { open } = require('./lib/headless.cjs');

const NAME = 'ForeverWarriorHUD2', DB = 'ForeverWarriorHUD2_DB';
const h = open(NAME, { saved: 'fresh' });
let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '   [' + detail + ']' : ''}`);
}
const num = code => h.num(code);
// a slow drag: move in steps with a frame in between, as a hand would
function drag(x0, y0, x1, y1, button, ctrl) {
  h.mouse('move', x0, y0, 0, ctrl); h.run(1);
  h.mouse('down', x0, y0, button, ctrl); h.run(1);
  // a drag only starts once the cursor has left the spot by a few pixels: begin with a small nudge
  h.mouse('move', x0 + Math.sign(x1 - x0) * 5, y0 + Math.sign(y1 - y0) * 5, 0, ctrl); h.run(1);
  for (let i = 1; i <= 8; i++) { h.mouse('move', x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8, 0, ctrl); h.run(1); }
  h.mouse('up', x1, y1, button, ctrl); h.run(1);
}

h.call('PV_cmd', 'target', 'enemy'); h.call('PV_cmd', 'combat', '1');
h.run(10);
check('options window opens with /fw2', h.slash('/fw2') === true && (h.run(5), h.eval('ForeverWarriorHUD2Panel:IsShown()')) === 'true');

// the window opens over the middle of the screen, where the HUD is: drag it aside by its header
const p0 = h.rect('ForeverWarriorHUD2Panel');
drag(p0.x + 300, p0.y + 40, p0.x + 300 - 780, p0.y + 40, 0, false);
const p1 = h.rect('ForeverWarriorHUD2Panel');
check('left drag on the header moves the options window', Math.abs((p0.x - p1.x) - 780) < 12, `x ${p0.x} -> ${p1.x}`);

// ---- CTRL + left hold: move the resource bar
{
  const r = h.rect('ForeverWarriorHUD2_Energy');
  const bx = num(`${DB}.elements.energy.x`), by = num(`${DB}.elements.energy.y`);
  // without CTRL nothing moves
  drag(r.cx, r.cy, r.cx + 90, r.cy + 60, 0, false);
  check('left drag WITHOUT CTRL leaves the bar alone', num(`${DB}.elements.energy.x`) === bx && num(`${DB}.elements.energy.y`) === by);
  drag(r.cx, r.cy, r.cx + 90, r.cy + 60, 0, true);
  let ax = num(`${DB}.elements.energy.x`), ay = num(`${DB}.elements.energy.y`);
  // with the addon's defaults the drop may stick to a neighbour's edge, so only "it changed" is checked here
  check('CTRL + left drag changes db.elements.energy.x / y', ax !== bx && ay !== by, `x ${bx} -> ${ax}, y ${by} -> ${ay}`);
  // with sticky edges and the grid switched off (the addon's own options) the drop is exactly where the cursor went:
  // screen y grows downwards, the addon's y grows upwards
  h.eval(`(function() ${DB}.sticky = false ${DB}.gridSnap = false end)()`);
  const rr = h.rect('ForeverWarriorHUD2_Energy');
  drag(rr.cx, rr.cy, rr.cx - 40, rr.cy - 25, 0, true);
  const cx = num(`${DB}.elements.energy.x`), cy = num(`${DB}.elements.energy.y`);
  check('the bar follows the cursor exactly (sticky and grid off)', Math.abs((cx - ax) + 40) <= 1 && Math.abs((cy - ay) - 25) <= 1, `x ${ax} -> ${cx}, y ${ay} -> ${cy}`);
  ax = cx; ay = cy;
  const r2 = h.rect('ForeverWarriorHUD2_Energy');
  check('the bar is drawn where it was dropped', Math.abs((r2.cx - r.cx) - (ax - bx)) < 2 && Math.abs((r2.cy - r.cy) + (ay - by)) < 2, `centre ${r.cx.toFixed(0)},${r.cy.toFixed(0)} -> ${r2.cx.toFixed(0)},${r2.cy.toFixed(0)}`);

  // ---- CTRL + wheel: scale
  const s0 = num(`${DB}.elements.energy.scale or 1`);
  h.mouse('move', r2.cx, r2.cy, 0, false); h.wheel(r2.cx, r2.cy, 1, false); h.run(1);
  check('wheel WITHOUT CTRL leaves the scale alone', num(`${DB}.elements.energy.scale or 1`) === s0);
  h.wheel(r2.cx, r2.cy, 1, true); h.wheel(r2.cx, r2.cy, 1, true); h.run(1);
  const s1 = num(`${DB}.elements.energy.scale or 1`);
  check('CTRL + wheel up changes the scale', Math.abs(s1 - (s0 + 0.10)) < 1e-6, `${s0} -> ${s1}`);
  h.wheel(h.rect('ForeverWarriorHUD2_Energy').cx, h.rect('ForeverWarriorHUD2_Energy').cy, -1, true); h.run(1);
  const s2 = num(`${DB}.elements.energy.scale or 1`);
  check('CTRL + wheel down brings it back a step', Math.abs(s2 - (s0 + 0.05)) < 1e-6, `${s1} -> ${s2}`);
}

// ---- an ability icon: CTRL + right hold and drag turns it, right double-click resets
{
  const key = h.eval(`(function() local best, bx for k in pairs(${DB}.spells) do local f = _G["ForeverWarriorHUD2_Spell_" .. k]
    if f and f:IsVisible() then local r = PV.Rect(f) if r and (not bx or r.x > bx) then best, bx = k, r.x end end end return best end)()`);
  const icon = 'ForeverWarriorHUD2_Spell_' + key;
  const r = h.rect(icon);
  check('an ability icon is on screen', !!r && key !== 'nil', `${icon}`);
  const rot = () => num(`${DB}.spells["${key}"].rot or 0`);
  const r0 = rot();
  // start to the right of the centre, sweep a quarter turn anticlockwise (up on screen)
  const R = Math.max(4, r.w * 0.35);
  h.mouse('move', r.cx + R, r.cy, 0, true); h.run(1);
  h.mouse('down', r.cx + R, r.cy, 2, true); h.run(1);
  check('IsMouseButtonDown("RightButton") while the right button is held', h.eval('tostring(IsMouseButtonDown("RightButton")) .. tostring(IsMouseButtonDown("LeftButton"))') === 'truefalse');
  for (let i = 1; i <= 9; i++) { const a = (Math.PI / 2) * i / 9; h.mouse('move', r.cx + Math.cos(a) * R, r.cy - Math.sin(a) * R, 0, true); h.run(1); }
  const mid = rot();
  h.mouse('up', r.cx, r.cy - R, 2, true); h.run(1);
  const r1 = rot();
  check('CTRL + right drag changes the icon\'s rot', r1 !== r0 && Math.abs(r1 - 90) <= 4, `${r0} -> ${r1} (while held: ${mid})`);
  const turned = h.draw.split('\n').filter(l => l.startsWith('X\t'));
  check('SetRotation reaches the draw list (texture really turned)', turned.some(l => Math.abs(Number(l.split('\t')[3]) + r1 * Math.PI / 180) < 0.01), `${turned.length} turned texture(s)`);
  // free angle too, not only the quarter stops
  h.mouse('move', r.cx, r.cy - R, 0, true); h.mouse('down', r.cx, r.cy - R, 2, true); h.run(1);
  { const a = Math.PI / 2 + Math.PI / 6; h.mouse('move', r.cx + Math.cos(a) * R, r.cy - Math.sin(a) * R, 0, true); h.run(2); }
  h.mouse('up', r.cx + Math.cos(Math.PI * 2 / 3) * R, r.cy - Math.sin(Math.PI * 2 / 3) * R, 2, true); h.run(1);
  const r2 = rot();
  check('icons turn to any angle', Math.abs(r2 - 120) <= 3, `rot ${r2}`);
  // right double-click (no CTRL): back to 0. A frame of 0.1 s passes between the clicks.
  h.run(8);
  h.click(r.cx, r.cy, 2, false); h.run(1);
  check('one right click alone does not reset', rot() === r2);
  h.click(r.cx, r.cy, 2, false); h.run(1);
  check('right double-click sets rot back to 0', rot() === 0, `rot ${rot()}`);

  // an ability on cooldown: dark, grey, with a countdown in its bottom-right corner
  h.eval(`(function() local f = _G["${icon}"] PV.sim.cds[f.spellId] = { start = PV.now, duration = 30 } PV.Fire("SPELL_UPDATE_COOLDOWN") end)()`);
  h.call('PV_cmd', 'auto', '0'); h.run(5);
  const ir = h.rect(icon);
  const inIcon = l => { const f = l.split('\t'); return +f[1] >= ir.x - 1 && +f[2] >= ir.y - 1 && +f[1] + +f[3] <= ir.x + ir.w + 1 && +f[2] + +f[4] <= ir.y + ir.h + 1; };
  const list = h.draw.split('\n');
  const pic = list.find(l => l.startsWith('I\t') && inIcon(l));
  const pf = pic ? pic.split('\t') : [];
  check('icon on cooldown is drawn dark and desaturated', !!pic && pf[8] === '1' && Math.abs(+pf[9] - 0.35) < 0.01, pic ? `desat ${pf[8]}, colour ${pf[9]} ${pf[10]} ${pf[11]}` : 'no icon line');
  check('cooldown sweep is drawn', list.some(l => l.startsWith('C\t') && inIcon(l)));
  const timer = list.find(l => { const f = l.split('\t'); return f[0] === 'T' && /^\d/.test(f.slice(16).join('')) && Math.abs((+f[1] + +f[3]) - (ir.x + ir.w)) < 4 && Math.abs((+f[2] + +f[4]) - (ir.y + ir.h)) < 4; });
  check('countdown number sits in the bottom-right corner of the icon', !!timer, timer ? `"${timer.split('\t').slice(16).join('')}"` : 'none found');
  const order = h.eval(`(function() local f = _G["${icon}"] local a, b for i, it in ipairs(PV.order) do if it.f == f.cd then a = i end if it.f == f.over then b = i end end return tostring(a and b and b > a) .. " " .. f.over:GetFrameStrata() end)()`);
  check('the HIGH strata holder of the number is drawn above the MEDIUM cooldown', order === 'true HIGH', order);
}

// ---- Skins tab: a colour chip opens the wheel, picking changes db.custom.bar
{
  const tab = h.rect('FRHW2TabSkins');
  h.click(tab.cx, tab.cy); h.run(2);
  const chip = h.rect('FRHW2Chip_bar');
  check('Skins tab shows the colour chips', !!chip && h.eval('FRHW2Chip_bar:IsVisible()') === 'true');
  const before = h.eval(`(function() local c = ${DB}.custom and ${DB}.custom.bar return c and string.format("%.2f %.2f %.2f", c[1], c[2], c[3]) or "none" end)()`);
  h.click(chip.cx, chip.cy); h.run(2);
  check('clicking FRHW2Chip_bar opens the colour wheel (a real ColorSelect)',
    h.eval('ForeverWarriorHUD2Wheel:IsVisible()') === 'true' && h.eval('ForeverWarriorHUD2WheelCS:GetObjectType()') === 'ColorSelect');
  const list = h.draw.split('\n');
  check('the wheel and the brightness bar are in the draw list', list.some(l => l.startsWith('W\t')) && list.some(l => l.startsWith('G\t')));
  check('the wheel window is DIALOG strata, above the options window',
    h.eval(`(function() local a, b for i, it in ipairs(PV.order) do if it.f == ForeverWarriorHUD2Panel then a = i end if it.f == ForeverWarriorHUD2Wheel then b = i end end return tostring(b > a) .. " " .. ForeverWarriorHUD2Wheel:GetFrameStrata() end)()`) === 'true DIALOG');
  const w = h.rect('ForeverWarriorHUD2WheelCS:GetColorWheelTexture()');
  const v = h.rect('ForeverWarriorHUD2WheelCS:GetColorValueTexture()');
  // pick on the wheel: straight left of the centre at 80% of the radius = hue 180 (cyan), saturation 0.8
  h.click(w.cx - w.w / 2 * 0.8, w.cy); h.run(2);
  const picked = h.eval(`(function() local c = ${DB}.custom and ${DB}.custom.bar return c and string.format("%.2f %.2f %.2f", c[1], c[2], c[3]) or "none" end)()`);
  const [pr, pg, pb] = picked.split(' ').map(Number);
  check('picking on the wheel changes db.custom.bar', picked !== before && picked !== 'none' && Math.abs(pg - pb) < 0.02 && Math.abs(pr - 0.2 * pg) < 0.03, `${before} -> ${picked}`);
  check('db.customOn is switched on by the pick', h.eval(`tostring(${DB}.customOn)`) === 'true');
  // drag down the brightness bar to the middle
  drag(v.cx, v.y + 2, v.cx, v.y + v.h / 2, 0, false);
  const dim = h.eval(`(function() local c = ${DB}.custom.bar return string.format("%.2f %.2f %.2f", c[1], c[2], c[3]) end)()`).split(' ').map(Number);
  check('dragging on the brightness bar darkens the colour', Math.abs(dim[1] - 0.5) < 0.03 && Math.abs(dim[0] - 0.1) < 0.03, `${picked} -> ${dim.join(' ')}`);
  const rgb = h.eval('string.format("%.2f %.2f %.2f", ForeverWarriorHUD2WheelCS:GetColorRGB())');
  check('GetColorRGB agrees with what was saved', rgb === dim.map(n => n.toFixed(2)).join(' '), rgb);

  // ---- an edit box takes typing (the colour-scheme name box on this tab)
  const done = h.rect('ForeverWarriorHUD2WheelOK');
  h.click(done.cx, done.cy); h.run(2);
  check('Done closes the wheel', h.eval('ForeverWarriorHUD2Wheel:IsVisible()') === 'false');
  const box = h.rect('FRHW2SchemeBox');
  h.click(box.cx, box.cy); h.run(1);
  h.call('PV_key', 'Delete', '');
  for (const ch of 'Dusk 2x') h.call('PV_key', ch, ch);
  h.call('PV_key', 'Backspace', '');
  check('typing into an EditBox', h.eval('FRHW2SchemeBox:GetText()') === 'Dusk 2' && h.eval('tostring(FRHW2SchemeBox:HasFocus())') === 'true', `"${h.eval('FRHW2SchemeBox:GetText()')}"`);
}

// ---- GetCursorPosition is in screen pixels from the bottom left
h.mouse('move', 300, 200, 0, false);
check('GetCursorPosition is screen pixels, bottom-left origin', h.eval('string.format("%d %d", GetCursorPosition())') === `300 ${h.H - 200}`, h.eval('string.format("%d %d", GetCursorPosition())'));

// ---- the adjustments serialise to Lua source that loads back to the same values
{
  const text = h.serialize();
  const back = h.eval(`(function() local env = {} local fn, err = load(${JSON.stringify(text)}, "=state", "t", env) if not fn then return err end fn()
    local a, b = env.${DB}, ${DB} return tostring(a.elements.energy.x == b.elements.energy.x and a.elements.energy.scale == b.elements.energy.scale and a.custom.bar[2] == b.custom.bar[2]) end)()`);
  check('SavedVariables serialise to Lua source and load back equal', back === 'true', `${text.length} characters, ${back}`);
}

const errs = h.errors();
check('no Lua errors during the whole run', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
