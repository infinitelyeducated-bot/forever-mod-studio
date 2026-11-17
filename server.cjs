// Forever Mod Studio: local file server, 127.0.0.1 ONLY.
//   node server.cjs [port]            (standalone; main.cjs starts it in-process for the Electron window)
//
// Reads (never writes) the game folder:
//   GET  /api/addons                  every AddOns folder that has a .toc
//   GET  /api/plan?addon=X&also=A,B   load order: dependencies, companions, then X, with each file list
//   GET  /addons/<AddOn>/<file>       .lua .toc .xml fonts and pictures (.tga .png .jpg) from the AddOns folder
//   GET  /saved/<AddOn>.lua           the game's SavedVariables for that addon (import only)
// Reads and writes the studio's own folder:
//   GET  /state/<AddOn>.lua           the studio's last saved state
//   POST /state/<AddOn>.lua           save it            (state\<AddOn>.lua)
//   POST /export/<AddOn>.lua          write exports\<AddOn>.lua with a note on where it goes in the game
//   GET  /api/config   POST /api/config {gameFolder}   POST /api/pick-folder (Electron folder dialog)
const http = require('http'), fs = require('fs'), path = require('path');
const addons = require('./lib/addons.cjs');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.lua': 'text/plain; charset=utf-8',
  '.toc': 'text/plain; charset=utf-8', '.xml': 'text/plain; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.tga': 'application/octet-stream', '.ttf': 'font/ttf', '.otf': 'font/otf', '.json': 'application/json', '.css': 'text/css' };
// the only files of the project folder the page may fetch
const PAGE_FILES = new Set(['index.html', 'studio.js', 'client.lua', 'fengari-web.js', 'bg.jpg']);
const ADDON_FILE = /\.(lua|toc|xml|ttf|otf|tga|png|jpg|jpeg)$/i;

function inside(root, rel) {
  const full = path.resolve(root, '.' + path.sep + rel);
  return full.startsWith(path.resolve(root) + path.sep) ? full : null;
}
function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}
function json(res, obj, code) {
  res.writeHead(code || 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function body(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// opts.pickFolder: async () => path | null   (the Electron shell supplies a real folder dialog)
function start(port, opts = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      // Only this machine's own page may talk to the server: the Host must be the
      // loopback address, and a write must come from the studio page itself.
      const host = String(req.headers.host || '');
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { res.writeHead(403); res.end(); return; }
      const url = new URL(req.url, 'http://127.0.0.1');
      let p;
      try { p = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); res.end(); return; }
      const config = addons.readConfig();
      const game = config.gameFolder;

      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && origin !== 'http://' + host) { res.writeHead(403); res.end(); return; }
        if (p === '/api/pick-folder') {
          if (!opts.pickFolder) { json(res, { available: false }); return; }
          const picked = await opts.pickFolder(game);
          json(res, { available: true, folder: picked || null });
          return;
        }
        if (p === '/api/config') {
          let want;
          try { want = JSON.parse(await body(req, 1e5)); } catch (e) { json(res, { error: 'bad request' }, 400); return; }
          const folder = String(want.gameFolder || '').trim();
          if (!folder || !fs.existsSync(addons.addonsDir(folder))) {
            json(res, { error: `No Interface\\AddOns folder inside "${folder}". Pick the game folder that contains Interface and WTF (for example ..._forever_).` }, 400);
            return;
          }
          config.gameFolder = folder;
          addons.writeConfig(config);
          json(res, { gameFolder: folder });
          return;
        }
        const m = /^\/(state|export)\/([^/]+)\.lua$/.exec(p);
        if (m && addons.safeName(m[2])) {
          const text = await body(req, 64e6);
          if (m[1] === 'state') json(res, { file: addons.writeState(m[2], text) });
          else json(res, addons.writeExport(game, m[2], text));
          return;
        }
        res.writeHead(404); res.end();
        return;
      }
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

      if (p === '/') p = '/index.html';
      if (p === '/api/config') {
        json(res, { gameFolder: game, addonsFolder: addons.addonsDir(game), found: fs.existsSync(addons.addonsDir(game)),
          stateFolder: addons.STATE, exportsFolder: addons.EXPORTS, canPickFolder: !!opts.pickFolder, shell: opts.shell || 'browser' });
        return;
      }
      if (p === '/api/addons') {
        const out = addons.listAddons(game);
        for (const a of out.addons) a.companions = addons.companionsFor(config, a.name);
        json(res, out);
        return;
      }
      if (p === '/api/plan') {
        const name = url.searchParams.get('addon') || '';
        const also = (url.searchParams.get('also') || '').split(',').map(s => s.trim()).filter(Boolean);
        const out = addons.plan(game, name, also);
        if (!out.error) {
          for (const a of out.order) { a.hasState = addons.readState(a.name) !== null; a.hasGameSaved = addons.findGameSaved(game, a.name).length > 0; }
        }
        json(res, out, out.error ? 404 : 200);
        return;
      }
      if (p.startsWith('/addons/')) {
        const file = inside(addons.addonsDir(game), p.slice(8));
        if (!file || !ADDON_FILE.test(file)) { res.writeHead(403); res.end(); return; }
        sendFile(res, file);
        return;
      }
      const sm = /^\/(saved|state)\/([^/]+)\.lua$/.exec(p);
      if (sm) {
        if (!addons.safeName(sm[2])) { res.writeHead(403); res.end(); return; }
        const text = sm[1] === 'saved' ? addons.readGameSaved(game, sm[2]) : addons.readState(sm[2]);
        if (text === null) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(text);
        return;
      }
      const name = p.slice(1);
      if (!PAGE_FILES.has(name)) { res.writeHead(404); res.end(); return; }
      sendFile(res, path.join(__dirname, name));
    } catch (e) {
      try { json(res, { error: String(e && e.message || e) }, 500); } catch (e2) { /* response already gone */ }
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // port 0 = any free port; the address is always the loopback one
    server.listen(port || 0, '127.0.0.1', () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

module.exports = { start };

if (require.main === module) {
  start(Number(process.argv[2]) || 8811).then(s => console.log(`Forever Mod Studio: ${s.url}`))
    .catch(e => { console.error('Could not start: ' + e.message); process.exit(1); });
}
