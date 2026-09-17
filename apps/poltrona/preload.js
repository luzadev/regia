'use strict';

// The pairing screen is a local page: only there does the app expose anything.
// The station page served by the Regia server gets nothing from this preload.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('regiaSetup', {
    info: () => ipcRenderer.invoke('setup:info'),
    probe: (address) => ipcRenderer.invoke('setup:probe', address),
    save: (station) => ipcRenderer.invoke('setup:save', station),
    close: () => ipcRenderer.invoke('setup:close'),
    quit: () => ipcRenderer.invoke('setup:quit')
  });
}
