#!/usr/bin/env bash
set -e

echo "=================================================="
echo "  NEXUS GGUF AGENT - ANDROID APK BUILD SCRIPT     "
echo "  Target Architecture: ARM64-v8a                  "
echo "=================================================="

# Check for ANDROID_HOME or ANDROID_SDK_ROOT
if [ -z "$ANDROID_HOME" ] && [ -z "$ANDROID_SDK_ROOT" ]; then
    echo "⚠️ Warning: ANDROID_HOME or ANDROID_SDK_ROOT is not set."
    echo "Please ensure the Android SDK is installed and ANDROID_HOME is set."
fi

# Ensure gradlew exists or generate it
if [ ! -f "./gradlew" ]; then
    echo "⚙️ Generating Gradle Wrapper..."
    gradle wrapper --gradle-version 8.7
fi

chmod +x ./gradlew

echo "🔨 Compiling Android APK (assembleDebug)..."
./gradlew assembleDebug || gradle assembleDebug

echo "✅ Build completed successfully!"
echo "APK Output location:"
ls -lh android/app/build/outputs/apk/debug/*.apk 2>/dev/null || echo "android/app/build/outputs/apk/debug/"
