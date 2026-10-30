const { app, BrowserWindow, shell, session, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { start } = require('./server');

// Paths handed to downloads that haven't finished yet. A file only appears on disk once
// its download completes, so two same-named outputs in a batch must be told apart here.
const reservedPaths = new Set();

// Adds " (2)", " (3)"… so a new download never overwrites an existing or pending file.
function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  for (let n = 2; fs.existsSync(candidate) || reservedPaths.has(candidate); n++) {
    candidate = path.join(dir, `${base} (${n})${ext}`);
  }
  return candidate;
}

// --- Output folder: every saved file goes here, chosen once with the native picker ---

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function outputDir() {
  const saved = readSettings().outputDir;
  return saved && fs.existsSync(saved) ? saved : app.getPath('downloads');
}

function describeDir(dir) {
  return { path: dir, name: dir === app.getPath('home') ? '~' : path.basename(dir) || dir };
}

// Paths this session actually saved. "Show in Finder" only reveals these, so the page
// can't ask for arbitrary locations.
const savedPaths = new Set();

// AudioSmith uses 3000; a different port lets both apps run at once.
const PORT = 3001;
let mainWindow;

async function createWindow() {
  await start(PORT);

  const mac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    // Fits the Convert tab with a few queued files; taller content scrolls.
    width: 500,
    height: 700,
    minWidth: 460,
    minHeight: 560,
    title: 'PocketEdits',
    backgroundColor: '#ffffff',
    // On macOS the tabs sit in the title bar, beside the traffic lights.
    ...(mac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 15 } } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Saves straight into the chosen output folder (no dialog per file), under a name that
  // can't collide with an existing or in-flight file.
  session.defaultSession.on('will-download', (event, item) => {
    const url = item.getURL();
    const report = (info) => mainWindow?.webContents.send('download-done', { url, ...info });
    const savePath = uniquePath(outputDir(), item.getFilename());
    reservedPaths.add(savePath);
    item.setSavePath(savePath);
    item.once('done', (_e, state) => {
      reservedPaths.delete(savePath);
      if (state === 'completed') savedPaths.add(savePath);
      report({ state, savePath: state === 'completed' ? savePath : null });
    });
  });

  ipcMain.handle('get-output-dir', () => describeDir(outputDir()));

  ipcMain.handle('choose-output-dir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose where to save files',
      buttonLabel: 'Save here',
      defaultPath: outputDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!result.canceled && result.filePaths[0]) {
      fs.writeFileSync(settingsPath(), JSON.stringify({ ...readSettings(), outputDir: result.filePaths[0] }));
    }
    return describeDir(outputDir());
  });

  ipcMain.handle('show-in-folder', (_event, filePath) => {
    if (typeof filePath === 'string' && savedPaths.has(filePath) && fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath);
      return true;
    }
    return false;
  });
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
