// Headless check: boot all 18 Forever HUD addons (originals and "2" builds) and
// HelloForever in the studio engine, the same way the page loads them (.toc,
// dependencies, companions), run a few seconds, open the options window through
// the slash command, sweep clicks over it, and report Lua errors per addon.
//   node smoke.cjs                 every addon
//   node smoke.cjs Warrior         only names containing "Warrior"
//   node smoke.cjs --all           also try every other addon in the folder (informational, never fails the run)
// The 18 HUDs must report 0 errors; the exit code is 1 otherwise.
const { open, CLASSES } = require('./lib/headless.cjs');
const addons = require('./lib/addons.cjs');
const SLASH = { Rogue: 'fr', Druid: 'fd', Hunter: 'fh', Mage: 'fm', Paladin: 'fpa', Priest: 'fpr', Shaman: 'fs', Warlock: 'fwl', Warrior: 'fw' };
const args = process.argv.slice(2);
const filter = args.find(a => !a.startsWith('--'));
const everything = args.includes('--all');

const jobs = [];
for (const cls of CLASSES) for (const sfx of ['', '2']) jobs.push({ name: `Forever${cls}HUD${sfx}`, slash: '/' + SLASH[cls] + sfx, hud: true });
jobs.push({ name: 'HelloForever', slash: '/hf', hud: false });
if (everything) {
  const game = addons.readConfig().gameFolder;
  for (const a of addons.listAddons(game).addons) if (!jobs.some(j => j.name === a.name)) jobs.push({ name: a.name, slash: null, hud: false, extra: true });
}

let bad = 0, hudErrors = 0, ran = 0;
for (const job of jobs) {
  if (filter && !job.name.includes(filter)) continue;
  ran++;
  try {
    const h = open(job.name, { saved: 'fresh' });
    const lines = () => h.draw.split('\n').length;
    h.run(5); const base = lines();
    h.call('PV_cmd', 'showcase', ''); h.call('PV_cmd', 'target', 'enemy'); h.call('PV_cmd', 'combat', '1'); h.run(job.hud ? 150 : 20);
    const full = lines();
    let opened = 'none', withPanel = full;
    if (job.slash) {
      opened = h.slash(job.slash); h.run(10); withPanel = lines();
      if (job.hud) {
        // sweep clicks over the middle of the screen: tabs, buttons, checkboxes, sliders
        for (let x = 700; x < 1700; x += 37) for (let y = 120; y < 660; y += 29) { h.click(x, y); h.wheel(x, y, -1); }
        h.run(5);
      }
    }
    const loaded = h.eval(`tostring((C_AddOns.IsAddOnLoaded("${job.name}")))`);
    const errs = h.errors();
    if (job.hud) hudErrors += errs.length;
    if (!job.extra && (errs.length || loaded !== 'true' || (job.slash && opened !== true))) bad++;
    console.log(`${job.name}: loaded ${loaded}, with ${h.plan.order.filter(a => a.name !== job.name).map(a => a.name).join('+') || 'nothing else'}, items idle ${base}, showcase ${full}, panel ${withPanel} (slash ${opened}), skipped ${h.skipped.length}, errors ${errs.length}`);
    errs.slice(0, job.extra ? 3 : 8).forEach(e => console.log('   ' + e));
  } catch (e) { if (!job.extra) bad++; console.log(`${job.name}: FAILED ${e.message}`); }
}
console.log(`\n${ran} addon(s) run; Lua errors across the HUDs: ${hudErrors}; ${bad ? bad + ' FAILED' : 'all passed'}`);
process.exit(bad ? 1 : 0);
