const { app, BrowserWindow } = require('electron');
const path = require('path');

// Register downstream:// custom URL scheme so Chrome can launch the app
// even when it is closed. Must be called before app.whenReady().
if (process.defaultApp) {
  // Dev mode: electron . downstream://
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('downstream', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('downstream');
}


// Start the backend server (Express on PORT or 3000 & spawns aria2c on ARIA2_PORT or 6800)
const backend = require('./server.js');

let mainWindow;

const fs = require('fs');

function setupNativeMessaging(app) {
  try {
    const homeDir = require('os').homedir();
    const manifestFileName = 'com.downstream.interceptor.json';

    let interceptorPath = '';
    if (app.isPackaged) {
      interceptorPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'native-host', 'interceptor');
    } else {
      interceptorPath = path.join(app.getAppPath(), 'native-host', 'interceptor');
    }

    try {
      fs.chmodSync(interceptorPath, 0o755);
    } catch (e) {}

    const manifest = {
      name: "com.downstream.interceptor",
      description: "DownStream native messaging host for Chrome extension",
      path: interceptorPath,
      type: "stdio",
      allowed_origins: [
        "chrome-extension://egjdjkfddjpgakdgemjnfmdochggdelf",
        "chrome-extension://hpbnhbgbllnkkdkhednecnkcpnkicmkp"
      ]
    };

    const targetSubdirs = [
      path.join('Google', 'Chrome', 'NativeMessagingHosts'),
      path.join('BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
      path.join('Microsoft Edge', 'NativeMessagingHosts'),
      path.join('Chromium', 'NativeMessagingHosts')
    ];

    const manifestJson = JSON.stringify(manifest, null, 2);

    targetSubdirs.forEach(subdir => {
      const hostsDir = path.join(homeDir, 'Library', 'Application Support', subdir);
      const targetPath = path.join(hostsDir, manifestFileName);
      try {
        // Skip write if the manifest already exists with identical content
        if (fs.existsSync(targetPath)) {
          const existing = fs.readFileSync(targetPath, 'utf8');
          if (existing === manifestJson) return; // already up to date
        }

        if (!fs.existsSync(hostsDir)) {
          fs.mkdirSync(hostsDir, { recursive: true });
        }
        fs.writeFileSync(targetPath, manifestJson, 'utf8');
        console.log(`[Native Messaging] Registered host manifest in: ${targetPath}`);
      } catch (e) {
        // Silently skip browsers that aren't installed (ENOENT on parent dir)
        if (e.code !== 'ENOENT') {
          console.error(`[Native Messaging] Failed to write manifest for ${subdir}:`, e.message);
        }
      }
    });
  } catch (err) {
    console.error('[Native Messaging] Registration failed:', err);
  }
}

function createWindow() {
  if (backend && typeof backend.startSync === 'function') {
    backend.startSync(2500);
  }
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    title: 'DownStream',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindow.webContents.openDevTools();

  // Give the server a moment to boot up, then load the frontend
  const loadPort = process.env.PORT || process.env.WEB_PORT || 3000;
  const loadUrl = `http://localhost:${loadPort}`;
  setTimeout(() => {
    mainWindow.loadURL(loadUrl).catch((err) => {
      console.error('Failed to load page, retrying...', err);
      // Retry once after another short delay if server was slow to start
      setTimeout(() => {
        mainWindow.loadURL(loadUrl).catch(console.error);
      }, 1000);
    });
  }, 500);

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (backend && typeof backend.stopSync === 'function') {
      backend.stopSync();
    }
  });
}

app.whenReady().then(() => {
  setupNativeMessaging(app);
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

// Handle downstream:// URL launched from Chrome extension (app already running)
app.on('open-url', (event, urlStr) => {
  event.preventDefault();

  try {
    const url = new URL(urlStr);
    if (url.protocol === 'downstream:' && url.hostname === 'add') {
      const params = Object.fromEntries(url.searchParams.entries());
      // Trigger add using the backend's internal logic (no HTTP port needed)
      if (backend && typeof backend.handleIntercept === 'function') {
        backend.handleIntercept(params).catch(err => {
          console.error('Failed to handle downstream add:', err);
        });
      }
      // Focus window
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      } else {
        createWindow();
      }
      return;
    }
  } catch (e) {
    // not an add url, fall through
  }

  // Default behavior: just focus the window (for downstream://open etc.)
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});

app.on('window-all-closed', () => {
  // On macOS, keep app in dock but stop background sync timer to save CPU.
  // On other platforms, quit the app completely.
  if (backend && typeof backend.stopSync === 'function') {
    backend.stopSync();
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
