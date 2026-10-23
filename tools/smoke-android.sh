#!/usr/bin/env bash
set -euo pipefail
mkdir -p artifacts/android-smoke
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell pm grant com.wyswang.clocktower android.permission.POST_NOTIFICATIONS
adb shell am instrument -w com.wyswang.clocktower.test/com.wyswang.clocktower.SmokeInstrumentation | tee artifacts/android-smoke/instrumentation.txt
grep -q 'SMOKE_OK' artifacts/android-smoke/instrumentation.txt
adb shell uiautomator dump /sdcard/window.xml >/dev/null
adb pull /sdcard/window.xml artifacts/android-smoke/window.xml
adb exec-out run-as com.wyswang.clocktower cat files/smoke-tablet.png > artifacts/android-smoke/tablet.png
