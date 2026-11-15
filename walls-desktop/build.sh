#!/usr/bin/env bash
# Builds the Windows desktop app (Electron) from the web app in ../walls.
# Usage: ./build.sh   → out/LiveWallsChart-Windows.zip
set -euo pipefail
cd "$(dirname "$0")"
cp ../walls/index.html ../walls/manifest.webmanifest ../walls/icon-192.png ../walls/icon-512.png ../walls/icon-maskable-512.png .
npm i --no-save @electron/packager@18 resedit@2 pe-library@1 >/dev/null
VER=$(node -p "require('./package.json').version")
npx electron-packager . "Live Walls Chart" --platform=win32 --arch=x64 --electron-version=38.2.0 \
  --out=out --overwrite --asar --app-version="$VER" --ignore='^/out' --ignore='^/node_modules' --ignore='build.sh' --ignore='set-exe-icon.mjs'
node set-exe-icon.mjs "out/Live Walls Chart-win32-x64/Live Walls Chart.exe" icon.ico
cd out && rm -rf "Live Walls Chart" LiveWallsChart-Windows.zip && mv "Live Walls Chart-win32-x64" "Live Walls Chart"
zip -qr -9 LiveWallsChart-Windows.zip "Live Walls Chart" && echo "built out/LiveWallsChart-Windows.zip"
