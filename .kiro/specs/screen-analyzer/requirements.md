# Requirements Document

## Introduction

The Screen Analyzer feature adds a third operational mode to the Interview Assistant app. When activated, it continuously captures the user's screen, extracts visible questions or problem statements using OCR/text extraction, and sends them to the Groq AI for automatic answering. This enables hands-free assistance for text-based interview questions, coding challenges, MCQs, and any on-screen problem without requiring audio input.

## Glossary

- **Screen_Analyzer**: The subsystem responsible for capturing, processing, and analyzing screen content to detect and answer visible questions.
- **Capture_Engine**: The component that uses Electron's desktopCapturer API to take periodic screenshots of the user's screen.
- **Text_Extractor**: The component that performs OCR (Optical Character Recognition) on captured screen frames to extract visible text.
- **Question_Detector**: The component that analyzes extracted text to identify questions, problem statements, or coding challenges.
- **Scroll_Stitcher**: The component that detects scrolling activity and combines text from multiple captures to reconstruct complete questions that span beyond a single viewport.
- **Answer_Panel**: The UI region within the existing overlay window that displays AI-generated answers for screen-detected questions.
- **Capture_Interval**: The time period between consecutive screen captures, configurable by the user.
- **Content_Diff**: The mechanism that compares current extracted text against previously processed text to avoid re-processing unchanged content.

## Requirements

### Requirement 1: Mode Activation

**User Story:** As a user, I want to activate Screen Analyzer mode via a dedicated button in the mode toggle bar, so that I can switch to screen analysis without disrupting the existing workflow.

#### Acceptance Criteria

1. WHEN the user clicks the "Screen Analyzer" button in the mode toggle bar, THE Screen_Analyzer SHALL activate and begin screen capture within 1 second.
2. WHEN the Screen_Analyzer mode is activated, THE Screen_Analyzer SHALL deactivate any previously active mode (Manual or Passive Listener).
3. WHILE the Screen_Analyzer mode is active, THE Screen_Analyzer SHALL display a visible status indicator showing the mode is running.
4. WHEN the user clicks a different mode button, THE Screen_Analyzer SHALL stop all screen capture and text processing within 500 milliseconds.

### Requirement 2: Screen Capture

**User Story:** As a user, I want the app to continuously capture my screen content, so that any visible question is detected automatically.

#### Acceptance Criteria

1. WHILE the Screen_Analyzer mode is active, THE Capture_Engine SHALL capture the entire primary screen at a regular Capture_Interval.
2. THE Capture_Engine SHALL use Electron's desktopCapturer API to obtain screen frames as image data.
3. WHILE the Screen_Analyzer mode is active, THE Capture_Engine SHALL exclude the Interview Assistant overlay window from captured frames.
4. IF the desktopCapturer fails to obtain a screen source, THEN THE Capture_Engine SHALL display an error message to the user and revert to the previously active mode.

### Requirement 3: Text Extraction

**User Story:** As a user, I want the system to extract readable text from screen captures, so that questions can be identified from any on-screen content.

#### Acceptance Criteria

1. WHEN a screen frame is captured, THE Text_Extractor SHALL perform OCR on the frame and produce a text string within 2 seconds.
2. THE Text_Extractor SHALL support extraction of text rendered in standard screen fonts at sizes 10px and above.
3. WHEN the Text_Extractor produces a result, THE Content_Diff SHALL compare the extracted text against the previously processed text.
4. IF the extracted text is identical to the previously processed text, THEN THE Screen_Analyzer SHALL skip further processing for that frame.

### Requirement 4: Question Detection

**User Story:** As a user, I want the system to automatically identify questions and problem statements from extracted text, so that only relevant content is sent to the AI.

#### Acceptance Criteria

1. WHEN new text is extracted from a screen frame, THE Question_Detector SHALL analyze the text to identify questions, coding problems, SQL queries, MCQs, aptitude questions, and general problem statements.
2. THE Question_Detector SHALL detect content that ends with a question mark as a question.
3. THE Question_Detector SHALL detect coding problem patterns including function signatures, input/output examples, and constraint descriptions.
4. THE Question_Detector SHALL detect MCQ patterns including numbered or lettered answer options.
5. IF no question or problem statement is detected in the extracted text, THEN THE Screen_Analyzer SHALL skip AI processing for that frame.

### Requirement 5: Scroll-Aware Content Reconstruction

**User Story:** As a user, I want the system to handle questions that span beyond the visible screen area, so that the AI receives the complete problem context.

#### Acceptance Criteria

1. WHEN the Content_Diff detects partial overlap between consecutive frames, THE Scroll_Stitcher SHALL combine the non-overlapping text portions into a single reconstructed document.
2. WHILE the Scroll_Stitcher is accumulating content, THE Screen_Analyzer SHALL wait for a stable period of 3 seconds with no new content before sending the reconstructed text to the AI.
3. THE Scroll_Stitcher SHALL maintain the reading order of stitched text segments (top-to-bottom as captured).
4. IF the Scroll_Stitcher accumulates more than 5000 characters without a stable period, THEN THE Screen_Analyzer SHALL process the accumulated content as-is.

### Requirement 6: AI Answer Generation

**User Story:** As a user, I want the detected question to be sent to the AI and receive an answer instantly, so that I can use the response during my interview.

#### Acceptance Criteria

1. WHEN the Question_Detector identifies a complete question, THE Screen_Analyzer SHALL send the question text to the Groq API using the configured API key and model (llama-3.3-70b-versatile).
2. THE Screen_Analyzer SHALL include a system prompt instructing the AI to answer the detected question type appropriately (code solutions, MCQ answers, explanations).
3. IF the Groq API returns an error, THEN THE Screen_Analyzer SHALL display the error message in the Answer_Panel and continue monitoring the screen.
4. WHEN the AI returns a response, THE Screen_Analyzer SHALL display the answer in the Answer_Panel within 500 milliseconds of receiving it.

### Requirement 7: Answer Display

**User Story:** As a user, I want the AI answer to remain visible in the overlay even as I scroll or navigate, so that I can reference it while working.

#### Acceptance Criteria

1. WHILE the Screen_Analyzer mode is active, THE Answer_Panel SHALL remain visible and pinned in the overlay window regardless of screen scrolling.
2. WHEN a new answer is generated, THE Answer_Panel SHALL replace the previous answer content with the new answer.
3. THE Answer_Panel SHALL render code blocks with syntax highlighting consistent with the existing answer display format.
4. THE Answer_Panel SHALL be scrollable independently when the answer content exceeds the visible panel height.

### Requirement 8: Duplicate Question Prevention

**User Story:** As a user, I want the system to avoid re-answering the same question repeatedly, so that the AI is not called unnecessarily.

#### Acceptance Criteria

1. WHEN a question is detected, THE Screen_Analyzer SHALL compare it against the last 5 processed questions using text similarity.
2. IF the detected question has greater than 85% text similarity to a previously processed question, THEN THE Screen_Analyzer SHALL skip AI processing and retain the existing answer.
3. WHEN the user scrolls to entirely new content, THE Screen_Analyzer SHALL reset the duplicate detection context.

### Requirement 9: Configuration

**User Story:** As a user, I want to configure the screen capture interval, so that I can balance between responsiveness and system resource usage.

#### Acceptance Criteria

1. THE Screen_Analyzer SHALL use a default Capture_Interval of 3 seconds.
2. WHERE the user has configured a custom Capture_Interval in settings, THE Screen_Analyzer SHALL use the configured value between 1 and 10 seconds.
3. WHEN the configuration is updated, THE Screen_Analyzer SHALL apply the new Capture_Interval without requiring a mode restart.

### Requirement 10: Performance and Resource Management

**User Story:** As a user, I want the screen analyzer to run efficiently without degrading system performance, so that my interview experience is not impacted.

#### Acceptance Criteria

1. WHILE the Screen_Analyzer mode is active, THE Capture_Engine SHALL release each captured frame from memory after text extraction is complete.
2. IF text extraction for a frame takes longer than 5 seconds, THEN THE Screen_Analyzer SHALL skip that frame and proceed to the next capture cycle.
3. WHEN the Screen_Analyzer mode is deactivated, THE Screen_Analyzer SHALL release all allocated resources (streams, buffers, timers) within 1 second.
