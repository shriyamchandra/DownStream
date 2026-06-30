const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  if (app.isReady()) {
    try {
      dialog.showErrorBox('DownStream Fatal Error', err.stack || err.message);
    } catch (e) {
      console.error('Failed to show error dialog:', e);
    }
  }
  app.quit();
  setTimeout(() => process.exit(1), 1000);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('[Electron] Another instance is already running. Quitting.');
  process.exit(0);
}

let mainWindow = null;
let backend = null;
let startupUrlParams = null;
let isQuitting = false;

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('downstream', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('downstream');
}

function validateInterceptParams(params) {
  if (!params || !params.url) return false;
  try {
    const parsed = new URL(params.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
  } catch (e) {
    return false;
  }
  
  if (params.filename) {
    const base = path.basename(params.filename);
    if (base !== params.filename || params.filename.includes('..') || params.filename.includes('/') || params.filename.includes('\\')) {
      return false;
    }
  }
  return true;
}

function handleProtocolUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    if (url.protocol === 'downstream:' && url.hostname === 'add') {
      const params = Object.fromEntries(url.searchParams.entries());
      if (!validateInterceptParams(params)) {
        console.warn('Blocked invalid/suspicious deep-link URL:', urlStr);
        return;
      }
      
      if (backend && typeof backend.handleIntercept === 'function') {
        backend.handleIntercept(params).catch(err => {
          console.error('Failed to handle downstream add:', err);
        });
      } else {
        startupUrlParams = params;
      }
      
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      } else if (app.isReady()) {
        createWindow();
      }
    }
  } catch (e) {
    console.error('Failed to parse deep link URL:', e);
  }
}

app.on('second-instance', (event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  const protocolUrl = argv.find(arg => arg.startsWith('downstream://'));
  if (protocolUrl) {
    handleProtocolUrl(protocolUrl);
  }
});

app.on('open-url', (event, urlStr) => {
  event.preventDefault();
  handleProtocolUrl(urlStr);
});

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
      const browserDir = path.dirname(path.join(homeDir, 'Library', 'Application Support', subdir));
      if (!fs.existsSync(browserDir)) {
        return;
      }

      const hostsDir = path.join(homeDir, 'Library', 'Application Support', subdir);
      const targetPath = path.join(hostsDir, manifestFileName);
      try {
        if (fs.existsSync(targetPath)) {
          const existing = fs.readFileSync(targetPath, 'utf8');
          if (existing === manifestJson) return;
        }

        if (!fs.existsSync(hostsDir)) {
          fs.mkdirSync(hostsDir, { recursive: true });
        }
        fs.writeFileSync(targetPath, manifestJson, 'utf8');
        console.log(`[Native Messaging] Registered host manifest in: ${targetPath}`);
      } catch (e) {
        if (e.code !== 'ENOENT') {
          console.error(`[Native Messaging] Failed to write manifest for ${subdir}:`, e.message);
        }
      }
    });
  } catch (err) {
    console.error('[Native Messaging] Registration failed:', err);
  }
}

function pingServer(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/api/ping`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => {
      resolve(false);
    });
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(port, maxRetries = 20) {
  for (let i = 0; i < maxRetries; i++) {
    const ok = await pingServer(port);
    if (ok) return true;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
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

  const loadPort = process.env.PORT || process.env.WEB_PORT || 3000;
  const loadUrl = `http://localhost:${loadPort}`;

  waitForServer(loadPort).then((isReady) => {
    if (!mainWindow) return;
    
    if (isReady) {
      mainWindow.loadURL(loadUrl).catch((err) => {
        console.error('Failed to load page:', err);
      });
    } else {
      console.error('Backend server failed to start on port:', loadPort);
      dialog.showErrorBox(
        'Startup Error',
        `The DownStream backend server failed to start on port ${loadPort}. Please check if the port is already in use by another process.`
      );
      app.quit();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (backend && typeof backend.stopSync === 'function') {
      backend.stopSync();
    }
  });
}

app.whenReady().then(() => {
  try {
    backend = require('./server.js');
    
    if (startupUrlParams) {
      backend.handleIntercept(startupUrlParams).catch(console.error);
      startupUrlParams = null;
    }
  } catch (err) {
    console.error('Fatal initialization error:', err);
    dialog.showErrorBox('Initialization Error', `Failed to initialize the download server:\n\n${err.message}`);
    app.quit();
    return;
  }

  setupNativeMessaging(app);
  createWindow();

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

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  if (isQuitting) return;
  isQuitting = true;
  event.preventDefault();

  console.log('[Electron] Initiating cleanup before exit...');

  const cleanupTimeout = setTimeout(() => {
    console.warn('[Electron] Cleanup timed out. Force quitting.');
    app.quit();
  }, 3000);

  if (backend && typeof backend.cleanup === 'function') {
    Promise.resolve(backend.cleanup())
      .then(() => {
        clearTimeout(cleanupTimeout);
        console.log('[Electron] Cleanup completed successfully.');
        app.quit();
      })
      .catch((err) => {
        clearTimeout(cleanupTimeout);
        console.error('[Electron] Error during cleanup:', err);
        app.quit();
      });
  } else {
    clearTimeout(cleanupTimeout);
    app.quit();
  }
});
