const { app, BrowserWindow, ipcMain, desktopCapturer, systemPreferences, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');
const { readActiveWindowText } = require('./screen-reader');

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

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

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
    height: 500,
    title: 'Settings',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWindow.on('closed', () => settingsWindow = null);
}

app.whenReady().then(() => { createMainWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });

ipcMain.on('open-settings', () => createSettingsWindow());
ipcMain.on('minimize-window', () => mainWindow?.minimize());
ipcMain.on('close-app', () => app.quit());

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

ipcMain.handle('call-ai-api', async (event, { apiKey, model, messages, systemPrompt }) => {
  const allMessages = [];
  if (systemPrompt) {
    allMessages.push({ role: 'system', content: systemPrompt });
  }
  allMessages.push(...messages);

  const requestBody = {
    model: model,
    max_tokens: 1024,
    temperature: 0.7,
    messages: allMessages
  };

  const body = JSON.stringify(requestBody);
  const bodyBuffer = Buffer.from(body);

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.groq.com',
      port: 443,
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': bodyBuffer.length
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            resolve({ error: { message: json.error.message } });
          } else if (json.choices && json.choices[0] && json.choices[0].message) {
            resolve({ content: [{ text: json.choices[0].message.content }] });
          } else {
            resolve({ error: { message: 'Unexpected response' } });
          }
        } catch (e) {
          resolve({ error: { message: 'Parse error' } });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ error: { message: 'Network error: ' + e.message } });
    });

    req.setTimeout(30000, () => {
      req.destroy();
      resolve({ error: { message: 'Request timed out' } });
    });

    req.write(bodyBuffer);
    req.end();
  });
});

ipcMain.handle('call-deepseek-api', async (event, { apiKey, model, messages, systemPrompt }) => {
  const allMessages = [];
  if (systemPrompt) {
    allMessages.push({ role: 'system', content: systemPrompt });
  }
  allMessages.push(...messages);

  const requestBody = {
    model: model,
    max_tokens: 1024,
    temperature: 0.7,
    messages: allMessages
  };

  const body = JSON.stringify(requestBody);
  const bodyBuffer = Buffer.from(body);

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.deepseek.com',
      port: 443,
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': bodyBuffer.length
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            resolve({ error: { message: json.error.message } });
          } else if (json.choices && json.choices[0] && json.choices[0].message) {
            resolve({ content: [{ text: json.choices[0].message.content }] });
          } else {
            resolve({ error: { message: 'Unexpected response' } });
          }
        } catch (e) {
          resolve({ error: { message: 'Parse error' } });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ error: { message: 'Network error: ' + e.message } });
    });

    req.setTimeout(30000, () => {
      req.destroy();
      resolve({ error: { message: 'Request timed out' } });
    });

    req.write(bodyBuffer);
    req.end();
  });
});

// Helper: convert OpenAI-style messages to Gemini "contents" format
function messagesToGeminiContents(messages) {
  const contents = [];
  for (const m of messages) {
    if (!m || !m.content) continue;
    // Gemini uses 'user' and 'model' roles (not 'assistant')
    const role = m.role === 'assistant' ? 'model' : 'user';
    let parts;
    if (typeof m.content === 'string') {
      parts = [{ text: m.content }];
    } else if (Array.isArray(m.content)) {
      // Multimodal content array (text + images)
      parts = m.content.map(p => {
        if (p.type === 'text') return { text: p.text };
        if (p.type === 'image_url' && p.image_url && p.image_url.url) {
          // Convert "data:image/jpeg;base64,XXX" to inline_data
          const match = /^data:([^;]+);base64,(.+)$/.exec(p.image_url.url);
          if (match) {
            return { inline_data: { mime_type: match[1], data: match[2] } };
          }
        }
        return { text: '' };
      }).filter(p => p);
    } else {
      parts = [{ text: String(m.content) }];
    }
    contents.push({ role, parts });
  }
  return contents;
}

ipcMain.handle('call-gemini-api', async (event, { apiKey, model, messages, systemPrompt }) => {
  const requestBody = {
    contents: messagesToGeminiContents(messages),
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024
    }
  };
  if (systemPrompt) {
    requestBody.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  const body = JSON.stringify(requestBody);
  const bodyBuffer = Buffer.from(body);

  return new Promise((resolve) => {
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      port: 443,
      path: `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': apiKey,
        'Content-Length': bodyBuffer.length
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            resolve({ error: { message: 'Gemini ' + (res.statusCode || '?') + ': ' + (json.error.message || JSON.stringify(json.error)) } });
          } else if (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) {
            const text = json.candidates[0].content.parts.map(p => p.text || '').join('');
            resolve({ content: [{ text: text }] });
          } else if (json.promptFeedback && json.promptFeedback.blockReason) {
            resolve({ error: { message: 'Blocked by Gemini: ' + json.promptFeedback.blockReason } });
          } else {
            resolve({ error: { message: 'Gemini ' + (res.statusCode || '?') + ' unexpected response: ' + data.substring(0, 300) } });
          }
        } catch (e) {
          resolve({ error: { message: 'Gemini ' + (res.statusCode || '?') + ' parse error: ' + data.substring(0, 300) } });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ error: { message: 'Network error: ' + e.message } });
    });

    req.setTimeout(30000, () => {
      req.destroy();
      resolve({ error: { message: 'Request timed out' } });
    });

    req.write(bodyBuffer);
    req.end();
  });
});

// Streaming AI handler - emits tokens to renderer as they arrive
ipcMain.handle('call-ai-stream', async (event, { provider, apiKey, model, messages, systemPrompt, streamId }) => {
  const sender = event.sender;

  // Gemini has its own streaming format
  if (provider === 'gemini') {
    const requestBody = {
      contents: messagesToGeminiContents(messages),
      generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
    };
    if (systemPrompt) {
      requestBody.systemInstruction = { parts: [{ text: systemPrompt }] };
    }

    const body = JSON.stringify(requestBody);
    const bodyBuffer = Buffer.from(body);

    return new Promise((resolve) => {
      const options = {
        hostname: 'generativelanguage.googleapis.com',
        port: 443,
        path: `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': apiKey,
          'Content-Length': bodyBuffer.length
        }
      };

      const req = https.request(options, (res) => {
        let buffer = '';
        let fullText = '';
        let errorMsg = null;
        let rawData = ''; // accumulate raw response for error reporting

        res.on('data', chunk => {
          const text = chunk.toString('utf8');
          rawData += text;
          buffer += text;
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (!data) continue;
            try {
              const json = JSON.parse(data);
              if (json.error) {
                errorMsg = json.error.message || JSON.stringify(json.error);
                continue;
              }
              if (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) {
                for (const part of json.candidates[0].content.parts) {
                  if (part.text) {
                    fullText += part.text;
                    sender.send('ai-stream-chunk', { streamId: streamId, delta: part.text });
                  }
                }
              }
            } catch (e) {
              // ignore parse errors on partial chunks
            }
          }
        });

        res.on('end', () => {
          if (errorMsg) {
            resolve({ error: { message: 'Gemini ' + (res.statusCode || '?') + ': ' + errorMsg } });
          } else if (res.statusCode && res.statusCode >= 400) {
            // Non-200 status with no streamed error — try parsing raw body
            let parsedErr = rawData.substring(0, 300);
            try {
              const json = JSON.parse(rawData);
              if (json.error && json.error.message) parsedErr = json.error.message;
            } catch(e) {}
            resolve({ error: { message: 'Gemini ' + res.statusCode + ': ' + parsedErr } });
          } else if (!fullText) {
            resolve({ error: { message: 'Gemini returned empty response: ' + rawData.substring(0, 300) } });
          } else {
            resolve({ content: [{ text: fullText }] });
          }
        });
      });

      req.on('error', (e) => {
        resolve({ error: { message: 'Network error: ' + e.message } });
      });

      req.setTimeout(30000, () => {
        req.destroy();
        resolve({ error: { message: 'Request timed out' } });
      });

      req.write(bodyBuffer);
      req.end();
    });
  }

  // Groq + DeepSeek (OpenAI-compatible streaming)
  const allMessages = [];
  if (systemPrompt) {
    allMessages.push({ role: 'system', content: systemPrompt });
  }
  allMessages.push(...messages);

  const requestBody = {
    model: model,
    max_tokens: 1024,
    temperature: 0.7,
    messages: allMessages,
    stream: true
  };

  const body = JSON.stringify(requestBody);
  const bodyBuffer = Buffer.from(body);

  const isDeepseek = provider === 'deepseek';
  const hostname = isDeepseek ? 'api.deepseek.com' : 'api.groq.com';
  const path = isDeepseek ? '/chat/completions' : '/openai/v1/chat/completions';

  return new Promise((resolve) => {
    const options = {
      hostname: hostname,
      port: 443,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': bodyBuffer.length
      }
    };

    const req = https.request(options, (res) => {
      let buffer = '';
      let fullText = '';
      let errorMsg = null;

      res.on('data', chunk => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop(); // last line may be incomplete

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            if (json.error) {
              errorMsg = json.error.message || 'API error';
              continue;
            }
            const delta = json.choices && json.choices[0] && json.choices[0].delta;
            if (delta && delta.content) {
              fullText += delta.content;
              sender.send('ai-stream-chunk', { streamId: streamId, delta: delta.content });
            }
          } catch (e) {
            // ignore parse errors on partial chunks
          }
        }
      });

      res.on('end', () => {
        if (errorMsg) {
          resolve({ error: { message: errorMsg } });
        } else {
          resolve({ content: [{ text: fullText }] });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ error: { message: 'Network error: ' + e.message } });
    });

    req.setTimeout(30000, () => {
      req.destroy();
      resolve({ error: { message: 'Request timed out' } });
    });

    req.write(bodyBuffer);
    req.end();
  });
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

ipcMain.handle('transcribe-audio', async (event, { apiKey, audioData }) => {
  const tempPath = path.join(os.tmpdir(), 'interview-audio-' + Date.now() + '.webm');

  try {
    const audioBuffer = Buffer.from(audioData, 'base64');
    fs.writeFileSync(tempPath, audioBuffer);

    return new Promise((resolve) => {
      const curl = spawn('curl', [
        '-s', 'https://api.groq.com/openai/v1/audio/transcriptions',
        '-X', 'POST',
        '-H', `Authorization: Bearer ${apiKey}`,
        '-F', `file=@${tempPath}`,
        '-F', 'model=whisper-large-v3',
        '-F', 'response_format=json',
        '-F', 'language=en',
        '-F', 'temperature=0',
        '-F', 'prompt=Technical interview question about software engineering, coding, or behavioral topics.'
      ]);

      let data = '';
      let errorData = '';

      curl.stdout.on('data', (chunk) => { data += chunk; });
      curl.stderr.on('data', (chunk) => { errorData += chunk; });

      curl.on('close', (code) => {
        try { fs.unlinkSync(tempPath); } catch(e) {}

        if (code !== 0) {
          resolve({ error: { message: 'Transcription failed' } });
          return;
        }

        try {
          const json = JSON.parse(data);
          if (json.error) {
            resolve({ error: { message: json.error.message } });
          } else {
            resolve({ text: json.text });
          }
        } catch (e) {
          resolve({ error: { message: 'Parse error' } });
        }
      });
    });
  } catch (e) {
    try { fs.unlinkSync(tempPath); } catch(e) {}
    return { error: { message: 'Failed to process audio' } };
  }
});
