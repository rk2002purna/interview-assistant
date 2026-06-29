'use strict';

const path = require('path');
const fs = require('fs');
const { getVectorDbDir } = require('./knowledgePaths');
const { EMBEDDING_DIM } = require('./embeddingService');

/**
 * LanceDB-based local vector store service.
 * Stores embedded chunks and supports similarity search.
 */

const TABLE_NAME = 'knowledge_chunks';
let db = null;
let table = null;

/**
 * Initialize the vector store (open or create the LanceDB database).
 */
async function initializeVectorStore() {
  const lancedb = require('@lancedb/lancedb');
  const dbDir = getVectorDbDir();
  console.log(`[Knowledge] Initializing vector store at: ${dbDir}`);

  db = await lancedb.connect(dbDir);
  
  // Check if table exists
  const tables = await db.tableNames();
  if (tables.includes(TABLE_NAME)) {
    table = await db.openTable(TABLE_NAME);
    console.log('[Knowledge] Opened existing vector table');
  } else {
    table = null;
    console.log('[Knowledge] No existing vector table found');
  }

  return db;
}

/**
 * Clear the vector store (drop table if exists).
 */
async function clearVectorStore() {
  if (!db) await initializeVectorStore();

  const tables = await db.tableNames();
  if (tables.includes(TABLE_NAME)) {
    await db.dropTable(TABLE_NAME);
    console.log('[Knowledge] Dropped existing vector table');
  }
  table = null;
}

/**
 * Add chunks with embeddings to the vector store.
 * @param {Array<{id: string, text: string, sourceFile: string, pageNumber: number, chunkIndex: number, embedding: number[]}>} records
 */
async function addChunks(records) {
  if (!db) await initializeVectorStore();
  if (!records.length) return;

  const data = records.map(r => ({
    id: r.id,
    text: r.text,
    source_file: r.sourceFile,
    page_number: r.pageNumber,
    chunk_index: r.chunkIndex,
    created_at: new Date().toISOString(),
    vector: r.embedding
  }));

  // Create new table with data
  table = await db.createTable(TABLE_NAME, data, { mode: 'overwrite' });
  console.log(`[Knowledge] Added ${records.length} chunks to vector store`);
}

/**
 * Search for similar chunks using a query vector.
 * @param {number[]} queryVector - the query embedding
 * @param {number} [topK=5] - number of results
 * @returns {Promise<Array<{id: string, text: string, source_file: string, page_number: number, score: number}>>}
 */
async function searchSimilar(queryVector, topK = 5) {
  if (!table) {
    if (!db) await initializeVectorStore();
    if (!table) return []; // no index built yet
  }

  const results = await table.search(queryVector).limit(topK).toArray();

  return results.map(r => ({
    id: r.id,
    text: r.text,
    source_file: r.source_file,
    page_number: r.page_number,
    chunk_index: r.chunk_index,
    score: r._distance != null ? (1 - r._distance) : 0 // convert distance to similarity
  }));
}

/**
 * Check if an index exists and has data.
 */
async function hasIndex() {
  try {
    if (!db) await initializeVectorStore();
    const tables = await db.tableNames();
    if (!tables.includes(TABLE_NAME)) return false;
    if (!table) table = await db.openTable(TABLE_NAME);
    const count = await table.countRows();
    return count > 0;
  } catch (e) {
    return false;
  }
}

/**
 * Get stats about the index.
 */
async function getIndexStats() {
  try {
    if (!db) await initializeVectorStore();
    if (!table) {
      const tables = await db.tableNames();
      if (tables.includes(TABLE_NAME)) {
        table = await db.openTable(TABLE_NAME);
      } else {
        return { exists: false, rowCount: 0 };
      }
    }
    const count = await table.countRows();
    return { exists: true, rowCount: count };
  } catch (e) {
    return { exists: false, rowCount: 0, error: e.message };
  }
}

module.exports = {
  initializeVectorStore,
  clearVectorStore,
  addChunks,
  searchSimilar,
  hasIndex,
  getIndexStats
};
