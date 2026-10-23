#!/usr/bin/env bash
set -euo pipefail
# 在 Linux 构建机使用官方 NDK 编译；不下载第三方 APK 或来历不明的隧道二进制。
root="$(cd "$(dirname "$0")/.." && pwd)"
ndk="${ANDROID_HOME:?Android SDK required}/ndk/27.2.12479018"
mkdir -p "$root/artifacts/android-deps" "$root/android/app/libnode"
archive="$root/artifacts/android-deps/nodejs-mobile-v18.20.4-android.zip"
if [ ! -f "$archive" ]; then
  curl --fail --location --retry 3 'https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip' -o "$archive"
fi
printf '%s  %s\n' 'bd7321eaa1a7602fbe0bb87302df2d79d87835cf4363fbdd17c350dbb485c2af' "$archive" | sha256sum --check
unzip -q -o "$archive" -d "$root/android/app/libnode"
source_dir="$root/artifacts/cloudflared"
test -f "$source_dir/go.mod"
for abi in arm64-v8a armeabi-v7a x86_64; do
  case "$abi" in
    arm64-v8a) arch=arm64; compiler=aarch64-linux-android26-clang ;;
    armeabi-v7a) arch=arm; compiler=armv7a-linux-androideabi26-clang ;;
    x86_64) arch=amd64; compiler=x86_64-linux-android26-clang ;;
  esac
  destination="$root/android/app/src/main/jniLibs/$abi"
  mkdir -p "$destination"
  (cd "$source_dir" && GOOS=android GOARCH="$arch" GOARM=7 CGO_ENABLED=1 \
    CC="$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/$compiler" \
    go build -mod=readonly -trimpath -buildvcs=false -buildmode=pie \
    -ldflags='-s -w -X main.Version=2026.10.3-android -extldflags=-Wl,-z,max-page-size=16384' \
    -o "$destination/libcloudflared.so" ./cmd/cloudflared)
done
# 组件版权随 APK 一起提供，应用内帮助也有来源说明。
mkdir -p "$root/android/app/src/main/assets/licenses"
cp "$source_dir/LICENSE" "$root/android/app/src/main/assets/licenses/cloudflared-LICENSE"
curl --fail --location --retry 3 'https://raw.githubusercontent.com/nodejs-mobile/nodejs-mobile/v18.20.4/LICENSE' \
  -o "$root/android/app/src/main/assets/licenses/nodejs-mobile-LICENSE"
(cd "$source_dir" && go list -mod=readonly -m -f '{{if .Dir}}{{.Path}}|{{.Dir}}{{end}}' all) | while IFS='|' read -r name directory; do
  [ -n "$directory" ] || continue
  for license in "$directory"/LICENSE* "$directory"/NOTICE* "$directory"/COPYING*; do
    [ -f "$license" ] || continue
    destination="$root/android/app/src/main/assets/licenses/go-modules/$name"
    mkdir -p "$destination"
    cp "$license" "$destination/"
  done
done
cp "$(go env GOROOT)/LICENSE" "$root/android/app/src/main/assets/licenses/go-LICENSE"
