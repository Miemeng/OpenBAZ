// 预加载脚本：把宿主能力以**白名单**形式交给渲染层（`contextIsolation: true` + `nodeIntegration: false`）。
//
// 渲染层只认 `window.host` 这一个对象（见 `client/data/packSource.ts` 的第三条轨）；
// 这里不做任何业务判断，纯转发 IPC。
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('host', {
  kind: 'electron',
  loadPacks: () => ipcRenderer.invoke('packs:load'),
  listDecks: () => ipcRenderer.invoke('decks:list'),
  saveDeck: (name, text) => ipcRenderer.invoke('decks:save', name, text),
})
