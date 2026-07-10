'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./src/store');
const csv = require('./src/csv');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    title: 'Orgtree',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

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

const userDir = () => app.getPath('userData');

ipcMain.handle('data:load', () => store.load(userDir()));
ipcMain.handle('data:save', (_e, data) => {
  store.save(userDir(), store.normalize(data));
  return true;
});

// ---------- export / import ----------

ipcMain.handle('data:exportJSON', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Orgtree roster (JSON)',
    defaultPath: `orgtree-export-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  fs.writeFileSync(filePath, store.exportJSON(store.load(userDir())), 'utf8');
  return { ok: true, path: filePath };
});

ipcMain.handle('data:exportCSV', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Orgtree roster (CSV)',
    defaultPath: `orgtree-roster-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  const data = store.load(userDir());
  fs.writeFileSync(filePath, csv.serializeRoster(data.people), 'utf8');
  return { ok: true, path: filePath };
});

ipcMain.handle('data:importCSV', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import roster CSV',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  try {
    const raw = fs.readFileSync(filePaths[0], 'utf8');
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
    store.save(userDir(), data);
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
  if (process.platform === 'win32') app.setAppUserModelId('com.bensblueprints.orgtree');
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
