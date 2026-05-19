# 🎙 Invisible AI Interview Assistant

A local desktop app that gives you **real-time AI answers during interviews** — completely invisible when you share your screen.

---

## ✅ How It Works

- Listens to speech via your **microphone** in real time
- Automatically detects questions and sends them to **Claude AI**
- Displays answers in a floating window that is **invisible to screen sharing** (Zoom, Meet, Teams, etc.)
- You can also **type questions manually**

---

## 🚀 Setup (5 minutes)

### 1. Install Node.js
Download from: https://nodejs.org (LTS version)

### 2. Get a Free Anthropic API Key
- Go to: https://console.anthropic.com
- Sign up (free — includes $5 credit)
- Create an API key
- Copy it (starts with `sk-ant-...`)

### 3. Run the App

```bash
# Open terminal in this folder, then:
npm install
npm start
```

### 4. Add Your API Key
- When the app opens, click the **⚙ gear button** (top right)
- Paste your Anthropic API key
- Optionally add your resume/background for personalized answers
- Click **Save**

---

## 🛡️ Why It's Invisible

The app uses a built-in **OS-level API** (`setContentProtection`) that marks the window as excluded from screen capture. When Zoom/Meet/Teams capture your screen, this window is automatically excluded.

**Works with:** Zoom, Google Meet, Microsoft Teams, Webex, and any other screen-sharing tool.

---

## 💡 Usage Tips

- **Auto mode**: Click **▶ Start** — it listens and auto-answers after a 2.5s pause
- **Manual mode**: Type your question in the box and press Enter (or click Ask)
- **Keyboard shortcut**: Press Enter in the text box to ask
- The window stays **always on top** so you can see answers while looking at the interviewer

---

## 💰 Cost

- Free to run locally (no subscription)
- Only cost: Anthropic API usage — approximately **$0.003 per question** (about 300 questions per $1)
- New accounts get **$5 free credit** = ~1,600 free questions

---

## 🔧 Troubleshooting

**App doesn't start:**
- Make sure Node.js is installed: `node --version`
- Run `npm install` again

**Microphone not working:**
- Allow microphone access when prompted by the OS
- On macOS: System Preferences → Security → Microphone → allow Terminal/Electron

**Still visible on screen share:**
- Make sure you're running the latest version of Zoom/Teams
- On Zoom: Settings → Video → enable "Advanced capture with window filtering"

**API errors:**
- Double-check your API key in Settings
- Make sure you have internet access
