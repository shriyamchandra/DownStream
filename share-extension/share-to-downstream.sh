#!/bin/bash
# Share to DownStream — standalone script
# Usage: ./share-to-downstream.sh <url> [filename]
# Or pipe URLs: echo "https://example.com/video.mp4" | ./share-to-downstream.sh

URL="${1:-}"
FILENAME="${2:-}"

if [ -z "$URL" ]; then
  # Read from stdin if no argument
  read -r URL
fi

if [ -z "$URL" ]; then
  echo "Usage: $0 <url> [filename]"
  echo "  or:  echo '<url>' | $0"
  exit 1
fi

# URL-encode the parameters
ENCODED_URL=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$URL', safe=''))" 2>/dev/null || echo "$URL")

if [ -n "$FILENAME" ]; then
  ENCODED_FILE=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$FILENAME', safe=''))" 2>/dev/null || echo "$FILENAME")
  open "downstream://add?url=${ENCODED_URL}&filename=${ENCODED_FILE}"
else
  open "downstream://add?url=${ENCODED_URL}"
fi

echo "Sent to DownStream: $URL"
