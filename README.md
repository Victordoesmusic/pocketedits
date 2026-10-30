# PocketEdits

A free, simple audio toolkit for Mac. Drop in a song and get to work.

- **Remove vocals**: remove all vocals, or only the lead vocal (keeping the harmonies)
- **Key & BPM**: find a song's key and tempo
- **Edit**: trim, fade in/out, cut silence, switch to mono, change tempo without changing pitch
- **Join**: merge several files into one
- **Convert**: any audio or video file to MP3, M4A, WAV or FLAC
- **Metronome**

Everything runs on your Mac. Your files are never uploaded anywhere.

## Download

Get the latest `.dmg` from [Releases](../../releases/latest), open it, and drag PocketEdits into Applications.

**Requirements:** a Mac with Apple Silicon (M1 or newer), macOS 12 or later, and an internet connection when the app opens.

The app is signed and notarised by Apple, so it opens without security warnings.

## Support PocketEdits

PocketEdits is free. If it helps you, you can [buy me a coffee on Ko-fi](https://ko-fi.com/victorsaudiogadgets) ☕

## Build from source

You need macOS on Apple Silicon, Node.js 20+ and the Xcode Command Line Tools (`xcode-select --install`).

```sh
npm install
zsh build/setup-python.sh     # bundled Python + AI packages (~1.3 GB)
zsh build/build-ffmpeg.sh     # audio-only FFmpeg (LGPL)
npm run electron              # run the app
```

`npm run dist` builds the `.dmg`. It is set up to sign and notarise with my Apple Developer ID, so for your own build set `mac.identity` to `null` and `mac.notarize` to `false` in `package.json`.

## Licence

PocketEdits is free software under the [GNU GPL v2 or later](LICENSE). It includes FFmpeg, Rubber Band and other open-source projects; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
