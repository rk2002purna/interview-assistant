'use strict';

const path = require('path');

/**
 * Local embedding service — runs entirely on-device, no API key, no network
 * (after the model is downloaded and cached once).
 *
 * Uses Transformers.js (@xenova/transformers) with the all-MiniLM-L6-v2 model,
 * which produces 384-dimensional sentence embeddings. The model is downloaded
 * from the Hugging Face hub on first use and cached under userData so it works
 * offline afterwards and survives app updates.
 *
 * Interface is unchanged from the previous API-based version so the rest of the
 * pipeline (chunking, vector store, retrieval) needs no changes.
 */

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;
const BATCH_SIZE = 32;

let _extractorPromise = null;

/**
 * Resolve a writable cache directory for the model files.
 */
function getModelCacheDir() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'knowledge-base', 'models');
  } catch (_e) {
    // Fallback when not running inside Electron (e.g. unit tests)
    return path.join(__dirname, '..', '..', '..', '.model-cache');
  }
}

/**
 * Lazily load the feature-extraction pipeline. Transformers.js is ESM-only,
 * so we load it via dynamic import() from this CommonJS module.
 */
async function getExtractor() {
  if (!_extractorPromise) {
    _extractorPromise = (async () => {
      const transformers = await import('@xenova/transformers');
      const { pipeline, env } = transformers;

      // Cache models in a writable userData location (not inside asar).
      env.cacheDir = getModelCacheDir();
      // Allow downloading from the HF hub on first run; cached thereafter.
      env.allowRemoteModels = true;

      console.log(`[Knowledge] Loading local embedding model: ${MODEL_NAME}`);
      console.log(`[Knowledge] Model cache dir: ${env.cacheDir}`);

      const extractor = await pipeline('feature-extraction', MODEL_NAME);
      console.log('[Knowledge] Local embedding model ready');
      return extractor;
    })();
  }
  return _extractorPromise;
}

/**
 * Embed an array of texts in batches.
 * @param {string[]} texts - texts to embed
 * @param {function} [onProgress] - callback(batchIndex, totalBatches)
 * @returns {Promise<number[][]>} - embedding vectors
 */
async function embedTexts(texts, onProgress) {
  if (!texts.length) return [];

  const extractor = await getExtractor();
  console.log(`[Knowledge] Embedding ${texts.length} texts locally in batches of ${BATCH_SIZE}...`);

  const allEmbeddings = [];
  const totalBatches = Math.ceil(texts.length / BATCH_SIZE);

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    if (onProgress) onProgress(Math.floor(i / BATCH_SIZE) + 1, totalBatches);

    // Mean pooling + L2 normalization yields sentence embeddings.
    const output = await extractor(batch, { pooling: 'mean', normalize: true });

    // output is a Tensor of shape [batch, 384]; convert to nested arrays.
    const list = output.tolist();
    allEmbeddings.push(...list);
  }

  console.log(`[Knowledge] Embedding complete: ${allEmbeddings.length} vectors (${EMBEDDING_DIM}-dim)`);
  return allEmbeddings;
}

/**
 * Embed a single query text.
 * @param {string} text - query text
 * @returns {Promise<number[]>} - single embedding vector
 */
async function embedQuery(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return output.tolist()[0];
}

/**
 * Get the current model name (stored in status.json for re-index detection).
 */
function getModelName() {
  return MODEL_NAME;
}

/**
 * Get embedding config.
 */
function getEmbeddingConfig() {
  return {
    model: MODEL_NAME,
    dim: EMBEDDING_DIM,
    provider: 'local'
  };
}

module.exports = {
  embedTexts,
  embedQuery,
  getModelName,
  getEmbeddingConfig,
  EMBEDDING_DIM
};
