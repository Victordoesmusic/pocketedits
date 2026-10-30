#!/bin/zsh
# Builds the audio-only FFmpeg that PocketEdits bundles (vendor/ffmpeg/ffmpeg).
# LGPL v2.1+ (no --enable-gpl / --enable-nonfree), statically linked with LAME for MP3.
# Every built-in decoder and demuxer stays, so any audio or video file still opens;
# only the encoders and muxers PocketEdits saves with are kept.
# Usage: build/build-ffmpeg.sh [work-dir]   (sources are downloaded into work-dir)
set -euo pipefail

FFMPEG_VERSION=9.0.2
LAME_VERSION=3.100
MACOS_MIN=12.0

ROOT=${0:A:h:h}
WORK=${1:-$ROOT/build/ffmpeg-work}
PREFIX=$WORK/prefix
JOBS=$(sysctl -n hw.ncpu)
export MACOSX_DEPLOYMENT_TARGET=$MACOS_MIN
mkdir -p "$WORK/src" "$PREFIX"
cd "$WORK/src"

[[ -f lame-$LAME_VERSION.tar.gz ]] ||
  curl -fL -o lame-$LAME_VERSION.tar.gz "https://downloads.sourceforge.net/project/lame/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz"
[[ -f ffmpeg-$FFMPEG_VERSION.tar.xz ]] ||
  curl -fL -o ffmpeg-$FFMPEG_VERSION.tar.xz "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"

# LAME (LGPL): static library only.
rm -rf lame-$LAME_VERSION && tar xzf lame-$LAME_VERSION.tar.gz
# lame_init_old is listed as an export but not built; the macOS linker rejects that.
sed -i '' '/lame_init_old/d' lame-$LAME_VERSION/include/libmp3lame.sym
(cd lame-$LAME_VERSION &&
  ./configure --prefix="$PREFIX" --host=aarch64-apple-darwin --disable-shared --enable-static \
    --disable-frontend --disable-decoder CFLAGS="-O2 -mmacosx-version-min=$MACOS_MIN" &&
  make -j"$JOBS" && make install)

rm -rf ffmpeg-$FFMPEG_VERSION && tar xJf ffmpeg-$FFMPEG_VERSION.tar.xz
(cd ffmpeg-$FFMPEG_VERSION &&
  ./configure \
    --prefix="$PREFIX" --arch=arm64 --cc=clang \
    --extra-cflags="-I$PREFIX/include -mmacosx-version-min=$MACOS_MIN" \
    --extra-ldflags="-L$PREFIX/lib -mmacosx-version-min=$MACOS_MIN" \
    --disable-autodetect --enable-zlib --enable-libmp3lame \
    --disable-doc --disable-debug --disable-network --disable-avdevice \
    --disable-programs --enable-ffmpeg \
    --disable-encoders --enable-encoder=libmp3lame,aac,flac,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le \
    --disable-muxers --enable-muxer=mp3,ipod,mp4,wav,flac,null \
    --disable-protocols --enable-protocol=file,pipe \
    --disable-indevs --disable-outdevs --disable-hwaccels &&
  make -j"$JOBS")

mkdir -p "$ROOT/vendor/ffmpeg"
cp ffmpeg-$FFMPEG_VERSION/ffmpeg "$ROOT/vendor/ffmpeg/ffmpeg"
strip "$ROOT/vendor/ffmpeg/ffmpeg"
cp ffmpeg-$FFMPEG_VERSION/COPYING.LGPLv2.1 "$ROOT/vendor/ffmpeg/LICENSE-FFmpeg.txt"
cp lame-$LAME_VERSION/COPYING "$ROOT/vendor/ffmpeg/LICENSE-LAME.txt"
"$ROOT/vendor/ffmpeg/ffmpeg" -hide_banner -version | head -1
