// Headless check of the player / target / target-of-target frames in every "2" HUD:
// they are built, on screen, sized, show the unit's name and health, and a CTRL + left
// drag (with "Snap" and "Stick items together" ON, the defaults) leaves the frame where
// the cursor let go instead of pulling it to some other item.
//   node frames_check.cjs            exit code 1 if anything fails
const { open } = require('./lib/headless.cjs');
const MODS = { Rogue: ['FRH', 'fr'], Warrior: ['FRHW', 'fw'], Paladin: ['FRHPA', 'fpa'], Hunter: ['FRHH', 'fh'], Priest: ['FRHPR', 'fpr'],
  Shaman: ['FRHS', 'fs'], Mage: ['FRHM', 'fm'], Warlock: ['FRHWL', 'fwl'], Druid: ['FRHD', 'fd'] };
const only = process.argv[2];
let pass = 0, fail = 0;

for (const [cls, [pfx, slash]] of Object.entries(MODS)) {
  if (only && only !== cls) continue;
  const NAME = `Forever${cls}HUD2`, DB = `${NAME}_DB`, G = pfx + '2';
  const check = (label, ok, detail) => { if (ok) pass++; else { fail++; console.log(`FAIL  ${NAME}: ${label}${detail ? '   [' + detail + ']' : ''}`); } };
  let h;
  try { h = open(NAME, { saved: 'fresh', W: 3600 }); } catch (e) { fail++; console.log(`FAIL  ${NAME}: did not start: ${e.message}`); continue; }
  const num = c => h.num(c);
  const drag = (x0, y0, x1, y1) => {
    h.mouse('move', x0, y0, 0, true); h.run(1);
    h.mouse('down', x0, y0, 0, true); h.run(1);
    for (let i = 1; i <= 8; i++) { h.mouse('move', x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8, 0, true); h.run(1); }
    h.mouse('up', x1, y1, 0, true); h.run(1);
  };
  h.call('PV_cmd', 'target', 'enemy'); h.call('PV_cmd', 'combat', '1'); h.run(10);
  // switch the three frames on the way the Frames tab does, then apply
  h.eval(`(function() for _, k in ipairs({"player","target","targettarget"}) do ${DB}.frames[k].enabled = true end end)()`);
  check('options window opens', h.slash('/' + slash + '2') === true);
  h.run(10);
  // move the options window out of the way (it opens over the middle of the screen)
  const p0 = h.rect(`${NAME}Panel`);
  if (p0) {
    h.mouse('move', p0.x + 300, p0.y + 14); h.mouse('down', p0.x + 300, p0.y + 14); h.run(1);
    for (let i = 1; i <= 6; i++) { h.mouse('move', p0.x + 300 + 245 * i, p0.y + 14); h.run(1); }
    h.mouse('up', p0.x + 300 + 1470, p0.y + 14); h.run(2);
  }
  const text = f => h.eval(`(function() local out = {} local f = ${f} if not f then return "" end
      local function walk(w) for _, r in ipairs(w.__regions or {}) do if r.__kind == "FontString" and r.__shown and r.__text ~= "" then out[#out+1] = r.__text end end
        for _, c in ipairs(w.__children or {}) do if c.__shown then walk(c) end end end
      walk(f) return table.concat(out, " | ") end)()`);
  for (const key of ['player', 'target', 'targettarget']) {
    const f = `${G}UF_${key}`;
    const r = h.rect(f);
    check(`${key} frame exists and is shown`, !!r && h.eval(`${f} ~= nil and ${f}:IsVisible()`) === 'true');
    if (!r) continue;
    const cw = num(`${DB}.frames.${key}.w`), chh = num(`${DB}.frames.${key}.h`);
    check(`${key} frame has its configured size`, r.w >= cw - 1 && r.h >= chh - 1 && r.w < cw * 2.2 && r.h < chh * 4, `${r.w}x${r.h} for ${cw}x${chh}`);
    check(`${key} frame is on screen`, r.x >= 0 && r.y >= 0 && r.x + r.w <= h.W && r.y + r.h <= h.H, `${r.x},${r.y}`);
    const t = text(f);
    const unitName = h.eval(`UnitName("${key}")`);
    check(`${key} frame shows the unit name`, t.includes(unitName), t.slice(0, 120));
    check(`${key} frame shows health numbers`, /\d/.test(t.replace(unitName, '')), t.slice(0, 120));
    const drawn = h.draw.split('\n').filter(l => { const a = l.split('\t'); return (a[0] === 'R') && +a[1] >= r.x - 1 && +a[2] >= r.y - 1 && +a[1] + +a[3] <= r.x + r.w + 1 && +a[2] + +a[4] <= r.y + r.h + 1 && +a[3] > 20; }).length;
    check(`${key} frame draws its bars`, drawn >= 2, `${drawn} filled boxes`);
  }
  // nothing of one frame may sit on top of another at the default places
  const pr = h.rect(`${G}UF_player`), tr = h.rect(`${G}UF_target`), tt = h.rect(`${G}UF_targettarget`);
  const over = (a, b) => a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  check('default places do not overlap', !over(pr, tr) && !over(pr, tt) && !over(tr, tt));

  // drags with snap + sticky ON: the frame must end within one grid step of where it was let go
  check('snap and sticky are on for this test', h.eval(`${DB}.gridSnap and ${DB}.sticky`) === 'true');
  const grid = num(`${DB}.gridSize`);
  const targets = { player: [[-420, -150], [260, -210], [-700, 90]], target: [[430, -160], [-250, 180], [300, 60]], targettarget: [[60, -250], [-520, -250]] };
  for (const key of Object.keys(targets)) {
    const f = `${G}UF_${key}`;
    for (const [dx, dy] of targets[key]) {
      const r = h.rect(f);
      if (!r) break;
      // grab the frame near its left end, where nothing else is stacked on it
      const gx = r.x + 6, gy = r.y + r.h / 2;
      drag(gx, gy, gx + dx, gy + dy);
      const a = h.rect(f);
      const offX = a.cx - (r.cx + dx), offY = a.cy - (r.cy + dy);
      check(`${key} frame stays where it is dropped (${dx}, ${dy})`, Math.abs(offX) <= grid / 2 + 1 && Math.abs(offY) <= grid / 2 + 1,
        `landed ${offX.toFixed(0)}, ${offY.toFixed(0)} away from the cursor`);
      check(`${key} frame's saved place matches the screen`, Math.abs(num(`${DB}.frames.${key}.x`) - (a.cx - h.W / 2)) < 2 && Math.abs(num(`${DB}.frames.${key}.y`) + (a.cy - h.H / 2)) < 2,
        `saved ${num(`${DB}.frames.${key}.x`)}, ${num(`${DB}.frames.${key}.y`)} drawn ${(a.cx - h.W / 2).toFixed(0)}, ${(-(a.cy - h.H / 2)).toFixed(0)}`);
    }
  }
  // HUD items: a bar and an icon dropped far from everything must not be pulled anywhere
  const items = h.eval(`(function() local t = {} for _, n in ipairs({"${NAME}_Energy", "${NAME}_Swing"}) do if _G[n] and _G[n]:IsVisible() then t[#t+1] = n end end
      for k in pairs(${DB}.spells) do local n = "${NAME}_Spell_" .. k if _G[n] and _G[n]:IsVisible() then t[#t+1] = n break end end return table.concat(t, ",") end)()`).split(',').filter(Boolean);
  let slot = 0;
  for (const it of items) {
    const r = h.rect(it);
    if (!r) continue;
    const tx = 300 + slot * 260, ty = 120;       // an empty strip near the top left
    slot++;
    drag(r.cx, r.cy, tx, ty);
    const a = h.rect(it);
    check(`${it.replace(NAME + '_', '')} stays where it is dropped, far from other items`, Math.abs(a.cx - tx) <= grid / 2 + 1 && Math.abs(a.cy - ty) <= grid / 2 + 1,
      `landed ${(a.cx - tx).toFixed(0)}, ${(a.cy - ty).toFixed(0)} away`);
  }
  // CTRL + wheel sizes a frame
  { const r = h.rect(`${G}UF_player`); const s0 = num(`${DB}.frames.player.scale`);
    h.mouse('move', r.x + 6, r.cy, 0, true); h.wheel(r.x + 6, r.cy, 1, true); h.run(1);
    check('CTRL + wheel sizes the player frame', Math.abs(num(`${DB}.frames.player.scale`) - (s0 + 0.05)) < 1e-6); }
  // target lost: the target frames go away once the menu is closed
  h.call('PV_key', 'Escape', ''); h.run(3);
  h.call('PV_cmd', 'target', 'none'); h.run(5);
  check('target frame hides without a target (menu closed)', h.eval(`${G}UF_target:IsVisible()`) !== 'true');
  check('player frame stays', h.eval(`${G}UF_player:IsVisible()`) === 'true');
  const errs = h.errors();
  check('no Lua errors', errs.length === 0, errs.slice(0, 3).join(' || '));
  console.log(`${NAME}: checked`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
