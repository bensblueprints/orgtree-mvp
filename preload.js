'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orgtree', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  exportJSON: () => ipcRenderer.invoke('data:exportJSON'),
  exportCSV: () => ipcRenderer.invoke('data:exportCSV'),
  importCSV: () => ipcRenderer.invoke('data:importCSV'),
  importJSON: () => ipcRenderer.invoke('data:importJSON'),
  exportPNG: (dataUrl) => ipcRenderer.invoke('data:exportPNG', dataUrl),
  pickPhoto: () => ipcRenderer.invoke('data:pickPhoto'),
});
