'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const XLSX = require('xlsx');
const store = require('./src/store');
const csv = require('./src/csv');
const chat = require('./src/chat-server');
const invite = require('./src/invite');

let win = null;

// Edition: 'admin' (full app) or 'member' (chat/clock/profile only, cannot
// host). Baked at package time via electron-builder extraMetadata; the env
// var covers dev runs.
const EDITION = process.env.WHOLETEAM_EDITION
  || require('./package.json').wholeteamEdition
  || 'admin';

ipcMain.handle('app:edition', () => EDITION);

// Test/QA hook: point the app at an alternate data directory.
if (process.env.ORGTREE_USERDATA) app.setPath('userData', process.env.ORGTREE_USERDATA);

// Software rendering during capture runs — GPU compositing makes capturePage flaky.
if (process.env.ORGTREE_SHOT) app.disableHardwareAcceleration();

// ---------- current document tracking ----------
// currentFile === null -> the default store in userData ("My Org").
// Otherwise an explicit .orgtree/.json file opened or created by the user.

let currentFile = null;

const userDir = () => app.getPath('userData');
const configFile = () => path.join(userDir(), 'orgtree-config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch (_) { return {}; }
}
function writeConfig(cfg) {
  try {
    fs.mkdirSync(userDir(), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (_) { /* non-fatal */ }
}

function loadCurrent() {
  return currentFile ? store.loadFile(currentFile) : store.load(userDir());
}
function saveCurrent(data) {
  if (currentFile) store.saveFile(currentFile, data);
  else store.save(userDir(), data);
}
function docLabel() {
  return currentFile ? path.basename(currentFile).replace(/\.(orgtree|json)$/i, '') : 'My Org';
}
function refreshTitle() {
  if (win && !win.isDestroyed()) win.setTitle(`WholeTeam — ${docLabel()}`);
}

// One-time data migration from the app's previous identity ("Orgtree").
function migrateFromOrgtree() {
  try {
    const newDir = userDir();
    if (fs.existsSync(path.join(newDir, 'orgtree-data.json'))) return;
    const oldDir = path.join(path.dirname(newDir), 'orgtree');
    if (!fs.existsSync(path.join(oldDir, 'orgtree-data.json'))) return;
    fs.mkdirSync(newDir, { recursive: true });
    for (const f of ['orgtree-data.json', 'orgtree-config.json', 'orgtree-chat-history.json', 'orgtree-timesheet.json']) {
      const src = path.join(oldDir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(newDir, f));
    }
    const oldFiles = path.join(oldDir, 'orgtree-chat-files');
    if (fs.existsSync(oldFiles)) fs.cpSync(oldFiles, path.join(newDir, 'orgtree-chat-files'), { recursive: true });
  } catch (_) { /* fresh start is acceptable */ }
}
function rememberFile() {
  const cfg = readConfig();
  cfg.lastFile = currentFile;
  writeConfig(cfg);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#f5f7fb',
    autoHideMenuBar: true,
    title: 'WholeTeam',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  refreshTitle();

  // Surface renderer console output on stdout during QA/CI runs.
  if (process.env.ORGTREE_SHOT || process.env.ORGTREE_SMOKE || process.env.ORGTREE_DEBUG) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`RENDERER[${level}] ${sourceId}:${line} ${message}`);
    });
  }

  // Screenshot hook (used for design QA): ORGTREE_SHOT=<out.png> npm start
  // seeds sample data if the roster is empty, captures the window, and exits.
  // ORGTREE_SHOT_THEME=dark captures the dark theme.
  if (process.env.ORGTREE_SHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          await win.webContents.executeJavaScript(
            'window.__orgtreeSeedSampleIfEmpty && window.__orgtreeSeedSampleIfEmpty()', true);
          if (process.env.ORGTREE_SHOT_THEME) {
            await win.webContents.executeJavaScript(
              `window.__orgtreeSetTheme && window.__orgtreeSetTheme(${JSON.stringify(process.env.ORGTREE_SHOT_THEME)})`, true);
          }
          if (process.env.ORGTREE_SHOT_SELECT) {
            await win.webContents.executeJavaScript(
              'window.__orgtreeSelectFirst && window.__orgtreeSelectFirst()', true);
          }
          if (process.env.ORGTREE_SHOT_EDIT) {
            await win.webContents.executeJavaScript(
              'window.__orgtreeEditFirst && window.__orgtreeEditFirst()', true);
          }
          if (process.env.ORGTREE_SHOT_CHAT) {
            await win.webContents.executeJavaScript(
              `window.__orgtreeChatMode=${JSON.stringify(process.env.ORGTREE_SHOT_CHAT)}; window.__orgtreeChatDemo && window.__orgtreeChatDemo()`, true);
          }
          win.webContents.invalidate();
          setTimeout(async () => {
            let img = await win.capturePage();
            if (img.isEmpty()) {
              win.webContents.invalidate();
              await new Promise(r => setTimeout(r, 700));
              img = await win.capturePage();
            }
            fs.writeFileSync(process.env.ORGTREE_SHOT, img.toPNG());
            console.log('SHOT:' + process.env.ORGTREE_SHOT + ' bytes:' + img.toPNG().length);
            app.exit(0);
          }, 1200);
        } catch (err) {
          console.log('SHOT-ERROR:' + err.message);
          app.exit(1);
        }
      }, 1100);
    });
    return;
  }

  // Boot verification hook (used by CI / smoke checks): ORGTREE_SMOKE=1 npm start
  // prints a JSON snapshot of the booted UI and exits.
  if (process.env.ORGTREE_SMOKE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const snap = await win.webContents.executeJavaScript(`({
            tree: typeof window.OrgtreeTree,
            csv: typeof window.OrgtreeCSV,
            bridge: typeof window.orgtree,
            canvas: !!document.getElementById('chart'),
            title: document.title,
          })`);
          console.log('SMOKE:' + JSON.stringify(snap));
        } catch (err) {
          console.log('SMOKE-ERROR:' + err.message);
        }
        app.exit(0);
      }, 1200);
    });
  }
}

// ---------- data IPC ----------

ipcMain.handle('data:load', () => ({ data: loadCurrent(), fileName: docLabel(), filePath: currentFile }));
ipcMain.handle('data:save', (_e, data) => {
  saveCurrent(store.normalize(data));
  return true;
});

// ---------- document files (New / Open / Save As) ----------

const ORGTREE_FILTERS = [{ name: 'Orgtree chart', extensions: ['orgtree', 'json'] }];

ipcMain.handle('file:new', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Create a new org chart file',
    defaultPath: 'New Org.orgtree',
    filters: ORGTREE_FILTERS,
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  currentFile = filePath;
  const fresh = store.defaultData();
  store.saveFile(currentFile, fresh);
  rememberFile(); refreshTitle();
  return { ok: true, data: fresh, fileName: docLabel(), filePath: currentFile };
});

ipcMain.handle('file:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open an org chart file',
    filters: ORGTREE_FILTERS,
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  try {
    const data = store.loadFile(filePaths[0]);
    currentFile = filePaths[0];
    rememberFile(); refreshTitle();
    return { ok: true, data, fileName: docLabel(), filePath: currentFile };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('file:saveAs', async (_e, data) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save org chart as…',
    defaultPath: docLabel() + '.orgtree',
    filters: ORGTREE_FILTERS,
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  currentFile = filePath;
  store.saveFile(currentFile, store.normalize(data));
  rememberFile(); refreshTitle();
  return { ok: true, fileName: docLabel(), filePath: currentFile };
});

ipcMain.handle('file:openDefault', () => {
  currentFile = null;
  rememberFile(); refreshTitle();
  return { ok: true, data: loadCurrent(), fileName: docLabel(), filePath: null };
});

// ---------- export / import ----------

ipcMain.handle('data:exportJSON', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Orgtree roster (JSON)',
    defaultPath: `orgtree-export-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  fs.writeFileSync(filePath, store.exportJSON(loadCurrent()), 'utf8');
  return { ok: true, path: filePath };
});

ipcMain.handle('data:exportCSV', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Orgtree roster (CSV)',
    defaultPath: `orgtree-roster-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  const data = loadCurrent();
  fs.writeFileSync(filePath, csv.serializeRoster(data.people), 'utf8');
  return { ok: true, path: filePath };
});

ipcMain.handle('data:exportXLSX', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Orgtree roster (Excel)',
    defaultPath: `orgtree-roster-${new Date().toISOString().slice(0, 10)}.xlsx`,
    filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    const data = loadCurrent();
    const ws = XLSX.utils.aoa_to_sheet(csv.rosterRows(data.people));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Roster');
    XLSX.writeFile(wb, filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('data:importCSV', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import roster (CSV or Excel)',
    filters: [
      { name: 'Roster files', extensions: ['csv', 'xlsx', 'xls'] },
      { name: 'CSV', extensions: ['csv'] },
      { name: 'Excel', extensions: ['xlsx', 'xls'] },
    ],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  try {
    const file = filePaths[0];
    let raw;
    if (/\.xlsx?$/i.test(file)) {
      const wb = XLSX.readFile(file);
      const ws = wb.Sheets[wb.SheetNames[0]];
      raw = XLSX.utils.sheet_to_csv(ws);
    } else {
      raw = fs.readFileSync(file, 'utf8');
    }
    const { people, errors } = csv.parseRoster(raw);
    return { ok: true, people, errors };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('data:importJSON', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import Orgtree data',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  try {
    const data = store.importJSON(fs.readFileSync(filePaths[0], 'utf8'));
    saveCurrent(data);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('data:exportPNG', async (_e, dataUrl) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export org chart (PNG)',
    defaultPath: `orgtree-chart-${new Date().toISOString().slice(0, 10)}.png`,
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  const base64 = String(dataUrl || '').replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return { ok: true, path: filePath };
});

// PDF export: render the chart PNG into a hidden window sized to the chart,
// then printToPDF with a matching custom page size (single poster page).
ipcMain.handle('data:exportPDF', async (_e, dataUrl, wPx, hPx) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export org chart (PDF)',
    defaultPath: `orgtree-chart-${new Date().toISOString().slice(0, 10)}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  let pdfWin = null;
  try {
    const wIn = Math.max(3, wPx / 96);
    const hIn = Math.max(3, hPx / 96);
    pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    const html = `<!doctype html><html><head><style>
      *{margin:0;padding:0} body{width:${wPx}px;height:${hPx}px}
      img{width:${wPx}px;height:${hPx}px;display:block}
    </style></head><body><img src="${dataUrl}"></body></html>`;
    await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const pdf = await pdfWin.webContents.printToPDF({
      pageSize: { width: wIn, height: hIn },
      printBackground: true,
      margins: { marginType: 'none' },
    });
    fs.writeFileSync(filePath, pdf);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (pdfWin && !pdfWin.isDestroyed()) pdfWin.destroy();
  }
});

// ---------- org chat (closed-loop LAN server) ----------

let chatServer = null;

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

ipcMain.handle('chat:host', async (_e, port, retentionDays) => {
  if (EDITION === 'member') return { ok: false, error: 'The Member edition cannot host. Hosting needs WholeTeam Admin.' };
  if (chatServer) return { ok: true, port: chatServer.port, ip: lanIp(), already: true, retentionDays: chatServer.retentionDays };
  try {
    const data = loadCurrent();
    chatServer = await chat.createChatServer({
      port: Number(port) || 4600,
      retentionDays,
      roster: data.people,
      storeFile: path.join(userDir(), 'orgtree-chat-history.json'),
      filesDir: path.join(userDir(), 'orgtree-chat-files'),
      timesheetFile: path.join(userDir(), 'orgtree-timesheet.json'),
      // Employees may update their own contact details from their machines;
      // the host (admin) applies them to the live chart.
      onProfileUpdate: (personId, fields) => {
        try {
          const doc = loadCurrent();
          const person = doc.people.find(p => p.id === personId);
          if (!person) return;
          Object.assign(person, fields);
          saveCurrent(doc);
          if (win && !win.isDestroyed()) win.webContents.send('orgtree:externalChange');
        } catch (_) { /* best effort */ }
      },
    });
    return { ok: true, port: chatServer.port, ip: lanIp(), retentionDays: chatServer.retentionDays };
  } catch (err) {
    chatServer = null;
    return { ok: false, error: err.code === 'EADDRINUSE' ? 'That port is already in use.' : err.message };
  }
});

// ---------- chat files + library sync ----------

const libraryRoot = () => path.join(app.getPath('documents'), 'WholeTeam Library');

ipcMain.handle('chat:pickFile', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Share a file', properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  try {
    const stat = fs.statSync(filePaths[0]);
    if (stat.size > 300 * 1024 * 1024) return { ok: false, error: 'Files over 300 MB are not supported yet.' };
    return {
      ok: true,
      name: path.basename(filePaths[0]),
      size: stat.size,
      data: fs.readFileSync(filePaths[0]).toString('base64'),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('chat:saveFile', async (_e, name, base64) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save file', defaultPath: chat.sanitizeName(name),
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, Buffer.from(String(base64), 'base64'));
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('chat:syncWrite', (_e, label, name, base64) => {
  try {
    const dir = path.join(libraryRoot(), chat.sanitizeName(label || 'Shared'));
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, chat.sanitizeName(name));
    fs.writeFileSync(target, Buffer.from(String(base64), 'base64'));
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('chat:openLibrary', (_e, label) => {
  const dir = label ? path.join(libraryRoot(), chat.sanitizeName(label)) : libraryRoot();
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
  return { ok: true, path: dir };
});

ipcMain.handle('chat:openExternal', (_e, url) => {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url));
  return { ok: true };
});

// ---------- SMTP invites ----------

ipcMain.handle('smtp:get', () => {
  const cfg = readConfig();
  return cfg.smtp || { host: '', port: 587, secure: false, user: '', pass: '', from: '' };
});

ipcMain.handle('smtp:save', (_e, smtp) => {
  const cfg = readConfig();
  cfg.smtp = {
    host: String(smtp.host || ''), port: Number(smtp.port) || 587,
    secure: !!smtp.secure, user: String(smtp.user || ''),
    pass: String(smtp.pass || ''), from: String(smtp.from || ''),
  };
  writeConfig(cfg);
  return { ok: true };
});

function smtpTransport() {
  const cfg = readConfig();
  if (!cfg.smtp || !cfg.smtp.host) return null;
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    host: cfg.smtp.host, port: cfg.smtp.port, secure: !!cfg.smtp.secure,
    auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined,
  });
}

ipcMain.handle('smtp:test', async () => {
  const t = smtpTransport();
  if (!t) return { ok: false, error: 'SMTP is not configured yet.' };
  try {
    await t.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('smtp:invite', async (_e, p) => {
  const t = smtpTransport();
  if (!t) return { ok: false, error: 'not-configured' };
  const cfg = readConfig();
  const joinAddr = chatServer ? `${lanIp()}:${chatServer.port}` : '';
  const mail = invite.buildInvite({
    name: p.name, company: p.company, department: p.department,
    inviterName: p.inviterName || '', joinAddr,
  });
  try {
    await t.sendMail({
      from: cfg.smtp.from || cfg.smtp.user,
      to: p.to,
      subject: mail.subject, text: mail.text, html: mail.html,
    });
    return { ok: true, joinAddr };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// System idle seconds for the clocked-in activity sampler (counts only —
// no keystrokes or content are captured, powerMonitor exposes idle time only).
ipcMain.handle('activity:idleSec', () => {
  const { powerMonitor } = require('electron');
  return powerMonitor.getSystemIdleTime();
});

ipcMain.handle('chat:stopHost', async () => {
  if (chatServer) { await chatServer.stop(); chatServer = null; }
  return { ok: true };
});

ipcMain.handle('chat:hostInfo', () => (
  chatServer ? { hosting: true, port: chatServer.port, ip: lanIp() } : { hosting: false }
));

// ---------- picking a local photo file (reference only, no copying) ----------

ipcMain.handle('data:pickPhoto', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose a photo',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  return { ok: true, path: filePaths[0] };
});

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.bensblueprints.wholeteam');
  migrateFromOrgtree();
  // Reopen the last-used document file (if it still exists).
  const cfg = readConfig();
  if (cfg.lastFile && fs.existsSync(cfg.lastFile)) currentFile = cfg.lastFile;
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (chatServer) { chatServer.stop(); chatServer = null; }
});
