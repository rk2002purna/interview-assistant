'use strict';

const { ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { getSourcePdfDir } = require('../services/knowledge/knowledgePaths');
const { readStatus, getProgress } = require('../services/knowledge/knowledgeStatusService');
const { rebuildIndex } = require('../services/knowledge/ragIndexingService');
const { answerWithContext } = require('../services/knowledge/ragAnswerService');
const { hasIndex, getIndexStats } = require('../services/knowledge/vectorStoreService');

/**
 * Register all Knowledge Base IPC handlers.
 */
function registerKnowledgeIpc() {
  // Select PDFs via dialog and copy to source-pdfs directory
  ipcMain.handle('knowledge:select-pdfs', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select PDF files for Knowledge Base',
        filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
        properties: ['openFile', 'multiSelections']
      });

      if (result.canceled || !result.filePaths.length) {
        return { success: false, message: 'No files selected', files: [] };
      }

      const pdfDir = getSourcePdfDir();
      const copiedFiles = [];

      for (const srcPath of result.filePaths) {
        const baseName = path.basename(srcPath);
        let destName = baseName;

        // Handle duplicate names with timestamp suffix
        const destPath = path.join(pdfDir, destName);
        if (fs.existsSync(destPath)) {
          const ext = path.extname(baseName);
          const name = path.basename(baseName, ext);
          destName = `${name}_${Date.now()}${ext}`;
        }

        const finalPath = path.join(pdfDir, destName);
        fs.copyFileSync(srcPath, finalPath);
        copiedFiles.push(destName);
        console.log(`[Knowledge] Copied PDF: ${baseName} → ${destName}`);
      }

      console.log(`[Knowledge] ${copiedFiles.length} PDFs selected and copied`);
      return { success: true, message: `${copiedFiles.length} PDFs added`, files: copiedFiles };
    } catch (e) {
      console.log('[Knowledge] Error selecting PDFs:', e.message);
      return { success: false, message: e.message, files: [] };
    }
  });

  // List all PDFs in the source-pdfs directory
  ipcMain.handle('knowledge:list-pdfs', async () => {
    try {
      const pdfDir = getSourcePdfDir();
      const files = fs.readdirSync(pdfDir).filter(f => f.toLowerCase().endsWith('.pdf'));

      const fileDetails = files.map(f => {
        const filePath = path.join(pdfDir, f);
        const stats = fs.statSync(filePath);
        return {
          name: f,
          size: stats.size,
          sizeFormatted: formatFileSize(stats.size),
          addedAt: stats.mtime.toISOString()
        };
      });

      return { success: true, files: fileDetails };
    } catch (e) {
      return { success: true, files: [] };
    }
  });

  // Rebuild the index (full pipeline)
  ipcMain.handle('knowledge:rebuild-index', async () => {
    try {
      console.log('[Knowledge] Rebuild index requested');
      const result = await rebuildIndex();
      return result;
    } catch (e) {
      console.log('[Knowledge] Rebuild error:', e.message);
      return { success: false, message: e.message };
    }
  });

  // Delete the entire knowledge base (PDFs + vector DB + status)
  ipcMain.handle('knowledge:delete', async () => {
    try {
      const pdfDir = getSourcePdfDir();
      const { getVectorDbDir, getKnowledgeBaseRoot } = require('../services/knowledge/knowledgePaths');
      const { clearStatus } = require('../services/knowledge/knowledgeStatusService');
      const { clearVectorStore } = require('../services/knowledge/vectorStoreService');

      // Clear vector store
      try { await clearVectorStore(); } catch (e) { /* best effort */ }

      // Delete PDFs
      const files = fs.readdirSync(pdfDir).filter(f => f.toLowerCase().endsWith('.pdf'));
      for (const f of files) {
        fs.unlinkSync(path.join(pdfDir, f));
      }

      // Clear status
      clearStatus();

      // Remove vectordb directory contents
      const vectorDir = getVectorDbDir();
      if (fs.existsSync(vectorDir)) {
        const entries = fs.readdirSync(vectorDir);
        for (const entry of entries) {
          const entryPath = path.join(vectorDir, entry);
          const stat = fs.statSync(entryPath);
          if (stat.isDirectory()) {
            fs.rmSync(entryPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(entryPath);
          }
        }
      }

      console.log('[Knowledge] Knowledge base deleted');
      return { success: true, message: 'Knowledge base deleted successfully' };
    } catch (e) {
      console.log('[Knowledge] Delete error:', e.message);
      return { success: false, message: e.message };
    }
  });

  // Get status
  ipcMain.handle('knowledge:status', async () => {
    return {
      status: readStatus(),
      progress: getProgress()
    };
  });

  // Get stats (vector store info)
  ipcMain.handle('knowledge:stats', async () => {
    try {
      const status = readStatus();
      const indexStats = await getIndexStats();
      return { ...status, ...indexStats };
    } catch (e) {
      return { exists: false, rowCount: 0, error: e.message };
    }
  });

  // RAG search (called by renderer before sending question to LLM)
  ipcMain.handle('knowledge:rag-search', async (_event, question) => {
    try {
      return await answerWithContext(question);
    } catch (e) {
      console.log('[Knowledge] RAG search IPC error:', e.message);
      return { context: null, sources: [], usedRag: false };
    }
  });

  // Delete a single PDF from the source directory
  ipcMain.handle('knowledge:delete-pdf', async (_event, fileName) => {
    try {
      const pdfDir = getSourcePdfDir();
      const filePath = path.join(pdfDir, fileName);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[Knowledge] Deleted PDF: ${fileName}`);
        return { success: true };
      }
      return { success: false, message: 'File not found' };
    } catch (e) {
      return { success: false, message: e.message };
    }
  });

  console.log('[Knowledge] IPC handlers registered');
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

module.exports = { registerKnowledgeIpc };
