'use strict';

const { ingestAllPdfs } = require('./pdfIngestionService');
const { chunkAllPages } = require('./chunkingService');
const { embedTexts, getModelName } = require('./embeddingService');
const { clearVectorStore, addChunks } = require('./vectorStoreService');
const { getVectorDbDir, getSourcePdfDir } = require('./knowledgePaths');
const { writeStatus, setProgress, resetProgress } = require('./knowledgeStatusService');
const fs = require('fs');

/**
 * Orchestrates the full indexing pipeline:
 * clear → ingest → chunk → embed → store → write status.
 */

/**
 * Run the full RAG indexing pipeline.
 * @returns {Promise<{success: boolean, pdfCount: number, pageCount: number, chunkCount: number, failedFiles: string[], vectorDbPath: string, message: string}>}
 */
async function rebuildIndex() {
  resetProgress();
  setProgress({ phase: 'indexing', message: 'Starting indexing...' });

  try {
    // 1. Check for PDFs
    const pdfDir = getSourcePdfDir();
    const pdfFiles = fs.readdirSync(pdfDir).filter(f => f.toLowerCase().endsWith('.pdf'));

    if (pdfFiles.length === 0) {
      setProgress({ phase: 'error', message: 'No PDFs found. Upload PDFs first.', error: 'No PDFs' });
      return {
        success: false,
        pdfCount: 0,
        pageCount: 0,
        chunkCount: 0,
        failedFiles: [],
        vectorDbPath: getVectorDbDir(),
        message: 'No PDFs found in knowledge base. Please upload PDFs first.'
      };
    }

    setProgress({ phase: 'indexing', message: 'Clearing previous index...', totalPdfs: pdfFiles.length });

    // 2. Clear existing vector store
    await clearVectorStore();
    console.log('[Knowledge] Cleared previous vector store');

    // 3. Ingest PDFs
    setProgress({ phase: 'indexing', message: 'Extracting text from PDFs...' });
    const { pages, failedFiles } = await ingestAllPdfs((fileName, index, total) => {
      setProgress({
        phase: 'indexing',
        message: `Extracting: ${fileName} (${index}/${total})`,
        currentPdf: index,
        totalPdfs: total
      });
    });

    if (pages.length === 0) {
      setProgress({ phase: 'error', message: 'No text extracted from PDFs.', error: 'Empty extraction' });
      return {
        success: false,
        pdfCount: pdfFiles.length,
        pageCount: 0,
        chunkCount: 0,
        failedFiles,
        vectorDbPath: getVectorDbDir(),
        message: 'No text could be extracted from the uploaded PDFs.'
      };
    }

    // 4. Chunk pages
    setProgress({ phase: 'indexing', message: 'Chunking text...' });
    const chunks = chunkAllPages(pages);
    setProgress({ phase: 'indexing', message: `Created ${chunks.length} chunks`, chunksCreated: chunks.length });
    console.log(`[Knowledge] Created ${chunks.length} chunks`);

    // 5. Embed chunks
    setProgress({ phase: 'indexing', message: 'Generating embeddings...' });
    console.log('[Knowledge] Embedding start');
    const texts = chunks.map(c => c.text);
    const embeddings = await embedTexts(texts, (batchIdx, totalBatches) => {
      setProgress({
        phase: 'indexing',
        message: `Embedding batch ${batchIdx}/${totalBatches}...`
      });
    });
    console.log('[Knowledge] Embedding done');

    // 6. Store in vector DB
    setProgress({ phase: 'indexing', message: 'Storing in vector database...' });
    const records = chunks.map((chunk, i) => ({
      ...chunk,
      embedding: embeddings[i]
    }));
    await addChunks(records);
    console.log('[Knowledge] Vector DB write complete');

    // 7. Write status
    const status = {
      indexed: true,
      lastIndexedAt: new Date().toISOString(),
      pdfCount: pdfFiles.length - failedFiles.length,
      pageCount: pages.length,
      chunkCount: chunks.length,
      embeddingModel: getModelName(),
      vectorDbPath: getVectorDbDir(),
      failedFiles,
      error: null
    };
    writeStatus(status);

    setProgress({ phase: 'ready', message: `Index ready: ${chunks.length} chunks from ${pdfFiles.length - failedFiles.length} PDFs`, chunksCreated: chunks.length });

    return {
      success: true,
      pdfCount: pdfFiles.length - failedFiles.length,
      pageCount: pages.length,
      chunkCount: chunks.length,
      failedFiles,
      vectorDbPath: getVectorDbDir(),
      message: `Successfully indexed ${chunks.length} chunks from ${pdfFiles.length - failedFiles.length} PDFs.`
    };

  } catch (e) {
    console.log('[Knowledge] Indexing error:', e.message);
    setProgress({ phase: 'error', message: `Indexing failed: ${e.message}`, error: e.message });

    writeStatus({
      indexed: false,
      lastIndexedAt: null,
      pdfCount: 0,
      pageCount: 0,
      chunkCount: 0,
      embeddingModel: getModelName(),
      vectorDbPath: getVectorDbDir(),
      failedFiles: [],
      error: e.message
    });

    return {
      success: false,
      pdfCount: 0,
      pageCount: 0,
      chunkCount: 0,
      failedFiles: [],
      vectorDbPath: getVectorDbDir(),
      message: `Indexing failed: ${e.message}`
    };
  }
}

module.exports = { rebuildIndex };
