# Implementation Plan: Screen Analyzer

## Overview

This implementation plan breaks down the Screen Analyzer feature into incremental coding tasks. The feature adds a third operational mode to the Interview Assistant that captures the screen periodically, extracts text via OCR (Tesseract.js), detects questions/problems using pattern matching, and sends them to the Groq AI for automatic answering. Tasks are ordered to build foundational components first, then wire them together into the full pipeline.

## Tasks

- [ ] 1. Install dependencies and set up project structure
  - [ ] 1.1 Add `tesseract.js` (v5.x) to the project dependencies in `package.json` and run `npm install`
    - Verify the package is available by checking `node_modules/tesseract.js` exists
    - _Requirements: 3.1_

- [ ] 2. Add Screen Capture IPC Handlers (Main Process)
  - [ ] 2.1 Implement `capture-screen-frame` IPC handle in `src/main.js`
    - Add `desktopCapturer` import from Electron
    - Implement single-shot screen capture that returns base64 JPEG image data
    - If `desktopCapturer.getSources` returns empty, reply with error object `{ error: 'No screen source available' }`
    - _Requirements: 2.1, 2.2, 2.4_
  - [ ] 2.2 Implement `start-screen-capture` and `stop-screen-capture` IPC handlers in `src/main.js`
    - `start-screen-capture`: begins periodic screen capture using `setInterval` and sends frame data via IPC
    - `stop-screen-capture`: clears the capture interval timer and releases resources
    - _Requirements: 2.1, 2.3, 10.3_
  - [ ] 2.3 Add `screen-capture-interval` config support in the `load-config` handler
    - Default value: 3000ms
    - Clamp to range [1000, 10000] ms
    - _Requirements: 9.1, 9.2_

- [ ] 3. Implement Text Extraction Module (Renderer)
  - [ ] 3.1 Create `createOCRWorker()` and `extractText(base64Image)` functions in the renderer script
    - Initialize a Tesseract.js worker with English language on activation
    - `extractText` feeds a base64 image to the worker and returns extracted text string
    - Add 5-second timeout for OCR processing — if exceeded, reject and skip the frame
    - _Requirements: 3.1, 3.2, 10.2_
  - [ ] 3.2 Add OCR worker lifecycle management
    - Initialize worker on Screen Analyzer activation
    - Terminate worker on deactivation
    - _Requirements: 10.1, 10.3_

- [ ] 4. Implement Content Diff Engine (Renderer)
  - [ ] 4.1 Implement `textSimilarity(a, b)` function
    - Compute similarity ratio between two strings, returning a value in [0.0, 1.0]
    - Use chunk-based substring matching for performance
    - _Requirements: 3.3, 8.1_
  - [ ] 4.2 Implement `contentDiff(newText, previousText)` function
    - Return `{ changed: boolean, newContent: string }`
    - Mark as unchanged if similarity > 95%
    - Store `lastProcessedText` state variable, updated after each successful processing cycle
    - _Requirements: 3.3, 3.4_
  - [ ]* 4.3 Write property test for Content Diff Idempotence
    - **Property 1: Content Diff Idempotence**
    - For any text string T, `textSimilarity(T, T)` equals 1.0
    - **Validates: Requirements 3.4**
  - [ ]* 4.4 Write property test for Text Similarity Range
    - **Property 6: Text Similarity Range**
    - For any two strings A and B, `textSimilarity(A, B)` returns a value in [0.0, 1.0]
    - **Validates: Requirements 3.3, 8.1**

- [ ] 5. Implement Question Detector (Renderer)
  - [ ] 5.1 Implement `detectQuestion(text)` function with all pattern types
    - Return `{ detected: boolean, type: string|null }`
    - Add pattern for question marks: text containing a line ending with `?`
    - Add pattern for coding problems: keywords like `function`, `def`, `Input:`, `Output:`, `Example:`, `Constraints:`, `Given`, `Return`
    - Add pattern for SQL problems: keywords like `SELECT`, `INSERT`, `CREATE TABLE`, `Write a query`, `JOIN`
    - Add pattern for MCQs: lines matching `A)`, `B)`, `a.`, `b.`, `1.`, `2.` with option-like structure
    - Add pattern for imperative problems: keywords like `Write`, `Implement`, `Design`, `Explain`, `Describe`, `Find`, `Calculate`, `Solve`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - [ ]* 5.2 Write property test for Question Detection Completeness
    - **Property 2: Question Detection Completeness for Question Marks**
    - For any non-empty string T ending with "?", `detectQuestion(T).detected` is true
    - **Validates: Requirements 4.2**

- [ ] 6. Implement Scroll Stitcher (Renderer)
  - [ ] 6.1 Implement `ScrollStitcher` class with `append(text)`, `getStitchedText()`, `reset()` methods
    - Implement overlap detection: compare last 3-5 lines of accumulated buffer with first 3-5 lines of new text, trim duplicates
    - Maintain reading order of stitched text segments (top-to-bottom)
    - _Requirements: 5.1, 5.3_
  - [ ] 6.2 Add debounce timer and buffer threshold to ScrollStitcher
    - 3-second debounce timer: after each `append()`, reset timer that fires `onStable` callback when no new content arrives
    - 5000-character threshold: if accumulated buffer exceeds 5000 chars, force-emit via `onStable`
    - _Requirements: 5.2, 5.4_
  - [ ]* 6.3 Write property test for Scroll Stitcher content preservation
    - **Property 4: Scroll Stitcher Preserves Content**
    - For any two text segments A and B with overlap, stitched result contains all unique lines from both
    - **Validates: Requirements 5.1**

- [ ] 7. Implement Duplicate Question Prevention (Renderer)
  - [ ] 7.1 Implement `DuplicateDetector` class with circular buffer and similarity check
    - `isDuplicate(question)`: returns true if any buffered question has > 85% similarity
    - `addQuestion(question)`: adds question to FIFO buffer (max 5)
    - `reset()`: clears the buffer
    - _Requirements: 8.1, 8.2, 8.3_
  - [ ]* 7.2 Write property test for Duplicate Detection Symmetry
    - **Property 3: Duplicate Detection Symmetry**
    - For any string T, after `addQuestion(T)`, `isDuplicate(T)` returns true
    - **Validates: Requirements 8.2**

- [ ] 8. Checkpoint - Core components complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Implement Screen Analyzer Controller (Renderer)
  - [ ] 9.1 Implement `startScreenAnalyzer()` function
    - Initialize OCR worker, start capture interval via IPC, begin the processing loop
    - _Requirements: 1.1, 2.1_
  - [ ] 9.2 Implement the main processing loop
    - Capture frame → extract text → content diff → detect question → scroll stitch → duplicate check → send to AI
    - _Requirements: 3.1, 4.1, 5.2, 6.1_
  - [ ] 9.3 Implement `stopScreenAnalyzer()` function
    - Stop capture interval, terminate OCR worker, reset stitcher and duplicate detector, release all resources
    - _Requirements: 1.4, 10.1, 10.3_
  - [ ] 9.4 Integrate with existing `askQuestion()` function for AI answer generation
    - Reuse existing Groq API call and answer rendering
    - Add system prompt specific to screen analysis: instruct AI to answer coding problems with code, MCQs with correct option, SQL with queries
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [ ] 10. UI Integration (Renderer HTML/CSS)
  - [ ] 10.1 Add Screen Analyzer button and status indicator to `index.html`
    - Add "🖥 Screen Analyzer" button to `#mode-toggle-bar`
    - Add `#screen-indicator` div showing "Screen Analyzer Active — monitoring screen for questions"
    - Add `.screen-active` CSS class for status dot (cyan color with pulse animation)
    - _Requirements: 1.1, 1.3_
  - [ ] 10.2 Update `switchMode()` function to handle `'screen'` mode
    - Activate Screen Analyzer, deactivate Manual/Passive
    - Hide manual input area and mic button when Screen Analyzer mode is active
    - Add CSS for screen mode button and indicator styling
    - _Requirements: 1.2, 1.4_

- [ ] 11. Mode Mutual Exclusion Logic
  - [ ] 11.1 Implement mutual exclusion in mode switching
    - `switchMode('screen')` calls `stopAllAudio()` if Manual mode was active
    - `switchMode('screen')` calls `stopPassiveMode()` if Passive mode was active
    - `switchMode('manual')` and `switchMode('passive')` call `stopScreenAnalyzer()` if Screen Analyzer was active
    - Verify only one mode button has `.active` class at any time
    - _Requirements: 1.2, 1.4_

- [ ] 12. Configuration UI (Settings)
  - [ ] 12.1 Add Screen Capture Interval setting to `settings.html`
    - Add number input field (1-10 seconds)
    - Save `screenCaptureInterval` value to config via existing `save-config` IPC
    - Load and apply configured interval on Screen Analyzer activation
    - _Requirements: 9.1, 9.2_
  - [ ] 12.2 Implement hot-reload of capture interval
    - When config changes while Screen Analyzer is active, update capture interval without restarting mode
    - _Requirements: 9.3_

- [ ] 13. Error Handling and Resource Cleanup
  - [ ] 13.1 Add error handling for capture and OCR failures
    - If capture fails, show error in status text and revert to previous mode
    - If Tesseract worker crashes, attempt re-initialization once before showing error
    - _Requirements: 2.4, 10.2_
  - [ ] 13.2 Ensure complete resource cleanup in `stopScreenAnalyzer()`
    - Clear interval, terminate worker, null out references, reset state variables
    - After text extraction, discard base64 image data immediately
    - _Requirements: 10.1, 10.3_

- [ ] 14. Checkpoint - Full integration complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 15. Integration Testing
  - [ ]* 15.1 Write integration tests for mode switching
    - Activate Screen Analyzer → verify capture starts → switch to Manual → verify capture stops
    - _Requirements: 1.1, 1.2, 1.4_
  - [ ]* 15.2 Write integration tests for end-to-end flow
    - Capture frame → OCR extracts text → question detected → AI answers → answer displayed
    - _Requirements: 3.1, 4.1, 6.1, 7.4_
  - [ ]* 15.3 Write integration tests for duplicate prevention and scroll stitching
    - Same screen content captured twice → AI called only once
    - Simulate two overlapping text extractions → verify combined text sent to AI
    - _Requirements: 5.1, 8.2_
  - [ ]* 15.4 Write integration tests for error recovery
    - Simulate capture failure → verify error message shown and mode reverts
    - _Requirements: 2.4, 10.2_

- [ ] 16. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (Properties 1-7)
- Unit tests validate specific examples and edge cases
- The implementation reuses existing Groq API client and answer display infrastructure
- Tesseract.js runs in the renderer process for OCR without API costs per frame
- All new code is added to existing files (`src/main.js`, `src/renderer/index.html`, `src/renderer/settings.html`)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "3.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "3.2", "4.1"] },
    { "id": 3, "tasks": ["4.2", "5.1", "6.1", "7.1"] },
    { "id": 4, "tasks": ["4.3", "4.4", "5.2", "6.2", "7.2"] },
    { "id": 5, "tasks": ["6.3", "9.1", "9.2"] },
    { "id": 6, "tasks": ["9.3", "9.4", "10.1"] },
    { "id": 7, "tasks": ["10.2", "11.1", "12.1"] },
    { "id": 8, "tasks": ["12.2", "13.1", "13.2"] },
    { "id": 9, "tasks": ["15.1", "15.2", "15.3", "15.4"] }
  ]
}
```
