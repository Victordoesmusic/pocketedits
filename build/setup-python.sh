#!/bin/zsh
# Recreates vendor/python: a relocatable CPython (python-build-standalone) with the
# packages PocketEdits uses for vocal removal, key/BPM detection and tempo change.
# Usage: zsh build/setup-python.sh
set -euo pipefail

PBS_RELEASE=20260924
PYTHON_VERSION=3.11.16

ROOT=${0:A:h:h}
ARCHIVE=cpython-$PYTHON_VERSION+$PBS_RELEASE-aarch64-apple-darwin-install_only.tar.gz
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

curl -fL -o "$WORK/$ARCHIVE" \
  "https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_RELEASE/$ARCHIVE"
rm -rf "$ROOT/vendor/python"
tar xzf "$WORK/$ARCHIVE" -C "$WORK"
mv "$WORK/python" "$ROOT/vendor/python"

"$ROOT/vendor/python/bin/python3" -m pip install --no-cache-dir -r "$ROOT/build/requirements.txt"
"$ROOT/vendor/python/bin/python3" -VV
