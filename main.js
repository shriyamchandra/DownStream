const { app, BrowserWindow } = require('electron');
const path = require('path');

// Register aria2streamer:// custom URL scheme so Chrome can launch the app
// even when it is closed. Must be called before app.whenReady().
if (process.defaultApp) {
  // Dev mode: electron . aria2streamer://
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('aria2streamer', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('aria2streamer');
}


// Start the backend server (starts Express on 3000 & spawns aria2c on 6800)
const backend = require('./server.js');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    title: 'Aria2 Streamer Pro',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Give the server a moment to boot up, then load the frontend
  setTimeout(() => {
    mainWindow.loadURL('http://localhost:3000').catch((err) => {
      console.error('Failed to load page, retrying...', err);
      // Retry once after another short delay if server was slow to start
      setTimeout(() => {
        mainWindow.loadURL('http://localhost:3000').catch(console.error);
      }, 1000);
    });
  }, 500);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  // Listen for intercepts from backend server to bring the window to the front
  if (backend && backend.events) {
    backend.events.on('intercept', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Handle aria2streamer:// URL launched from Chrome extension (app already running)
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});

app.on('window-all-closed', () => {
  // Clean up and terminate backend processes (aria2c, etc.)
  if (backend && typeof backend.cleanup === 'function') {
    backend.cleanup();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// For macOS, quit when all windows are closed since we don't want a background daemon running
app.on('will-quit', () => {
  if (backend && typeof backend.cleanup === 'function') {
    backend.cleanup();
  }
});
