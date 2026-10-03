const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  pickFile: (type) => ipcRenderer.invoke('pick-file', type),
  openResource: (target) => ipcRenderer.invoke('open-resource', target),
  openUploadedFile: (url, name) => ipcRenderer.invoke('open-uploaded-file', { url, name }),
  uploadFile: (filePath, name, token) => ipcRenderer.invoke('upload-file', { filePath, name, token }),
  platform: process.platform
});
