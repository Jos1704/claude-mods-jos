#!/bin/sh
# Compila Clawd y lo instala como ~/Applications/Clawd.app (sin ícono en el Dock).
set -e
cd "$(dirname "$0")"
cargo build --release

APP="$HOME/Applications/Clawd.app"
mkdir -p "$APP/Contents/MacOS"
cp target/release/clawd-float "$APP/Contents/MacOS/clawd-float"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Clawd</string>
  <key>CFBundleDisplayName</key><string>Clawd</string>
  <key>CFBundleIdentifier</key><string>local.clawd.float</string>
  <key>CFBundleExecutable</key><string>clawd-float</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Clawd trae al frente la terminal de tu sesión de Claude Code.</string>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "Instalado en $APP"
