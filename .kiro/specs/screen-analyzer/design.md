# Design Document: Screen Analyzer

## Overview

The Screen Analyzer adds a third mode to the Interview Assistant that captures the screen periodically, extracts text via OCR, detects questions/problems, and sends them to the Groq AI for automatic answering. It integrates into the existing mode toggle system and reuses the answer display infrastructure.

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Renderer Process (index.html)              │
│                                                              │
│  ┌──────────────┐   ┌───────────────┐   ┌───────────────┐  │
│  │ Mode Toggle  │──▶│ Screen Analyzer│──▶│ Answer Panel  │  │
│  │ (UI Button)  │   │  Controller    │   │ (existing)    │  │
│  └──────────────┘   └───────┬───────┘   └───────────────┘  │
│                              │                               │
│                    ┌─────────┼─────────┐                    │
│                    ▼         ▼         ▼                    │
│           ┌────────────┐ ┌────────┐ ┌──────────────┐       │
│           │Content Diff│ │Question│ │Scroll Stitcher│       │
│           │  Engine    │ │Detector│ │              │       │
│           └────────────┘ └────────┘ └──────────────┘       │
│                    │                                         │
│                    ▼ IPC                                     │
├─────────────────────────────────────────────────────────────┤
│                    Main Process (main.js)                     │
│                                                              │
│  ┌──────────────────┐   ┌──────────────────┐               │
│  │ Capture Engine   │   │ OCR / Text       │               │
│  │ (desktopCapturer)│──▶│ Extractor        │               │
│  └──────────────────┘   └──────────────────┘               │
│                                                              │
│  ┌──────────────────┐                                       │
│  │ Groq API Client  │  (existing, reused)                   │
│  └──────────────────┘                                       │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

1. User activates Screen Analyzer mode via UI button
2. Renderer sends `start-screen-analyzer` IPC message to main process
3. Main process starts a capture timer at the configured interval
4. Each tick: desktopCapturer captures screen → image sent to OCR
5. Extracted text returned to renderer via IPC
6. Renderer runs Content Diff → if new content, runs Question Detector
7. If question found, Scroll Stitcher checks for partial content and accumulates
8. Once stable (3s no change) or threshold hit (5000 chars), sends to Groq API
9. Answer displayed in Answer Panel

## Components and Interfaces

### CaptureEngine (Main Process)
- **Interface:** IPC handlers (`start-screen-capture`, `stop-screen-capture`, `capture-screen-frame`)
- **Responsibility:** Periodic screen capture using Electron's `desktopCapturer`
- **Input:** Capture interval (1-10 seconds)
- **Output:** Base64-encoded JPEG image data via IPC

### TextExtractor (Renderer Process)
- **Interface:** `extractText(imageBase64: string): Promise<string>`
- **Responsibility:** OCR processing of captured frames using Tesseract.js
- **Input:** Base64 image data
- **Output:** Extracted text string

### ContentDiffEngine (Renderer Process)
- **Interface:** `textSimilarity(a: string, b: string): number`, `hasChanged(newText: string): boolean`
- **Responsibility:** Comparing extracted text against previously processed text
- **Input:** Two text strings
- **Output:** Similarity ratio (0.0 - 1.0) and change decision

### QuestionDetector (Renderer Process)
- **Interface:** `detectQuestion(text: string): { detected: boolean, type: string | null }`
- **Responsibility:** Pattern matching to identify questions, coding problems, MCQs
- **Input:** Extracted text string
- **Output:** Detection result with question type classification

### ScrollStitcher (Renderer Process)
- **Interface:** `appendSegment(text: string): void`, `getStitchedText(): string`, `reset(): void`
- **Responsibility:** Combining overlapping text segments from consecutive captures
- **Input:** Text segments from sequential captures
- **Output:** Reconstructed full document text

### DuplicateDetector (Renderer Process)
- **Interface:** `isDuplicate(question: string): boolean`, `addProcessed(question: string): void`, `reset(): void`
- **Responsibility:** Preventing re-processing of previously answered questions
- **Input:** Detected question text
- **Output:** Boolean indicating if question was already processed

### ScreenAnalyzerController (Renderer Process)
- **Interface:** `activate(): void`, `deactivate(): void`, `isActive(): boolean`
- **Responsibility:** Orchestrating the full pipeline and managing mode state
- **Input:** User mode toggle actions
- **Output:** Coordinates all sub-components, triggers AI calls, updates Answer Panel

## Data Models

### CapturedFrame
```typescript
interface CapturedFrame {
  imageData: string;       // Base64-encoded JPEG
  timestamp: number;       // Unix timestamp of capture
  width: number;           // Frame width in pixels
  height: number;          // Frame height in pixels
}
```

### ExtractionResult
```typescript
interface ExtractionResult {
  text: string;            // Extracted text content
  confidence: number;      // OCR confidence score (0-1)
  timestamp: number;       // When extraction completed
}
```

### DetectionResult
```typescript
interface DetectionResult {
  detected: boolean;       // Whether a question was found
  type: string | null;     // Question type: 'questionMark' | 'codingProblem' | 'sqlProblem' | 'mcq' | 'imperative' | null
  text: string;            // The detected question text
}
```

### StitcherState
```typescript
interface StitcherState {
  buffer: string;          // Accumulated stitched text
  segments: string[];      // Individual text segments received
  lastUpdateTime: number;  // Timestamp of last content addition
  isStable: boolean;       // Whether 3s stability threshold has been met
}
```

### ProcessedQuestion
```typescript
interface ProcessedQuestion {
  text: string;            // The question text sent to AI
  answer: string;          // The AI-generated answer
  timestamp: number;       // When the question was processed
}
```

### ScreenAnalyzerConfig
```typescript
interface ScreenAnalyzerConfig {
  captureInterval: number; // Seconds between captures (1-10, default 3)
  similarityThreshold: number; // Content diff threshold (default 0.95)
  duplicateThreshold: number;  // Duplicate question threshold (default 0.85)
  maxBufferChars: number;      // Scroll stitcher max buffer (default 5000)
  stabilityTimeout: number;    // Seconds to wait for stable content (default 3)
}
```

## Technical Design

### 1. Screen Capture (Main Process)

**File:** `src/main.js` (additions)

New IPC handlers:
- `start-screen-capture`: Begins periodic capture using `desktopCapturer.getSources({ types: ['screen'] })`, converts the screen source to a NativeImage, then to a base64 PNG/JPEG data URL.
- `stop-screen-capture`: Clears the capture interval timer and releases resources.
- `capture-screen-frame`: Single-shot capture for on-demand use.

The capture uses `setInterval` with the configured Capture_Interval. Each frame is captured as a thumbnail from the screen source at the native resolution, then compressed to JPEG (quality 80) to reduce IPC payload size.

```javascript
// Pseudocode for capture handler
ipcMain.handle('capture-screen-frame', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: screenWidth, height: screenHeight }
  });
  const primaryScreen = sources[0];
  return primaryScreen.thumbnail.toJPEG(80).toString('base64');
});
```

### 2. Text Extraction (OCR)

**Approach:** Use Tesseract.js (client-side OCR library) in the renderer process, or alternatively use the Groq vision API if available.

**Primary approach — Tesseract.js:**
- Install `tesseract.js` as a dependency
- Initialize a Tesseract worker on mode activation
- Feed each captured frame (base64 image) to the worker
- Receive extracted text string
- Terminate worker on mode deactivation

**Alternative approach — Groq Vision API:**
- If Groq supports vision models, send the image directly to the API with a prompt like "Extract all visible text from this screenshot"
- This provides better accuracy but costs API calls per frame

**Decision:** Use Tesseract.js for local OCR (no API cost per frame, works offline for extraction). Fall back to vision API only if OCR quality is insufficient.

### 3. Content Diff Engine (Renderer)

**Logic:**
- Store the last processed text string
- On each new extraction, compute similarity ratio
- If similarity > 95%, treat as "unchanged" and skip
- If similarity < 95%, extract the delta (new content)

**Implementation:** Simple Levenshtein distance ratio or character-level diff. For performance, use a fast string comparison:

```javascript
function textSimilarity(a, b) {
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1.0;
  // Use substring matching for performance
  let matches = 0;
  const windowSize = 50;
  for (let i = 0; i < shorter.length; i += windowSize) {
    const chunk = shorter.substring(i, i + windowSize);
    if (longer.includes(chunk)) matches++;
  }
  return matches / Math.ceil(shorter.length / windowSize);
}
```

### 4. Question Detector (Renderer)

**Pattern matching rules:**

1. **Question marks:** Text ending with `?`
2. **Coding problems:** Presence of keywords like `function`, `def`, `class`, `Input:`, `Output:`, `Example:`, `Constraints:`, `Given`, `Return`
3. **SQL problems:** Keywords like `SELECT`, `INSERT`, `CREATE TABLE`, `Write a query`
4. **MCQs:** Patterns like `A)`, `B)`, `a.`, `b.`, `1.`, `2.` with option-like structure
5. **General problems:** Imperative statements like "Write a program", "Implement", "Design", "Explain", "Describe"

```javascript
function detectQuestion(text) {
  const patterns = {
    questionMark: /\?[\s]*$/m,
    codingProblem: /\b(function|def|class|Input:|Output:|Example:|Constraints:|Given|Return)\b/i,
    sqlProblem: /\b(SELECT|INSERT|UPDATE|DELETE|CREATE TABLE|Write a query|JOIN)\b/i,
    mcq: /^[\s]*[A-Da-d1-4][\.\)]\s+\S/m,
    imperative: /\b(Write|Implement|Design|Explain|Describe|Find|Calculate|Determine|Solve)\b/
  };
  
  for (const [type, regex] of Object.entries(patterns)) {
    if (regex.test(text)) return { detected: true, type };
  }
  return { detected: false, type: null };
}
```

### 5. Scroll Stitcher (Renderer)

**Algorithm:**
1. Maintain a buffer of extracted text segments
2. On each new text extraction, check for overlap with the tail of the buffer
3. If overlap found (last N lines of buffer match first N lines of new text), append only the non-overlapping portion
4. Start a 3-second debounce timer on each new append
5. When timer fires without new content, emit the full stitched text for processing
6. If buffer exceeds 5000 chars, force-emit regardless of timer

**Overlap detection:** Compare the last 3-5 lines of the accumulated buffer with the first 3-5 lines of the new extraction. If a match is found, trim the overlap.

### 6. Duplicate Question Prevention (Renderer)

**Implementation:**
- Maintain a circular buffer of the last 5 processed question strings
- Before sending to AI, compute similarity against each buffered question
- If any similarity > 85%, skip processing
- Use the same `textSimilarity` function from Content Diff

### 7. UI Changes (Renderer)

**Mode button:** Add a third button to `#mode-toggle-bar`:
```html
<button class="mode-btn" id="screen-mode-btn" onclick="switchMode('screen')">🖥 Screen Analyzer</button>
```

**Status indicators:** Reuse existing status dot with a new CSS class `.screen-active` (e.g., cyan color with pulse animation).

**Answer Panel:** Reuse the existing `#answer-wrap` and `#answer-text` elements. No structural changes needed — the Screen Analyzer writes answers to the same elements.

**Screen Analyzer indicator:** Similar to `#passive-indicator`, add a `#screen-indicator` div showing "Screen Analyzer Active — monitoring screen for questions."

### 8. Configuration

**Settings additions:**
- `screenCaptureInterval`: Number (1-10), default 3
- Stored in `~/.interview-assistant-config.json` alongside existing config

### 9. Dependencies

**New dependency:**
- `tesseract.js` (v5.x) — Client-side OCR engine

**Existing dependencies reused:**
- Electron `desktopCapturer` — Screen capture
- Groq API client (existing `call-ai-api` handler) — AI answering
- Existing UI framework — Answer display, mode toggle

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Content Diff Idempotence

*For any* text string T, `contentDiff(T, T)` SHALL return "unchanged" (similarity = 1.0). Applying contentDiff to the same input twice produces the same skip decision.

**Validates: Requirements 3.4**

### Property 2: Question Detection Completeness for Question Marks

*For any* non-empty text string T that ends with "?", `detectQuestion(T)` SHALL return `{ detected: true }`.

**Validates: Requirements 4.2**

### Property 3: Duplicate Detection Symmetry

*For any* text string T, `textSimilarity(T, T)` SHALL equal 1.0 (always above 85% threshold, always detected as duplicate).

**Validates: Requirements 8.2**

### Property 4: Scroll Stitcher Preserves Content

*For any* two text segments A and B with overlap, the stitched result SHALL contain all unique lines from both A and B. No content from either segment is lost.

**Validates: Requirements 5.1**

### Property 5: Capture Interval Bounds Validation

*For any* numeric input N, the effective capture interval SHALL be clamped to the range [1, 10]. Values below 1 become 1, values above 10 become 10.

**Validates: Requirements 9.2**

### Property 6: Text Similarity Range

*For any* two strings A and B, `textSimilarity(A, B)` SHALL return a value in the range [0.0, 1.0].

**Validates: Requirements 3.3, 8.1**

### Property 7: Mode Mutual Exclusion

*For any* mode switch operation, exactly one mode SHALL be active. Activating Screen Analyzer deactivates Manual and Passive; activating Manual deactivates Screen Analyzer and Passive.

**Validates: Requirements 1.2**

## File Structure

```
src/
├── main.js                    (modified — add screen capture IPC handlers)
├── preload.js                 (unchanged)
├── renderer/
│   ├── index.html             (modified — add screen mode button, indicator, screen analyzer JS)
│   └── settings.html          (modified — add capture interval setting)
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| desktopCapturer returns no sources | Show error, revert to previous mode |
| Tesseract.js fails to initialize | Show error, suggest reinstall |
| OCR takes > 5 seconds | Skip frame, continue next cycle |
| Groq API error | Display error in answer panel, continue monitoring |
| No API key configured | Show API warning (existing behavior) |

## Testing Strategy

### Unit Tests (Example-Based)
- **CaptureEngine:** Verify IPC handler registration, error handling when no sources available, resource cleanup on deactivation
- **TextExtractor:** Test OCR initialization/teardown, timeout handling for slow frames, empty image handling
- **QuestionDetector:** Test each pattern type with concrete examples (question marks, coding problems, SQL, MCQs, imperatives), verify false negatives for non-question text
- **ScrollStitcher:** Test overlap detection with known overlapping segments, buffer size limit enforcement, stability timer behavior
- **Mode switching:** Verify only one mode is active after each switch, verify cleanup of previous mode resources

### Property-Based Tests (fast-check)
- **Library:** fast-check (JavaScript property-based testing library)
- **Minimum iterations:** 100 per property
- Each property test references its design document property via tag comment:
  - `// Feature: screen-analyzer, Property 1: Content Diff Idempotence`
  - `// Feature: screen-analyzer, Property 2: Question Detection Completeness for Question Marks`
  - `// Feature: screen-analyzer, Property 3: Duplicate Detection Symmetry`
  - `// Feature: screen-analyzer, Property 4: Scroll Stitcher Preserves Content`
  - `// Feature: screen-analyzer, Property 5: Capture Interval Bounds Validation`
  - `// Feature: screen-analyzer, Property 6: Text Similarity Range`
  - `// Feature: screen-analyzer, Property 7: Mode Mutual Exclusion`

### Integration Tests
- **End-to-end pipeline:** Activate screen mode → capture frame → extract text → detect question → generate answer → display in panel
- **Mode transitions:** Switch between Manual, Passive, and Screen Analyzer modes rapidly, verify no resource leaks
- **Groq API integration:** Mock API responses to verify answer display and error handling

### Edge Cases
- Empty screen captures (blank/black screen)
- Very large text extractions (>10,000 characters)
- Rapid scrolling producing many overlapping frames
- Non-Latin character text in OCR results
- Network failure during AI API call mid-processing
