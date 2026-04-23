#!/bin/bash
# Package the extension for Edge/Chrome store

cd "$(dirname "$0")"

VERSION=$(grep '"version"' manifest.json | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/')
OUT="jellyfin-dual-subtitle-${VERSION}.zip"

echo "Packaging Jellyfin Dual Subtitle Extension v${VERSION}..."

# Generate icons if not exist
if [ ! -f icons/icon128.png ]; then
    echo "Generating icons..."
    cd icons && python3 generate.py && cd ..
fi

# Create zip
zip -r "$OUT" \
    manifest.json \
    background/ \
    content_scripts/ \
    popup/ \
    options/ \
    lib/ \
    icons/*.png \
    _locales/ \
    -x "*/generate.py" \
    -x "*/package.sh"

echo "Created: $OUT"
echo "Load this folder or zip in edge://extensions (Developer mode)"
