#!/bin/bash
# Generate icon files for Felix
# Requires: Inkscape or rsvg-convert (librsvg)

ICON_SVG="icon.svg"
OUTPUT_DIR="icons"

mkdir -p "$OUTPUT_DIR"

# Check for available converters
if command -v rsvg-convert &> /dev/null; then
    CONVERTER="rsvg"
elif command -v inkscape &> /dev/null; then
    CONVERTER="inkscape"
elif command -v convert &> /dev/null; then
    CONVERTER="imagemagick"
else
    echo "No SVG converter found. Please install one of:"
    echo "  - librsvg (brew install librsvg)"
    echo "  - Inkscape (brew install inkscape)"
    echo "  - ImageMagick (brew install imagemagick)"
    exit 1
fi

echo "Using $CONVERTER to generate icons..."

# Icon sizes needed
SIZES=(16 32 64 128 256 512 1024)

for SIZE in "${SIZES[@]}"; do
    echo "Generating ${SIZE}x${SIZE}..."

    if [ "$CONVERTER" = "rsvg" ]; then
        rsvg-convert -w $SIZE -h $SIZE "$ICON_SVG" -o "$OUTPUT_DIR/icon-${SIZE}.png"
    elif [ "$CONVERTER" = "inkscape" ]; then
        inkscape --export-type=png --export-width=$SIZE --export-height=$SIZE "$ICON_SVG" -o "$OUTPUT_DIR/icon-${SIZE}.png"
    elif [ "$CONVERTER" = "imagemagick" ]; then
        convert -background none -resize ${SIZE}x${SIZE} "$ICON_SVG" "$OUTPUT_DIR/icon-${SIZE}.png"
    fi
done

# Create macOS iconset
echo "Creating macOS iconset..."
ICONSET_DIR="Felix.iconset"
mkdir -p "$ICONSET_DIR"

cp "$OUTPUT_DIR/icon-16.png" "$ICONSET_DIR/icon_16x16.png"
cp "$OUTPUT_DIR/icon-32.png" "$ICONSET_DIR/icon_16x16@2x.png"
cp "$OUTPUT_DIR/icon-32.png" "$ICONSET_DIR/icon_32x32.png"
cp "$OUTPUT_DIR/icon-64.png" "$ICONSET_DIR/icon_32x32@2x.png"
cp "$OUTPUT_DIR/icon-128.png" "$ICONSET_DIR/icon_128x128.png"
cp "$OUTPUT_DIR/icon-256.png" "$ICONSET_DIR/icon_128x128@2x.png"
cp "$OUTPUT_DIR/icon-256.png" "$ICONSET_DIR/icon_256x256.png"
cp "$OUTPUT_DIR/icon-512.png" "$ICONSET_DIR/icon_256x256@2x.png"
cp "$OUTPUT_DIR/icon-512.png" "$ICONSET_DIR/icon_512x512.png"
cp "$OUTPUT_DIR/icon-1024.png" "$ICONSET_DIR/icon_512x512@2x.png"

# Generate .icns file
if command -v iconutil &> /dev/null; then
    iconutil -c icns "$ICONSET_DIR"
    echo "Created Felix.icns"
fi

echo "Done! Icons saved to $OUTPUT_DIR/"
