const { contextBridge, ipcRenderer } = require('electron');

// =============================================================================
// Legacy exposure — kept for one release cycle for backward compatibility.
// TODO: Remove after next release.
// =============================================================================
window.ipcRenderer = ipcRenderer;

// =============================================================================
// New namespaced API (Requirement 3.4)
// Exposes auth, entitlement, session, purchase, ai, config namespaces.
// Uses contextBridge when contextIsolation is enabled; falls back to direct
// window assignment when contextIsolation is disabled (current configuration).
// =============================================================================
const interviewAssistantApi = {
  // ── Auth namespace ──────────────────────────────────────────────────────────
  auth: {
    register: (params) => ipcRenderer.invoke('auth:register', params),
    login: (params) => ipcRenderer.invoke('auth:login', params),
    logout: () => ipcRenderer.invoke('auth:logout'),
    getCurrentUser: () => ipcRenderer.invoke('auth:getCurrentUser'),
    onAuthChanged: (handler) => {
      const listener = (_event, state) => handler(state);
      ipcRenderer.on('auth:changed', listener);
      return () => ipcRenderer.removeListener('auth:changed', listener);
    },
  },

  // ── Entitlement namespace ───────────────────────────────────────────────────
  entitlement: {
    get: () => ipcRenderer.invoke('entitlement:get'),
    onChanged: (handler) => {
      const listener = (_event, data) => handler(data);
      ipcRenderer.on('entitlement:changed', listener);
      return () => ipcRenderer.removeListener('entitlement:changed', listener);
    },
  },

  // ── Session namespace ───────────────────────────────────────────────────────
  session: {
    start: () => ipcRenderer.invoke('session:start'),
    end: () => ipcRenderer.invoke('session:end'),
    extend: () => ipcRenderer.invoke('session:extend'),
    getActive: () => ipcRenderer.invoke('session:getActive'),
    onStateChanged: (handler) => {
      const listener = (_event, state) => handler(state);
      ipcRenderer.on('session:stateChanged', listener);
      return () => ipcRenderer.removeListener('session:stateChanged', listener);
    },
  },

  // ── Purchase namespace ──────────────────────────────────────────────────────
  purchase: {
    listPacks: () => ipcRenderer.invoke('purchase:listPacks'),
    checkout: (packSlug) => ipcRenderer.invoke('purchase:checkout', packSlug),
    listMine: () => ipcRenderer.invoke('purchase:listMine'),
  },

  // ── AI namespace ────────────────────────────────────────────────────────────
  ai: {
    callText: (params) => ipcRenderer.invoke('ai:callText', params),
    callVision: (params) => ipcRenderer.invoke('ai:callVision', params),
    transcribeAudio: (params) => ipcRenderer.invoke('ai:transcribeAudio', params),
    onStreamChunk: (handler) => {
      const listener = (_event, chunk) => handler(chunk);
      ipcRenderer.on('ai:streamChunk', listener);
      return () => ipcRenderer.removeListener('ai:streamChunk', listener);
    },
  },

  // ── Config namespace ────────────────────────────────────────────────────────
  config: {
    save: (params) => ipcRenderer.invoke('config:save', params),
    load: () => ipcRenderer.invoke('config:load'),
  },
};

// Expose via contextBridge if context isolation is enabled, otherwise assign
// directly to window (current app uses contextIsolation: false).
try {
  contextBridge.exposeInMainWorld('interviewAssistantApi', interviewAssistantApi);
} catch (_err) {
  // contextIsolation is disabled — assign directly to window
  window.interviewAssistantApi = interviewAssistantApi;
}
