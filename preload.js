// The only bridge between the page and the app: the page learns where each download was
// saved and can ask Finder to reveal it. Nothing else from Node is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('audiosmith', {
  // The page lays out its tab bar around the traffic lights when the title bar is hidden.
  hiddenTitleBar: process.platform === 'darwin',
  onDownloadDone(callback) {
    ipcRenderer.on('download-done', (_event, info) => callback(info));
  },
  showInFolder(filePath) {
    return ipcRenderer.invoke('show-in-folder', filePath);
  },
  // { path, name } of the folder every saved file goes to.
  getOutputDir() {
    return ipcRenderer.invoke('get-output-dir');
  },
  // Opens the native folder picker; resolves with the (possibly unchanged) folder.
  chooseOutputDir() {
    return ipcRenderer.invoke('choose-output-dir');
  },
  revealLabel: process.platform === 'darwin' ? 'Show in Finder' : process.platform === 'win32' ? 'Show in Explorer' : 'Show in folder',
});
