const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const { startServer } = require('./server');
let chatServer;
app.setName('TalkStation');

function createWindow() {
  const win = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 14, y: 22 },
    backgroundColor: '#edf2f9',
    title: 'TalkStation',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile('index.html');
}

ipcMain.handle('pick-file', async (_, type) => {
  const options = { properties: ['openFile'] };
  if (type === 'image') options.filters = [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }];
  const result = await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  const stat = require('fs').statSync(filePath);
  return { path: filePath, name: path.basename(filePath), size: stat.size, url: `file://${filePath}` };
});
ipcMain.handle('upload-file', async (_, { filePath, name, token }) => {
  const fs = require('fs');
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',pdf:'application/pdf',txt:'text/plain',zip:'application/zip',mp3:'audio/mpeg',wav:'audio/wav',webm:'audio/webm'})[ext] || 'application/octet-stream';
  const base64 = fs.readFileSync(filePath).toString('base64');
  const response = await fetch('http://127.0.0.1:3210/api/upload', {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({name,mime,base64})});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `上传失败 (${response.status})`);
  return data;
});
ipcMain.handle('open-resource', async (_, target) => {
  if (!target) return false;
  if (/^https?:\/\//i.test(target)) {
    await shell.openExternal(target);
    return true;
  }
  return (await shell.openPath(target)) === '';
});
ipcMain.handle('open-uploaded-file', async (_, { url, name }) => {
  if (!/^https?:\/\//i.test(url || '')) throw new Error('文件地址无效');
  const fs = require('fs');
  const downloadDir = path.join(app.getPath('temp'), 'TalkStation Files');
  fs.mkdirSync(downloadDir, { recursive: true });
  const safeName = path.basename(name || 'download').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
  const target = path.join(downloadDir, safeName);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`文件下载失败 (${response.status})`);
  fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  return target;
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_, permission, callback) => {
    callback(permission === 'media');
  });
  chatServer = startServer(3210);
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => chatServer?.close());
