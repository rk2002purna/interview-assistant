'use strict';

const fs = require('fs');
const path = require('path');
const { getSourcePdfDir } = require('./knowledgePaths');

/**
 * PDF text extraction using pdfjs-dist.
 * Extracts text per page, skips empty pages, handles corrupt files gracefully.
 */

let _pdfLibPromise = null;

async function getPdfLib() {
  // pdfjs-dist v4 is ESM-only (ships .mjs, no CommonJS build), so we load it
  // via dynamic import() from this CommonJS module. The legacy build is the
  // most compatible with the Node/Electron main process. Cached after first load.
  if (!_pdfLibPromise) {
    _pdfLibPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
      .then((mod) => mod.default || mod);
  }
  return _pdfLibPromise;
}

/**
 * Extract text from a single PDF file.
 * @param {string} filePath - absolute path to the PDF
 * @returns {Promise<Array<{fileName: string, pageNumber: number, text: string}>>}
 */
async function extractTextFromPdf(filePath) {
  const pdfjsLib = await getPdfLib();
  const fileName = path.basename(filePath);
  const pages = [];

  try {
    const data = new Uint8Array(fs.readFileSync(filePath));
    const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
    const numPages = doc.numPages;

    console.log(`[Knowledge] Extracting PDF: ${fileName} (${numPages} pages)`);

    for (let i = 1; i <= numPages; i++) {
      try {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const text = content.items.map(item => item.str).join(' ').trim();

        if (text.length > 10) { // skip near-empty pages
          pages.push({ fileName, pageNumber: i, text });
        }
      } catch (pageErr) {
        console.log(`[Knowledge] Error on page ${i} of ${fileName}: ${pageErr.message}`);
      }
    }

    console.log(`[Knowledge] Extracted ${pages.length} pages, ${pages.reduce((s, p) => s + p.text.length, 0)} chars from ${fileName}`);
  } catch (e) {
    console.log(`[Knowledge] Failed to extract PDF ${fileName}: ${e.message}`);
    console.log(e.stack);
    throw e;
  }

  return pages;
}

/**
 * Ingest all PDFs from the source-pdfs directory.
 * @param {function} [onProgress] - callback(fileName, index, total)
 * @returns {Promise<{pages: Array, failedFiles: string[]}>}
 */
async function ingestAllPdfs(onProgress) {
  const pdfDir = getSourcePdfDir();
  const files = fs.readdirSync(pdfDir).filter(f => f.toLowerCase().endsWith('.pdf'));

  if (files.length === 0) {
    console.log('[Knowledge] No PDFs found in source-pdfs directory');
    return { pages: [], failedFiles: [] };
  }

  console.log(`[Knowledge] Ingesting ${files.length} PDFs...`);
  const allPages = [];
  const failedFiles = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (onProgress) onProgress(file, i + 1, files.length);

    try {
      const pages = await extractTextFromPdf(path.join(pdfDir, file));
      allPages.push(...pages);
    } catch (e) {
      failedFiles.push(file);
    }
  }

  console.log(`[Knowledge] Ingestion complete: ${allPages.length} pages from ${files.length - failedFiles.length} PDFs`);
  return { pages: allPages, failedFiles };
}

module.exports = {
  extractTextFromPdf,
  ingestAllPdfs
};
