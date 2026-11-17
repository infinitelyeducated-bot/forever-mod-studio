// Forever Mod Studio: the desktop shell. Starts the loopback server inside this
// process on a free port and opens a window on it. The page is the same one
// `node server.cjs` serves to a browser; Electron only adds the window and the
// real folder dialog for the "game folder" setting.
//
//   electron .                       one window (the picker chooses the addon)
//   electron . --each=huds2          one window per "2" HUD, tiled over the screen
//   electron . --each=huds           one window per HUD (all 18)
//   electron . --each=AddonA,AddonB  one window per named addon
//   --start=showcase|fresh|game|state|auto   what each of those windows starts from (default showcase)
const { app, BrowserWindow, dialog, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { start } = require('./server.cjs');
const addons = require('./lib/addons.cjs');

const CLASSES = ['Rogue', 'Warrior', 'Paladin', 'Hunter', 'Priest', 'Shaman', 'Mage', 'Warlock', 'Druid'];
const arg = name => {
  const a = process.argv.find(x => x.startsWith('--' + name + '='));
  return a ? a.slice(name.length + 3) : (process.env['FMS_' + name.toUpperCase()] || '');
};

function eachList() {
  const want = arg('each').trim();
  if (!want) return [];
  let names;
  if (want === 'huds2') names = CLASSES.map(c => `Forever${c}HUD2`);
  else if (want === 'huds') names = CLASSES.flatMap(c => [`Forever${c}HUD`, `Forever${c}HUD2`]);
  else names = want.split(',').map(s => s.trim()).filter(Boolean);
  // only addons that are really in the game folder
  let dir = '';
  try { dir = addons.addonsDir(process.env.WOW_FOREVER || addons.readConfig().gameFolder); } catch (e) { /* use the names as given */ }
  return names.filter(n => /^[\w!.-]+$/.test(n) && (!dir || fs.existsSync(path.join(dir, n))));
}

// rows x columns that keep each window closest to a normal screen shape
function grid(n, area) {
  let best = { cols: 1, rows: n, score: Infinity };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const shape = (area.width / cols) / (area.height / rows);
    const score = Math.abs(Math.log(shape / 1.9)) + (cols * rows - n) * 0.05;
    if (score < best.score) best = { cols, rows, score };
  }
  return best;
}

async function pickFolder(current) {
  const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0], {
    title: 'Choose the game folder (the one that contains Interface and WTF)',
    defaultPath: current, properties: ['openDirectory'],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
}

function openWindow(s, bounds, query, title, shotName) {
  const win = new BrowserWindow({
    ...(bounds || { width: 1600, height: 950 }), minWidth: 640, minHeight: 420, backgroundColor: '#111317',
    title: title || 'Forever Mod Studio', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (!bounds) win.maximize();
  // keep the addon's name in the title bar so the windows can be told apart
  if (title) win.on('page-title-updated', e => { e.preventDefault(); win.setTitle(title); });
  // nothing but the studio's own loopback page is ever shown in this window
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url) && !url.startsWith(s.url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(s.url)) e.preventDefault(); });
  // optional: FMS_SHOT=<png path> saves a picture of the window a few seconds after it loads (used for checking)
  if (process.env.FMS_SHOT) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      // FMS_SHOT_RECT=x,y,w,h (page pixels) saves only that part, at full device resolution
      const q = (process.env.FMS_SHOT_RECT || '').split(',').map(Number);
      const img = await win.webContents.capturePage(q.length === 4 ? { x: q[0], y: q[1], width: q[2], height: q[3] } : undefined);
      const file = path.resolve(process.env.FMS_SHOT);
      fs.writeFileSync(shotName ? file.replace(/\.png$/i, '') + '-' + shotName + '.png' : file, img.toPNG());
      openWindow.shots = (openWindow.shots || 0) + 1;
      if (process.env.FMS_SHOT_QUIT && openWindow.shots >= BrowserWindow.getAllWindows().length) app.quit();
    }, Number(process.env.FMS_SHOT_DELAY) || 6000));
  }
  win.loadURL(s.url + (query ? '?' + query : ''));
  return win;
}

app.whenReady().then(async () => {
  const s = await start(0, { pickFolder, shell: 'electron' });
  const list = eachList();
  if (!list.length) {
    openWindow(s, null, process.env.FMS_QUERY || '');
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const g = grid(list.length, area);
  const w = Math.floor(area.width / g.cols), h = Math.floor(area.height / g.rows);
  const startFrom = arg('start') || 'showcase';
  list.forEach((name, i) => {
    const bounds = { x: area.x + (i % g.cols) * w, y: area.y + Math.floor(i / g.cols) * h, width: w, height: h };
    const label = name.replace(/^Forever(\w+?)HUD(2?)$/, '$1 HUD $2').trim();
    // staggered so nine Lua engines do not all start in the same instant
    setTimeout(() => openWindow(s, bounds, `addon=${encodeURIComponent(name)}&start=${encodeURIComponent(startFrom)}&zoom=hud&compact=1`, `${label} - Forever Mod Studio`, name), i * 350);
  });
});

app.on('window-all-closed', () => app.quit());
