# gemini-proxy Android Build Instructions

## Prerequisites
- Android Studio installed.
- Android SDK configured.
- Node.js and Bun installed.

## Setup
1. Initialize Capacitor (done):
   `npm install @capacitor/android @capacitor/cli @capacitor/core`
   `npx cap add android`

2. Sync assets:
   `npx cap sync android`

## Building the APK
1. Open the Android project in Android Studio:
   `npx cap open android`
2. In Android Studio, go to **Build** > **Build Bundle(s) / APK(s)** > **Build APK(s)**.
3. The generated APK will be available in `android/app/build/outputs/apk/debug/app-debug.apk`.

## Building a Release APK
1. Create a keystore:
   `keytool -genkey -v -keystore release-key.jks -keyalg RSA -keysize 2048 -validity 10000 -alias my-alias`
2. Configure `android/app/build.gradle` with your `signingConfigs`.
3. Build the release APK:
   `cd android`
   `./gradlew assembleRelease`
   The APK will be at `android/app/build/outputs/apk/release/app-release-unsigned.apk` (if not signed) or `app-release.apk` (if signed).
