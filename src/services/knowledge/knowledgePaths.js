'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/**
 * Knowledge Base path helpers.
 * All KB data lives under userData/knowledge-base/ so it persists across updates
 * and works identically in dev and packaged .exe.
 */

function getKnowledgeBaseRoot() {
  const root = path.join(app.getPath('userData'), 'knowledge-base');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function getSourcePdfDir() {
  const dir = path.join(getKnowledgeBaseRoot(), 'source-pdfs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getVectorDbDir() {
  const dir = path.join(getKnowledgeBaseRoot(), 'vectordb');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getStatusPath() {
  return path.join(getKnowledgeBaseRoot(), 'status.json');
}

module.exports = {
  getKnowledgeBaseRoot,
  getSourcePdfDir,
  getVectorDbDir,
  getStatusPath
};
