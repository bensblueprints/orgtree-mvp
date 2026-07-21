'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orgtree', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  fileNew: () => ipcRenderer.invoke('file:new'),
  fileOpen: () => ipcRenderer.invoke('file:open'),
  fileSaveAs: (data) => ipcRenderer.invoke('file:saveAs', data),
  fileOpenDefault: () => ipcRenderer.invoke('file:openDefault'),
  exportJSON: () => ipcRenderer.invoke('data:exportJSON'),
  exportCSV: () => ipcRenderer.invoke('data:exportCSV'),
  exportXLSX: () => ipcRenderer.invoke('data:exportXLSX'),
  importCSV: () => ipcRenderer.invoke('data:importCSV'),
  importJSON: () => ipcRenderer.invoke('data:importJSON'),
  exportPNG: (dataUrl) => ipcRenderer.invoke('data:exportPNG', dataUrl),
  exportPDF: (dataUrl, w, h) => ipcRenderer.invoke('data:exportPDF', dataUrl, w, h),
  pickPhoto: () => ipcRenderer.invoke('data:pickPhoto'),
  chatHost: (port, retentionDays) => ipcRenderer.invoke('chat:host', port, retentionDays),
  chatStopHost: () => ipcRenderer.invoke('chat:stopHost'),
  chatHostInfo: () => ipcRenderer.invoke('chat:hostInfo'),
  activityIdleSec: () => ipcRenderer.invoke('activity:idleSec'),
  chatPickFile: () => ipcRenderer.invoke('chat:pickFile'),
  chatSaveFile: (name, data) => ipcRenderer.invoke('chat:saveFile', name, data),
  chatSyncWrite: (label, name, data) => ipcRenderer.invoke('chat:syncWrite', label, name, data),
  chatOpenLibrary: (label) => ipcRenderer.invoke('chat:openLibrary', label),
  chatOpenExternal: (url) => ipcRenderer.invoke('chat:openExternal', url),
  smtpGet: () => ipcRenderer.invoke('smtp:get'),
  smtpSave: (smtp) => ipcRenderer.invoke('smtp:save', smtp),
  smtpTest: () => ipcRenderer.invoke('smtp:test'),
  smtpInvite: (p) => ipcRenderer.invoke('smtp:invite', p),
  onExternalChange: (cb) => ipcRenderer.on('orgtree:externalChange', () => cb()),
});
