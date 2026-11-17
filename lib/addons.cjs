// Forever Mod Studio: reading the game's AddOns folder (READ-ONLY) and the
// studio's own config / state files. Shared by server.cjs and the headless
// checks so both load an addon exactly the same way.
const fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'config.json');
const STATE = path.join(ROOT, 'state');
const EXPORTS = path.join(ROOT, 'exports');
const DEFAULT_GAME = 'X:/WorldofWarcraft/World of Warcraft/_forever_';
// Addons the client would have loaded anyway because they are enabled, although
// the .toc of the addon being opened does not name them.
const DEFAULT_COMPANIONS = { '^Forever\\w+HUD2?$': ['ForeverArt', 'ForeverFonts'] };

function readConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { /* first run */ }
  if (typeof c.gameFolder !== 'string' || !c.gameFolder) c.gameFolder = process.env.WOW_FOREVER || DEFAULT_GAME;
  if (!c.companions || typeof c.companions !== 'object') c.companions = DEFAULT_COMPANIONS;
  return c;
}
function writeConfig(c) { fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2)); }

const addonsDir = game => path.join(game, 'Interface', 'AddOns');
const accountsDir = game => path.join(game, 'WTF', 'Account');

// A folder name we are willing to use in a path: no separators, no "..".
const safeName = n => typeof n === 'string' && n.length > 0 && n.length < 120 && !/[\\/:*?"<>|]/.test(n) && n !== '.' && n !== '..';

// ---------------------------------------------------------------- .toc
function findToc(dir, name) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  const tocs = names.filter(n => /\.toc$/i.test(n));
  if (!tocs.length) return null;
  const low = name.toLowerCase();
  // <Addon>.toc first, then the flavour-specific ones the classic clients read
  const rank = n => {
    const b = n.toLowerCase();
    if (b === low + '.toc') return 0;
    if (/[-_](vanilla|classic)\.toc$/.test(b)) return 1;
    if (b.startsWith(low)) return 2;
    return 3;
  };
  tocs.sort((a, b) => rank(a) - rank(b));
  return tocs[0];
}

function list(v) { return String(v || '').split(',').map(s => s.trim()).filter(Boolean); }

function parseToc(text) {
  const meta = {}, files = [];
  for (let line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    const m = /^##\s*([^:]+?)\s*:\s*(.*)$/.exec(line);
    if (m) { meta[m[1].toLowerCase()] = m[2].trim(); continue; }
    if (line.startsWith('#')) continue;
    // "file.lua [AllowLoadTextLocale enUS]": conditions in brackets
    let cond = '';
    const c = /^(.*?)\s*\[(.*)\]\s*$/.exec(line);
    if (c) { line = c[1].trim(); cond = c[2]; }
    if (/AllowLoadTextLocale/i.test(cond) && !/\benUS\b/.test(cond)) continue;   // the studio is an enUS client
    if (/AllowLoadGameType/i.test(cond) && !/\b(vanilla|classic|classic_era)\b/i.test(cond)) continue;
    if (line) files.push(line.replace(/\//g, '\\'));
  }
  return {
    title: (meta.title || '').replace(/\|c[0-9a-fA-F]{8}|\|r/g, ''),
    notes: meta.notes || '', version: meta.version || '', author: meta.author || '', interface: meta.interface || '',
    saved: list(meta.savedvariables), savedPerChar: list(meta.savedvariablespercharacter),
    requiredDeps: [...list(meta.dependencies), ...list(meta.requireddeps), ...list(meta.requireddependencies)],
    optionalDeps: [...list(meta.optionaldeps), ...list(meta.optionaldependencies)],
    loadOnDemand: meta.loadondemand === '1', loadWith: list(meta.loadwith),
    files,
  };
}

function readAddon(game, name) {
  if (!safeName(name)) return null;
  const dir = path.join(addonsDir(game), name);
  const tocName = findToc(dir, name);
  if (!tocName) return null;
  let toc;
  try { toc = parseToc(fs.readFileSync(path.join(dir, tocName), 'utf8')); } catch (e) { return null; }
  toc.name = name; toc.toc = tocName; toc.dir = dir;
  return toc;
}

function listAddons(game) {
  let names = [];
  try { names = fs.readdirSync(addonsDir(game), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch (e) { return { error: 'Cannot read ' + addonsDir(game), addons: [] }; }
  const addons = [];
  for (const n of names.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))) {
    const a = readAddon(game, n);
    if (!a) continue;
    addons.push({
      name: n, title: a.title || n, notes: a.notes, version: a.version, author: a.author,
      deps: a.requiredDeps, optional: a.optionalDeps, loadOnDemand: a.loadOnDemand,
      lua: a.files.filter(f => /\.lua$/i.test(f)).length, xml: a.files.filter(f => /\.xml$/i.test(f)).length,
      saved: [...a.saved, ...a.savedPerChar],
      hasState: fs.existsSync(path.join(STATE, n + '.lua')),
      hasGameSaved: findGameSaved(game, n).length > 0,
    });
  }
  return { addons };
}

// ---------------------------------------------------------------- load plan
// XML cannot be run (the studio has no XML frame builder), but an XML file
// that only pulls in scripts - the usual "embeds.xml" of library bundles - is
// followed so its <Script file=""/> and <Include file=""/> lines still load.
function expandXml(dir, rel, out, depth) {
  const entry = { path: rel, kind: 'xml', note: '' };
  out.push(entry);
  let text;
  try { text = fs.readFileSync(path.join(dir, rel), 'utf8'); } catch (e) { entry.kind = 'missing'; return; }
  const base = path.win32.dirname(rel) === '.' ? '' : path.win32.dirname(rel) + '\\';
  const body = text.replace(/<!--[\s\S]*?-->/g, '');
  let followed = 0;
  const re = /<(Script|Include)\b[^>]*?\bfile\s*=\s*"([^"]+)"/gi;
  let m;
  while ((m = re.exec(body))) {
    const target = path.win32.normalize(base + m[2].replace(/\//g, '\\'));
    if (target.startsWith('..')) continue;
    followed++;
    if (/\.xml$/i.test(target)) { if (depth < 8) expandXml(dir, target, out, depth + 1); }
    else addFile(dir, target, out);
  }
  const frames = (body.match(/<(Frame|Button|CheckButton|EditBox|Slider|StatusBar|ScrollFrame|GameTooltip|FontString|Texture|Font)\b/gi) || []).length;
  entry.note = (followed ? `followed ${followed} <Script>/<Include> line${followed === 1 ? '' : 's'}` : 'nothing to follow')
    + (frames ? `; ${frames} XML-defined widget${frames === 1 ? '' : 's'} NOT built` : '');
}
function addFile(dir, rel, out) {
  const full = path.join(dir, rel);
  if (!fs.existsSync(full)) { out.push({ path: rel, kind: 'missing' }); return; }
  if (/\.lua$/i.test(rel)) out.push({ path: rel, kind: 'lua' });
  else if (/\.xml$/i.test(rel)) expandXml(dir, rel, out, 0);
  else out.push({ path: rel, kind: 'other' });
}

// Order: dependencies first (required and optional, when the folder has them),
// then the "also load" companions, then the addon itself.
function plan(game, target, also) {
  const order = [], seen = new Set(), missing = [];
  function visit(name, why) {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const a = readAddon(game, name);
    if (!a) { if (why !== 'optional') missing.push({ name, why }); return; }
    for (const d of a.requiredDeps) visit(d, 'required by ' + name);
    for (const d of a.optionalDeps) visit(d, 'optional');
    const files = [];
    for (const f of a.files) addFile(a.dir, f, files);
    order.push({ name: a.name, title: a.title || a.name, toc: a.toc, why, saved: a.saved, savedPerChar: a.savedPerChar,
      version: a.version, notes: a.notes, files });
  }
  const t = readAddon(game, target);
  if (!t) return { error: `No .toc found for "${target}" in ${addonsDir(game)}` };
  for (const d of t.requiredDeps) visit(d, 'required by ' + target);
  for (const d of t.optionalDeps) visit(d, 'optional');
  for (const c of also || []) if (c.toLowerCase() !== target.toLowerCase()) visit(c, 'also load');
  visit(target, 'target');
  return { target: t.name, order, missing };
}

function companionsFor(config, name) {
  const out = [];
  for (const [pattern, names] of Object.entries(config.companions || {})) {
    let re;
    try { re = new RegExp(pattern); } catch (e) { continue; }
    if (re.test(name)) for (const n of names) if (!out.includes(n)) out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------- saved variables
// The game's own files (read only): the account-wide one and, for per-character
// variables, the first character that has one.
function findGameSaved(game, name) {
  const found = [];
  if (!safeName(name)) return found;
  let accounts = [];
  try { accounts = fs.readdirSync(accountsDir(game)); } catch (e) { return found; }
  for (const acct of accounts) {
    const base = path.join(accountsDir(game), acct);
    const f = path.join(base, 'SavedVariables', name + '.lua');
    if (fs.existsSync(f)) found.push(f);
    let realms = [];
    try { realms = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== 'SavedVariables').map(d => d.name); } catch (e) { /* not a folder */ }
    let perChar = null;
    for (const realm of realms) {
      let chars = [];
      try { chars = fs.readdirSync(path.join(base, realm), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch (e) { continue; }
      for (const ch of chars) {
        const cf = path.join(base, realm, ch, 'SavedVariables', name + '.lua');
        if (!perChar && fs.existsSync(cf)) perChar = cf;
      }
    }
    if (perChar) found.push(perChar);
    if (found.length) break;
  }
  return found;
}
function readGameSaved(game, name) {
  const files = findGameSaved(game, name);
  if (!files.length) return null;
  return files.map(f => fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')).join('\n');
}
function readState(name) {
  if (!safeName(name)) return null;
  try { return fs.readFileSync(path.join(STATE, name + '.lua'), 'utf8'); } catch (e) { return null; }
}
function writeState(name, text) {
  if (!safeName(name)) throw new Error('bad addon name');
  fs.mkdirSync(STATE, { recursive: true });
  const file = path.join(STATE, name + '.lua');
  fs.writeFileSync(file, text);
  return file;
}
function writeExport(game, name, text) {
  if (!safeName(name)) throw new Error('bad addon name');
  fs.mkdirSync(EXPORTS, { recursive: true });
  const file = path.join(EXPORTS, name + '.lua');
  const dest = path.join(accountsDir(game), '<ACCOUNT>', 'SavedVariables', name + '.lua');
  const note = [
    '-- Exported by Forever Mod Studio on ' + new Date().toISOString(),
    '-- This is a copy of the settings as adjusted in the studio. Nothing was written to the game.',
    '-- To use it in game: close the game first, then copy this file to',
    '--   ' + dest,
    '-- (<ACCOUNT> is your account folder; keep a backup of the file that is there).',
    '-- Per-character variables, if this addon has any, belong in',
    '--   ' + path.join(accountsDir(game), '<ACCOUNT>', '<Realm>', '<Character>', 'SavedVariables', name + '.lua'),
    '',
  ].join('\n');
  fs.writeFileSync(file, note + text);
  return { file, dest };
}

module.exports = { ROOT, STATE, EXPORTS, DEFAULT_GAME, readConfig, writeConfig, addonsDir, accountsDir, safeName, parseToc,
  readAddon, listAddons, plan, companionsFor, findGameSaved, readGameSaved, readState, writeState, writeExport };
