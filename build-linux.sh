#!/bin/bash
set -e

echo "============================================================"
echo " BASSM | Linux Build"
echo "============================================================"
echo

echo "[1/2] Installiere Abhaengigkeiten..."
npm install

echo
echo "[2/2] Erstelle Electron-App fuer Linux..."
npx electron-builder --linux --x64 --publish never --config.directories.output=dist/linux

echo
echo "============================================================"
echo " Build fertig: dist/linux/BASSM-linux-x64.AppImage"
echo "============================================================"
