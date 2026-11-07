# NEXUS GGUF AGENT

Offline-First Local AI Agent & Autonomous Telegram Orchestrator for Android (ARM64-v8a).

## Architecture Overview

Nexus GGUF Agent runs user-provided GGUF language models locally on Android devices without requiring Termux or external cloud AI services.

### Core Subsystems:
1. **Inference Engine**: Native `llama.cpp` ARM64 binary runtime with NEON vector instructions and DotProduct acceleration.
2. **Local Daemon**: Embedded Ktor CIO HTTP/WebSocket server running on loopback `127.0.0.1:8765`.
3. **Database & Knowledge Base**: SQLite in WAL mode with FTS5 virtual tables for BM25 full-text chunk ranking.
4. **Persistent Message Queue**: Atomic FIFO queue (capped at 500 tasks) with deduplication hash collision detection and single-worker execution.
5. **Telegram Integration**: Modular Telegram Bot API and MTProto User Account client.
6. **Web Dashboard**: Modern dark responsive dashboard accessible via embedded Android WebView or browser.

---

## Building the Android APK

### Option 1: GitHub Actions (Automated Cloud Build)
1. Push or fork this repository to GitHub.
2. Navigate to the **Actions** tab in your repository.
3. The workflow `.github/workflows/build-apk.yml` triggers on push or manual dispatch.
4. Download the compiled `nexus-gguf-agent-debug-apk` from the job artifacts.

### Option 2: Local Command-Line Build
Ensure you have JDK 17 and the Android SDK (API 35, NDK r26c) installed:
```bash
# 1. Run local build script
bash android/build-apk.sh

# 2. Or compile with Gradle
./gradlew :android:app:assembleDebug

# 3. Install on phone
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

### Option 3: Android Studio
1. Open this directory in Android Studio.
2. Allow Gradle sync to complete.
3. Select Build Variant `arm64Debug`.
4. Click **Run** (`Shift + F10`) to deploy directly to your connected ARM64 device.

---

## Persistent Shared Storage Layout

Nexus GGUF Agent stores persistent user assets under:
`/sdcard/Android/data/com.nexus.agent/files/`
* `models/` - User GGUF model files (`.gguf`)
* `databases/` - Persistent SQLite database (`nexus_agent.db`) and WAL files
* `knowledge/` - Imported reference documents (`.txt`, `.md`, `.json`, `.pdf`)
* `backups/` - Exported JSON bundles and database archives
* `logs/` - System audit traces and tool logs
