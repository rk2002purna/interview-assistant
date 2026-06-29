'use strict';

const fs = require('fs');
const { getStatusPath } = require('./knowledgePaths');

/**
 * Manages knowledge base status persistence and in-memory progress state.
 */

// In-memory progress for UI polling
let progressState = {
  phase: 'idle', // idle | indexing | ready | error
  message: '',
  currentPdf: 0,
  totalPdfs: 0,
  chunksCreated: 0,
  error: null
};

function getDefaultStatus() {
  return {
    indexed: false,
    lastIndexedAt: null,
    pdfCount: 0,
    pageCount: 0,
    chunkCount: 0,
    embeddingModel: null,
    vectorDbPath: null,
    failedFiles: [],
    error: null
  };
}

function readStatus() {
  try {
    const statusPath = getStatusPath();
    if (fs.existsSync(statusPath)) {
      return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    }
  } catch (e) {
    console.log('[Knowledge] Error reading status.json:', e.message);
  }
  return getDefaultStatus();
}

function writeStatus(status) {
  try {
    const statusPath = getStatusPath();
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2), 'utf8');
  } catch (e) {
    console.log('[Knowledge] Error writing status.json:', e.message);
  }
}

function clearStatus() {
  writeStatus(getDefaultStatus());
}

function getProgress() {
  return { ...progressState };
}

function setProgress(update) {
  progressState = { ...progressState, ...update };
}

function resetProgress() {
  progressState = {
    phase: 'idle',
    message: '',
    currentPdf: 0,
    totalPdfs: 0,
    chunksCreated: 0,
    error: null
  };
}

module.exports = {
  readStatus,
  writeStatus,
  clearStatus,
  getProgress,
  setProgress,
  resetProgress,
  getDefaultStatus
};
