#!/usr/bin/env bash
set -euo pipefail

base=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$base/../.." && pwd)
sdk="${ANDROID_SDK_ROOT:?Set ANDROID_SDK_ROOT to an Android SDK with Platform 35 and Build Tools 35.0.0}"
jdk="${JAVA_HOME:?Set JAVA_HOME to the JDK}"
key="${ANDROID_PREVIEW_KEYSTORE:?Set ANDROID_PREVIEW_KEYSTORE to a test-only keystore path}"
output="${1:?Provide an absolute APK output path}"
tools="$sdk/build-tools/35.0.0"
android="$sdk/platforms/android-35/android.jar"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/res/drawable-nodpi" "$work/classes" "$work/dex"
cp -R "$base/res/." "$work/res/"
cp "$root/apps/web/public/brand/quick-record-192.png" "$work/res/drawable-nodpi/lingji.png"
"$tools/aapt2" compile --dir "$work/res" -o "$work/resources.zip"
"$tools/aapt2" link -I "$android" --manifest "$base/AndroidManifest.xml" -o "$work/raw.apk" "$work/resources.zip"
"$jdk/bin/javac" --release 8 -classpath "$android" -d "$work/classes" "$base"/src/com/rookiehouse/lingji/preview/*.java
"$jdk/bin/jar" cf "$work/classes.jar" -C "$work/classes" .
JAVA_HOME="$jdk" "$tools/d8" --release --min-api 28 --lib "$android" --output "$work/dex" "$work/classes.jar"
(cd "$work/dex" && zip -q "$work/raw.apk" classes.dex)
"$tools/zipalign" -f 4 "$work/raw.apk" "$work/aligned.apk"
if [[ ! -e "$key" ]]; then
  mkdir -p "$(dirname "$key")"
  (umask 077 && "$jdk/bin/keytool" -genkeypair -keystore "$key" -keyalg RSA -keysize 2048 -validity 3650 \
    -alias androiddebugkey -storepass android -keypass android -dname 'CN=LingJi Android Preview,O=Testing')
fi
mkdir -p "$(dirname "$output")"
JAVA_HOME="$jdk" "$tools/apksigner" sign --ks "$key" --ks-key-alias androiddebugkey --ks-pass pass:android \
  --key-pass pass:android --out "$output" "$work/aligned.apk"
JAVA_HOME="$jdk" "$tools/apksigner" verify --verbose --print-certs "$output"
