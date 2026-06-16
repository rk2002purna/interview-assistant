const { app, BrowserWindow, dialog, ipcMain, Menu, desktopCapturer, systemPreferences, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { readActiveWindowText } = require('./screen-reader');
const { backendRequest } = require('./net/backend-client');

// ── Browser Auth Configuration ─────────────────────────────────────────────
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://upnod.referconnect.in';

/** Parse interview-assistant://callback?access_token=...&refresh_token=... */
function handleProtocolUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    if (url.hostname === 'callback') {
      const accessToken = url.searchParams.get('access_token');
      const refreshToken = url.searchParams.get('refresh_token');

      if (!accessToken || !refreshToken) {
        mainWindow?.webContents.send('auth-callback-error', 'Missing tokens in callback URL.');
        return;
      }

      // Estimate expires_in from the JWT exp claim
      let expiresIn = 3600;
      try {
        const parts = accessToken.split('.');
        if (parts.length === 3) {
          const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
          const payload = JSON.parse(Buffer.from(base64, 'base64').toString());
          if (payload.exp) {
            expiresIn = Math.max(60, payload.exp - Math.floor(Date.now() / 1000));
          }
        }
      } catch { /* use default */ }

      authController.handleLoginSuccess({ accessToken, refreshToken, expiresIn });

      // Also persist the email if available from the JWT
      try {
        const parts = accessToken.split('.');
        if (parts.length === 3) {
          const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
          const payload = JSON.parse(Buffer.from(base64, 'base64').toString());
          if (payload.email || payload.sub) {
            const secureStore = require('./auth/secure-store');
            secureStore.setItem('user_email', payload.email || payload.sub);
          }
        }
      } catch { /* best effort */ }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('auth-callback-success');
        // Auto-navigate to the main app after a brief delay for the UI to update
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
          }
        }, 800);
      }
    }
  } catch {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auth-callback-error', 'Invalid authentication response from browser.');
    }
  }
}

// ── Single Instance Lock (for protocol URL handling on Windows) ───────────
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    // Windows passes the protocol URL as a command-line argument
    const url = commandLine.find(arg => arg.startsWith('interview-assistant://'));
    if (url) handleProtocolUrl(url);
  });
}

// macOS: handle protocol URL while app is running
app.on('open-url', (_event, url) => {
  handleProtocolUrl(url);
});

// ── Auth & Session controllers (eagerly required, referenced by handleProtocolUrl) ──
const authController = require('./auth/auth-controller');
const { sessionController } = require('./session/session-controller');
const { checkoutController } = require('./billing/checkout-controller');
const { setAuthController } = require('./net/backend-client');

let mainWindow;
let settingsWindow;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 700,
    x: 20,
    y: 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      preload: path.join(__dirname, 'preload.js')
    },
    hasShadow: false,
  });

  if (process.platform === 'win32' || process.platform === 'darwin') {
    mainWindow.setContentProtection(true);
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));

  // Use 'floating' level on macOS for reliable always-on-top behavior
  // 'screen-saver' can conflict with fullscreen apps on macOS
  if (process.platform === 'darwin') {
    mainWindow.setAlwaysOnTop(true, 'floating', 1);
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    mainWindow.setFullScreenable(false);
    // Hide dock icon but keep window on top
    app.dock.hide();
  } else {
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createSettingsWindow() {
  if (settingsWindow) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 500,
    height: 520,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, preload: path.join(__dirname, 'preload.js') }
  });
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));

  // Make settings window invisible to screen recording (same as main window)
  if (process.platform === 'win32' || process.platform === 'darwin') {
    settingsWindow.setContentProtection(true);
  }

  settingsWindow.on('closed', () => settingsWindow = null);
}

app.whenReady().then(() => {
  // Remove the default menu bar (File, Edit, View, etc.) from all windows
  Menu.setApplicationMenu(null);

  createMainWindow();

  // Register custom protocol for browser OAuth callback.
  // In development we force re-register on every startup because the old
  // registration may lack the required app-path argument.
  // We use __dirname/.. (absolute path) because the browser's working dir
  // is C:\Windows\system32, so a relative '.' would resolve there.
  if (process.defaultApp) {
    app.removeAsDefaultProtocolClient('interview-assistant');
    app.setAsDefaultProtocolClient('interview-assistant', process.execPath, [
      path.resolve(__dirname, '..'),
    ]);
  } else if (!app.isDefaultProtocolClient('interview-assistant')) {
    app.setAsDefaultProtocolClient('interview-assistant');
  }

  // Cold start: check for protocol URL in command-line args (all platforms)
  const url = process.argv.find(arg => arg.startsWith('interview-assistant://'));
  if (url) {
    setTimeout(() => handleProtocolUrl(url), 500);
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });

ipcMain.on('open-settings', () => createSettingsWindow());

// ── Mini-mode (collapse to floating yellow button) ──────────────────────────
let miniMode = false;
let savedBounds = null;

ipcMain.on('minimize-window', () => {
  if (!mainWindow) return;
  if (!miniMode) {
    // Save current bounds and switch to mini mode
    savedBounds = mainWindow.getBounds();
    const display = screen.getDisplayNearestPoint({ x: savedBounds.x, y: savedBounds.y });
    const { width: screenW, height: screenH, x: screenX, y: screenY } = display.workArea;
    // Position the mini button at bottom-right of the screen
    const miniSize = 48;
    const margin = 20;
    mainWindow.setMinimumSize(miniSize, miniSize);
    mainWindow.setResizable(false);
    mainWindow.setBounds({
      x: screenX + screenW - miniSize - margin,
      y: screenY + screenH - miniSize - margin,
      width: miniSize,
      height: miniSize
    });
    miniMode = true;
    mainWindow.webContents.send('mini-mode', true);
  }
});

ipcMain.on('restore-window', () => {
  if (!mainWindow || !miniMode) return;
  if (savedBounds) {
    mainWindow.setResizable(true);
    mainWindow.setMinimumSize(200, 300);
    mainWindow.setBounds(savedBounds);
  }
  miniMode = false;
  mainWindow.webContents.send('mini-mode', false);
});

// ── On-Camera mode (stick to top-center, dynamic height) ────────────────────
let onCameraMode = false;
let manualBounds = null; // bounds before entering on-camera mode

ipcMain.on('set-display-mode', (event, mode) => {
  if (!mainWindow) return;
  if (mode === 'on-camera' && !onCameraMode) {
    // Save current manual bounds
    manualBounds = mainWindow.getBounds();
    onCameraMode = true;
    // Position at top-center of the primary display
    const display = screen.getPrimaryDisplay();
    const { width: screenW, x: screenX, y: screenY } = display.workArea;
    const winWidth = 420;
    const x = screenX + Math.round((screenW - winWidth) / 2);
    const y = screenY; // stick to top
    mainWindow.setResizable(false);
    mainWindow.setBounds({ x, y, width: winWidth, height: 80 }); // minimal initial height
    mainWindow.webContents.send('on-camera-mode', true);
  } else if (mode === 'manual' && onCameraMode) {
    onCameraMode = false;
    mainWindow.setResizable(true);
    if (manualBounds) {
      mainWindow.setBounds(manualBounds);
    }
    mainWindow.webContents.send('on-camera-mode', false);
  }
});

ipcMain.on('resize-on-camera', (event, { height }) => {
  if (!mainWindow || !onCameraMode) return;
  const display = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH, x: screenX, y: screenY } = display.workArea;
  const winWidth = 420;
  const x = screenX + Math.round((screenW - winWidth) / 2);
  // Clamp height: min 60, max 60% of screen
  const maxH = Math.round(screenH * 0.6);
  const clampedH = Math.max(60, Math.min(height, maxH));
  mainWindow.setBounds({ x, y: screenY, width: winWidth, height: clampedH });
});

ipcMain.on('close-app', () => app.quit());

// ── Browser Auth IPC ────────────────────────────────────────────────────────
ipcMain.on('open-browser-login', () => {
  shell.openExternal(`${WEB_APP_URL}/desktop-auth`);
});

ipcMain.on('open-external-url', (_event, url) => {
  shell.openExternal(url);
});

ipcMain.on('open-browser-register', () => {
  // Open desktop-auth first — if user already has a browser session, it will
  // redirect back to the app immediately. If not, it redirects to login page
  // where user can navigate to register.
  shell.openExternal(`${WEB_APP_URL}/desktop-auth?intent=register`);
});

ipcMain.on('hide-for-screenshot', () => {
  if (mainWindow) {
    mainWindow.hide();
  }
});

ipcMain.on('show-after-screenshot', () => {
  if (mainWindow) {
    mainWindow.showInactive();
    // Re-apply ALL window protections after show (they get reset on hide/show cycle)
    if (process.platform === 'win32' || process.platform === 'darwin') {
      mainWindow.setContentProtection(true);
    }
    if (process.platform === 'darwin') {
      mainWindow.setAlwaysOnTop(true, 'floating', 1);
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } else {
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
    }
  }
});

ipcMain.on('save-config', (event, config) => {
  const configPath = path.join(os.homedir(), '.interview-assistant-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  event.reply('config-saved');
});

ipcMain.on('api-key-updated-broadcast', (event, key) => {
  mainWindow?.webContents.send('api-key-updated', key);
});

ipcMain.on('provider-updated-broadcast', (event, provider) => {
  mainWindow?.webContents.send('provider-updated', provider);
});

ipcMain.on('config-changed-broadcast', () => {
  mainWindow?.webContents.send('config-changed');
});

ipcMain.handle('load-config', () => {
  const configPath = path.join(os.homedir(), '.interview-assistant-config.json');
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  return {};
});

ipcMain.handle('get-platform', () => {
  return process.platform;
});

ipcMain.handle('call-ai-api', async (event, { model, messages, systemPrompt }) => {
  try {
    const result = await backendRequest({
      method: 'POST',
      path: '/ai/text',
      body: { model, messages, systemPrompt }
    });

    if (!result.ok) {
      return { error: { message: result.error ? result.error.message : 'Request failed' } };
    }

    const data = result.data;
    if (data && data.content) {
      return { content: data.content };
    } else if (data && data.choices && data.choices[0] && data.choices[0].message) {
      return { content: [{ text: data.choices[0].message.content }] };
    }
    return { content: [{ text: data && data.text ? data.text : '' }] };
  } catch (e) {
    return { error: { message: 'Network error: ' + e.message } };
  }
});

ipcMain.handle('call-deepseek-api', async (event, { model, messages, systemPrompt }) => {
  try {
    const result = await backendRequest({
      method: 'POST',
      path: '/ai/text',
      body: { model, messages, systemPrompt }
    });

    if (!result.ok) {
      return { error: { message: result.error ? result.error.message : 'Request failed' } };
    }

    const data = result.data;
    if (data && data.content) {
      return { content: data.content };
    } else if (data && data.choices && data.choices[0] && data.choices[0].message) {
      return { content: [{ text: data.choices[0].message.content }] };
    }
    return { content: [{ text: data && data.text ? data.text : '' }] };
  } catch (e) {
    return { error: { message: 'Network error: ' + e.message } };
  }
});

ipcMain.handle('call-gemini-api', async (event, { model, messages, systemPrompt }) => {
  try {
    // Determine if this is a vision request (messages contain image content)
    const hasImages = messages.some(m =>
      Array.isArray(m.content) && m.content.some(p => p.type === 'image_url')
    );
    const endpoint = hasImages ? '/ai/vision' : '/ai/text';

    const result = await backendRequest({
      method: 'POST',
      path: endpoint,
      body: { model, messages, systemPrompt }
    });

    if (!result.ok) {
      return { error: { message: result.error ? result.error.message : 'Request failed' } };
    }

    const data = result.data;
    if (data && data.content) {
      return { content: data.content };
    }
    return { content: [{ text: data && data.text ? data.text : '' }] };
  } catch (e) {
    return { error: { message: 'Network error: ' + e.message } };
  }
});

// Streaming AI handler - emits tokens to renderer as they arrive via backend AI Proxy
ipcMain.handle('call-ai-stream', async (event, { provider, model, messages, systemPrompt, streamId }) => {
  const sender = event.sender;

  try {
    // Determine if this is a vision request (messages contain image content)
    const hasImages = messages.some(m =>
      Array.isArray(m.content) && m.content.some(p => p.type === 'image_url')
    );
    const endpoint = hasImages ? '/ai/vision' : '/ai/text';

    // Use streaming mode to get the raw Response for SSE consumption
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const result = await backendRequest({
      method: 'POST',
      path: endpoint,
      body: { model, messages, systemPrompt, stream: true },
      stream: true,
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!result.ok) {
      return { error: { message: result.error ? result.error.message : 'Request failed' } };
    }

    const response = result.raw;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // last line may be incomplete

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;

          try {
            const json = JSON.parse(data);
            // Handle backend SSE format: { delta: "..." }
            if (json.delta) {
              fullText += json.delta;
              sender.send('ai-stream-chunk', { streamId, delta: json.delta });
            }
            // Also handle OpenAI-compatible format from backend
            else if (json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content) {
              const content = json.choices[0].delta.content;
              fullText += content;
              sender.send('ai-stream-chunk', { streamId, delta: content });
            }
            // Handle error in stream
            else if (json.error) {
              return { error: { message: json.error.message || 'Stream error' } };
            }
          } catch {
            // ignore parse errors on partial chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!fullText) {
      return { error: { message: 'Empty response from AI service' } };
    }

    return { content: [{ text: fullText }] };
  } catch (e) {
    if (e.name === 'AbortError') {
      return { error: { message: 'Request timed out' } };
    }
    return { error: { message: 'Network error: ' + e.message } };
  }
});

// Get desktop capturer sources for system audio loopback
ipcMain.handle('get-desktop-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      fetchWindowIcons: false
    });
    return sources.map(s => ({ id: s.id, name: s.name }));
  } catch (e) {
    return [];
  }
});

// Read active window text via UI Automation (primary method for Screen Analyzer)
ipcMain.handle('read-active-window', async () => {
  try {
    const result = await readActiveWindowText();
    return result;
  } catch (e) {
    return { error: 'Read failed: ' + e.message, title: '', text: '' };
  }
});

// Screen capture for Screen Analyzer mode (fallback when UI Automation fails)
ipcMain.handle('capture-screen-frame', async () => {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    const scaleFactor = primaryDisplay.scaleFactor || 1;

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.floor(width * scaleFactor),
        height: Math.floor(height * scaleFactor)
      }
    });

    if (!sources || sources.length === 0) {
      return { error: 'No screen source available' };
    }

    // Capture ALL screens (multi-monitor support)
    const images = sources.map((s, i) => ({
      index: i,
      name: s.name || ('Screen ' + (i + 1)),
      image: s.thumbnail.toJPEG(80).toString('base64')
    }));

    return {
      images: images,
      // Backward compatibility: keep `image` as the first/primary screen
      image: images[0].image
    };
  } catch (e) {
    return { error: 'Screen capture failed: ' + e.message };
  }
});

ipcMain.handle('transcribe-audio', async (event, { audioData }) => {
  try {
    // Build multipart form data for the /ai/audio endpoint
    const audioBuffer = Buffer.from(audioData, 'base64');
    const { getClientId } = require('./auth/client-id');

    // Use native fetch with FormData (Node 22 supports this)
    const { FormData, File } = require('node:buffer');
    // Node 22 has global FormData and File via undici
    const formData = new globalThis.FormData();
    const file = new globalThis.File([audioBuffer], 'audio.webm', { type: 'audio/webm' });
    formData.append('file', file);
    formData.append('model', 'whisper-large-v3');

    const token = authController.getAccessToken();
    const headers = {
      'Authorization': token ? `Bearer ${token}` : '',
      'X-Client-Id': getClientId(),
      'X-Build-Version': '1.0.0'
    };

    const { getBaseUrl } = require('./net/backend-client');
    const response = await fetch(`${getBaseUrl()}/ai/audio`, {
      method: 'POST',
      headers,
      body: formData
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => null);
      const msg = errBody?.error?.message || `Transcription failed (${response.status})`;
      return { error: { message: msg } };
    }

    const data = await response.json();
    if (data && data.text) {
      return { text: data.text };
    }
    return { error: { message: 'Unexpected response from transcription service' } };
  } catch (e) {
    return { error: { message: 'Network error: ' + e.message } };
  }
});

// =============================================================================
// Auth, Entitlement, Session, Purchase IPC handlers
// (wired to the new interviewAssistantApi preload namespaces)
// =============================================================================

// Wire auth controller into the backend client for 401 refresh handling
setAuthController(authController);

// Initialize auth controller (loads persisted tokens)
authController.initialize();

// Wire the HTTP client into auth controller for refresh/logout calls
authController.setHttpClient(async (path, options) => {
  const result = await backendRequest({
    method: options.method || 'POST',
    path: path,
    body: options.body
  });
  return { ok: result.ok, status: result.status, data: result.data };
});

// Wire backend request into session controller
// Session controller expects: backendRequest(method, path) => {data, error}
sessionController.init(async (method, path, options) => {
  const result = await backendRequest({ method, path, ...(options || {}) });
  if (!result.ok) {
    return { error: result.error || { code: 'request_failed', message: 'Request failed' }, data: null };
  }
  return { data: result.data, error: null };
});

// Forward session state changes to renderer
sessionController.on('session:state-changed', (state) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('session:stateChanged', state);
  }
});

// Track explicit logout to prevent auto-login loop
let justLoggedOut = false;

// Forward auth state changes to renderer
authController.on('auth:logged-out', (info) => {
  // Reset session state on logout
  sessionController.reset();
  justLoggedOut = true;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('auth:changed', 'logged-out');
    // Navigate main window back to login page
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('auth:changed', 'logged-out');
    settingsWindow.close();
  }
});

// --- Auth IPC handlers ---
ipcMain.handle('auth:login', async (event, { email, password }) => {
  try {
    const { getClientId } = require('./auth/client-id');
    const clientId = getClientId();

    const result = await backendRequest({
      method: 'POST',
      path: '/auth/login',
      body: { email, password, client_id: clientId }
    });

    if (!result.ok) {
      return { error: result.error || { code: 'login_failed', message: 'Login failed' } };
    }

    // Store tokens via auth controller
    const data = result.data;
    authController.handleLoginSuccess({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in || 3600
    });

    // Also store email in config for display purposes
    const secureStore = require('./auth/secure-store');
    secureStore.setItem('user_email', email);

    return { success: true, user: { email, role: data.role || 'user' } };
  } catch (e) {
    return { error: { code: 'network_error', message: e.message } };
  }
});

ipcMain.handle('auth:register', async (event, { email, password }) => {
  try {
    const { getClientId } = require('./auth/client-id');
    const clientId = getClientId();

    const result = await backendRequest({
      method: 'POST',
      path: '/auth/register',
      body: { email, password, client_id: clientId }
    });

    if (!result.ok) {
      return { error: result.error };
    }
    return { success: true };
  } catch (e) {
    return { error: { code: 'network_error', message: e.message } };
  }
});

ipcMain.handle('auth:logout', async () => {
  // Best-effort backend revocation with 5s timeout (prevents fetch from hanging forever)
  try {
    await Promise.race([
      authController.logout(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
  } catch {
    // Backend unreachable or timed out — force-clear local state and emit event manually
    authController._clearState();
    authController.emit('auth:logged-out', { reason: 'user_logout' });
  }
  return { success: true };
});

// Fire-and-forget logout channel (used by settings page for instant response)
ipcMain.on('logout-request', () => {
  // Try backend revocation with 5s timeout, then always clean up locally
  Promise.race([
    authController.logout(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
  ]).catch(() => {
    authController._clearState();
    authController.emit('auth:logged-out', { reason: 'user_logout' });
  });
});

ipcMain.handle('auth:getCurrentUser', async () => {
  if (!authController.isAuthenticated()) {
    return null;
  }
  // Decode the access token to get user info
  try {
    const token = authController.getAccessToken();
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    // Normalize base64url to base64 for compatibility with older Node.js
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf-8');
    const payload = JSON.parse(json);
    return {
      email: payload.email || payload.sub || 'unknown',
      role: payload.role || 'user',
      displayName: payload.display_name || null
    };
  } catch {
    return null;
  }
});

// --- Entitlement IPC handlers ---
ipcMain.handle('entitlement:get', async () => {
  try {
    const result = await backendRequest({ method: 'GET', path: '/me/entitlement' });
    if (!result.ok) return { error: result.error };
    return result.data;
  } catch (e) {
    return { error: { code: 'network_error', message: e.message } };
  }
});

// --- Session IPC handlers ---
ipcMain.handle('session:start', async () => {
  return await sessionController.start();
});

ipcMain.handle('session:end', async () => {
  return await sessionController.end();
});

ipcMain.handle('session:extend', async () => {
  return await sessionController.extend();
});

ipcMain.handle('session:getActive', async () => {
  return await sessionController.getActive();
});

// --- Purchase IPC handlers ---
ipcMain.handle('purchase:listPacks', async () => {
  try {
    const result = await backendRequest({ method: 'GET', path: '/packs' });
    if (!result.ok) return { error: result.error };
    return result.data;
  } catch (e) {
    return { error: { code: 'network_error', message: e.message } };
  }
});

ipcMain.handle('purchase:checkout', async (event, packSlug) => {
  return await checkoutController.checkout(packSlug);
});

ipcMain.handle('purchase:listMine', async () => {
  try {
    const result = await backendRequest({ method: 'GET', path: '/me/purchases' });
    if (!result.ok) return { error: result.error };
    return result.data;
  } catch (e) {
    return { error: { code: 'network_error', message: e.message } };
  }
});

// --- Config IPC handlers ---
ipcMain.handle('config:save', async (event, config) => {
  const configPath = path.join(os.homedir(), '.interview-assistant-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  mainWindow?.webContents.send('config-changed');
  return { success: true };
});

ipcMain.handle('config:load', async () => {
  const configPath = path.join(os.homedir(), '.interview-assistant-config.json');
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  return {};
});

// --- Chat history sync (for downloadable chat) ---
let chatHistoryStore = [];

ipcMain.on('sync-chat-history', (_event, history) => {
  if (Array.isArray(history)) {
    chatHistoryStore = history;
  }
});

ipcMain.handle('get-chat-history', async () => {
  return chatHistoryStore;
});

// --- File save dialog ---
ipcMain.handle('save-file-dialog', async (_event, { defaultName, content }) => {
  const result = await dialog.showSaveDialog(mainWindow || settingsWindow, {
    defaultPath: path.join(os.homedir(), defaultName || 'download.json'),
    filters: [
      { name: 'JSON Files', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }
  fs.writeFileSync(result.filePath, content, 'utf-8');
  return { canceled: false, filePath: result.filePath };
});

// --- Logout state check (prevents auto-login loop after explicit sign-out) ---
ipcMain.handle('auth:isJustLoggedOut', async () => {
  if (justLoggedOut) {
    justLoggedOut = false;
    return true;
  }
  return false;
});
