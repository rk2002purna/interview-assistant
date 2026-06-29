'use strict';

const { embedQuery } = require('./embeddingService');
const { searchSimilar, hasIndex } = require('./vectorStoreService');

/**
 * RAG answer service.
 * Embeds the question, searches top-K chunks, formats context for the LLM.
 * Does NOT call the LLM — returns formatted context for injection into the system prompt.
 */

const MAX_CONTEXT_CHARS = 8000;
const TOP_K = 5;

/**
 * Search the knowledge base for relevant context.
 * @param {string} question - the user's question
 * @returns {Promise<{context: string|null, sources: Array<{sourceFile: string, pageNumber: number, score: number}>, usedRag: boolean}>}
 */
async function answerWithContext(question) {
  try {
    // Check if index exists
    const indexExists = await hasIndex();
    if (!indexExists) {
      console.log('[Knowledge] No index available, skipping RAG');
      return { context: null, sources: [], usedRag: false };
    }

    // Embed the question
    console.log(`[Knowledge] Retrieval query: "${question.substring(0, 80)}..."`);
    const queryVector = await embedQuery(question);

    // Search for similar chunks
    const results = await searchSimilar(queryVector, TOP_K);

    if (!results || results.length === 0) {
      console.log('[Knowledge] No relevant chunks found');
      return { context: null, sources: [], usedRag: false };
    }

    console.log(`[Knowledge] Retrieved ${results.length} chunks`);

    // Format context with source separators, respecting max chars
    let context = '';
    const sources = [];
    let charCount = 0;

    for (const chunk of results) {
      const chunkBlock = `--- Source: ${chunk.source_file} | Page ${chunk.page_number} ---\n${chunk.text}\n\n`;

      if (charCount + chunkBlock.length > MAX_CONTEXT_CHARS) break;

      context += chunkBlock;
      charCount += chunkBlock.length;
      sources.push({
        sourceFile: chunk.source_file,
        pageNumber: chunk.page_number,
        score: chunk.score
      });
    }

    if (!context.trim()) {
      return { context: null, sources: [], usedRag: false };
    }

    console.log(`[Knowledge] Context prepared: ${sources.length} sources, ${charCount} chars`);
    return { context: context.trim(), sources, usedRag: true };

  } catch (e) {
    console.log(`[Knowledge] RAG search error: ${e.message}`);
    // Fail silently — fall back to normal LLM flow
    return { context: null, sources: [], usedRag: false };
  }
}

module.exports = { answerWithContext };
