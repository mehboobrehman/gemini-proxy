# MOBILE_BUILD.md

## Mobile Build Instructions

This document outlines how to build the Android APK for the `gemini-proxy` project using Capacitor.

### Prerequisites

1. **Android Studio**: Install the latest version of Android Studio.
2. **Java JDK**: Ensure JDK 17+ is installed and `JAVA_HOME` is set.
3. **Node.js**: Install Node.js (needed for Capacitor/NPM).

### Setup Steps

1. **Install Dependencies**:
   ```bash
   npm install @capacitor/core @capacitor/cli @capacitor/android
   ```

2. **Initialize Capacitor**:
   ```bash
   npx cap init gemini-proxy com.geminiproxy.app --web-dir dist
   ```

3. **Build the Web UI**:
   Ensure your web assets are built and placed in the `dist` folder.

4. **Add Android Platform**:
   ```bash
   npx cap add android
   ```

5. **Open in Android Studio**:
   ```bash
   npx cap open android
   ```

### Building the APK

1. In Android Studio, go to `Build` > `Build Bundle(s) / APK(s)` > `Build APK(s)`.
2. For Release builds, configure your `key.properties` and `signingConfigs` in `android/app/build.gradle`.

### Signing

1. Create a keystore:
   ```bash
   keytool -genkey -v -keystore release-key.jks -keyalg RSA -keysize 2048 -validity 10000 -alias my-alias
   ```
2. Add the keystore details to your build configuration.
