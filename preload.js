'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  correctDay: (key, correction) => ipcRenderer.invoke('day:correct', { key, correction }),
  addRule: (rule) => ipcRenderer.invoke('rules:add', rule),
  toggleRule: (id) => ipcRenderer.invoke('rules:toggle', id),
  deleteRule: (id) => ipcRenderer.invoke('rules:delete', id),
  submitDay: (key) => ipcRenderer.invoke('day:submit', key),
  importCalendar: () => ipcRenderer.invoke('calendar:import'),
  setTeamStatus: (memberId, dateKey, status) => ipcRenderer.invoke('team:setStatus', { memberId, dateKey, status }),
  reseedDemo: () => ipcRenderer.invoke('demo:reseed'),
  onUpdate: (cb) => ipcRenderer.on('state:update', (e, state) => cb(state))
});
