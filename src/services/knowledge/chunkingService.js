'use strict';

/**
 * Sentence-aware text chunking service.
 * Splits extracted PDF text into overlapping chunks suitable for embedding.
 */

const CHUNK_SIZE = 2500;   // ~2500 chars per chunk
const CHUNK_OVERLAP = 500; // ~500 chars overlap

/**
 * Split text into sentences (rough heuristic for English technical docs).
 */
function splitSentences(text) {
  // Split on sentence-ending punctuation followed by space or newline
  return text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
}

/**
 * Chunk a single page's text with overlap.
 * @param {string} text - page text
 * @param {string} sourceFile - file name
 * @param {number} pageNumber - page number
 * @param {number} startIndex - starting chunk index offset
 * @returns {Array<{id: string, text: string, sourceFile: string, pageNumber: number, chunkIndex: number}>}
 */
function chunkText(text, sourceFile, pageNumber, startIndex) {
  const chunks = [];
  // Clean up whitespace
  const cleaned = text.replace(/\s+/g, ' ').trim();

  if (cleaned.length <= CHUNK_SIZE) {
    chunks.push({
      id: `${sourceFile}_p${pageNumber}_c${startIndex}`,
      text: cleaned,
      sourceFile,
      pageNumber,
      chunkIndex: startIndex
    });
    return chunks;
  }

  const sentences = splitSentences(cleaned);
  let currentChunk = '';
  let chunkIdx = startIndex;

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];

    if (currentChunk.length + sentence.length + 1 > CHUNK_SIZE && currentChunk.length > 0) {
      chunks.push({
        id: `${sourceFile}_p${pageNumber}_c${chunkIdx}`,
        text: currentChunk.trim(),
        sourceFile,
        pageNumber,
        chunkIndex: chunkIdx
      });
      chunkIdx++;

      // Overlap: keep the tail of the current chunk
      const overlapStart = Math.max(0, currentChunk.length - CHUNK_OVERLAP);
      currentChunk = currentChunk.slice(overlapStart) + ' ' + sentence;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + sentence;
    }
  }

  // Flush remaining
  if (currentChunk.trim().length > 0) {
    chunks.push({
      id: `${sourceFile}_p${pageNumber}_c${chunkIdx}`,
      text: currentChunk.trim(),
      sourceFile,
      pageNumber,
      chunkIndex: chunkIdx
    });
  }

  return chunks;
}

/**
 * Chunk all pages into embedding-ready chunks.
 * @param {Array<{fileName: string, pageNumber: number, text: string}>} pages
 * @returns {Array<{id: string, text: string, sourceFile: string, pageNumber: number, chunkIndex: number}>}
 */
function chunkAllPages(pages) {
  const allChunks = [];
  let globalIdx = 0;

  for (const page of pages) {
    const chunks = chunkText(page.text, page.fileName, page.pageNumber, globalIdx);
    allChunks.push(...chunks);
    globalIdx += chunks.length;
  }

  console.log(`[Knowledge] Chunking complete: ${allChunks.length} chunks from ${pages.length} pages`);
  return allChunks;
}

module.exports = {
  chunkText,
  chunkAllPages,
  CHUNK_SIZE,
  CHUNK_OVERLAP
};
