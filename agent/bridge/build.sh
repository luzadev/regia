#!/bin/sh
# Builds the bridge on macOS or Linux. Usage:
#   OBSBOT_SDK_DIR=/path/to/libdev_v2.1.0_8 sh agent/bridge/build.sh
set -e
SDK="${OBSBOT_SDK_DIR:?imposta OBSBOT_SDK_DIR sulla cartella libdev_v2.x del kit OBSBOT}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../native"
mkdir -p "$OUT"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  LIBDIR="$SDK/macos/macos/arm64-release"; EXT=dylib ;;
  Darwin-x86_64) LIBDIR="$SDK/macos/macos/x86_64-release"; EXT=dylib ;;
  Linux-x86_64)  LIBDIR="$SDK/linux/x86_64-release"; EXT=so ;;
  Linux-aarch64) LIBDIR="$SDK/linux/arm64-release"; EXT=so ;;
  *) echo "piattaforma non supportata: $(uname -s) $(uname -m)"; exit 1 ;;
esac

if [ "$EXT" = dylib ]; then
  c++ -std=c++17 -O2 -dynamiclib -I"$SDK/include" "$HERE/obsbot_bridge.cpp" \
    -L"$LIBDIR" -ldev -Wl,-rpath,@loader_path -o "$OUT/obsbot_bridge.dylib"
  cp "$LIBDIR/libdev.dylib" "$OUT/"
  # A library copied out of a downloaded zip keeps macOS quarantine.
  xattr -d com.apple.quarantine "$OUT/libdev.dylib" 2>/dev/null || true
else
  c++ -std=c++17 -O2 -shared -fPIC -I"$SDK/include" "$HERE/obsbot_bridge.cpp" \
    -L"$LIBDIR" -ldev -Wl,-rpath,'$ORIGIN' -o "$OUT/obsbot_bridge.so"
  cp "$LIBDIR"/libdev.so* "$OUT/"
fi
echo "ponte compilato in $OUT"
