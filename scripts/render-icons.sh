#!/bin/sh
# Renders the committed PNG/ICO icons from their SVG sources. macOS only (sips).
set -eu
cd "$(dirname "$0")/.."
web=apps/web
desktop=apps/desktop/static/icons
render() { sips -s format "$1" -z "$2" "$2" "$3" --out "$4" >/dev/null; }

render ico 32 "$web/public/favicon.svg" "$web/public/favicon.ico"
render png 192 "$web/public/favicon.svg" "$web/public/icon-192.png"
render png 512 "$web/public/favicon.svg" "$web/public/icon-512.png"
render png 512 "$web/brand/maskable-icon.svg" "$web/public/icon-maskable-512.png"
render png 180 "$web/brand/touch-icon.svg" "$web/public/apple-touch-icon.png"

render png 1024 "$desktop/icon.svg" "$desktop/icon.png"
render png 18 "$desktop/trayTemplate.svg" "$desktop/trayTemplate.png"
render png 36 "$desktop/trayTemplate.svg" "$desktop/trayTemplate@2x.png"
