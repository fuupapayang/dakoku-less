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
  addProject: (p) => ipcRenderer.invoke('projects:add', p),
  updateProject: (id, patch) => ipcRenderer.invoke('projects:update', { id, patch }),
  deleteProject: (id) => ipcRenderer.invoke('projects:delete', id),
  assignBlock: (key, idx, projectId, keywords) => ipcRenderer.invoke('day:assign', { key, idx, projectId, keywords }),
  saveSync: (patch) => ipcRenderer.invoke('sync:save', patch),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  addCalEvent: (ev) => ipcRenderer.invoke('cal:add', ev),
  deleteCalEvent: (id) => ipcRenderer.invoke('cal:delete', id),
  openUrl: (url) => ipcRenderer.invoke('misc:openUrl', url),
  openScreenSettings: (pane) => ipcRenderer.invoke('perm:openSettings', pane),
  importFolderProjects: () => ipcRenderer.invoke('projects:importFolder'),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
  importCalendar: () => ipcRenderer.invoke('calendar:import'),
  setTeamStatus: (memberId, dateKey, status) => ipcRenderer.invoke('team:setStatus', { memberId, dateKey, status }),
  reseedDemo: () => ipcRenderer.invoke('demo:reseed'),
  onUpdate: (cb) => ipcRenderer.on('state:update', (e, state) => cb(state))
});
