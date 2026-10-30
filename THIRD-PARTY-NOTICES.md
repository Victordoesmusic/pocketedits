# Third-party software in PocketEdits

PocketEdits itself is licensed under the GNU General Public License, version 2 or (at your option) any later version. See [LICENSE](LICENSE).

The app bundles the following open-source software. Each keeps its own licence.

| Component | Used for | Licence | Source |
| --- | --- | --- | --- |
| [FFmpeg](https://ffmpeg.org) 9.0.2 | Reading and writing audio files | LGPL 2.1 or later | https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz (built with [build/build-ffmpeg.sh](build/build-ffmpeg.sh)) |
| [LAME](https://lame.sourceforge.io) 3.100 | MP3 encoding (inside FFmpeg) | LGPL 2 or later | https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz |
| [Rubber Band Library](https://breakfastquay.com/rubberband/) 3.3.0 | Tempo change | GPL 2 or later | https://github.com/breakfastquay/rubberband/archive/v3.3.0.tar.gz |
| [pylibrb](https://github.com/pawel-glomski/pylibrb) 0.1.2 (with [libsamplerate](https://github.com/libsndfile/libsamplerate) and [fmt](https://github.com/fmtlib/fmt)) | Python binding for Rubber Band | GPL 2 (libsamplerate BSD 2-Clause, fmt MIT) | https://github.com/pawel-glomski/pylibrb/tree/v0.1.2 |
| [python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator) 0.47.0 | Vocal removal | MIT | https://github.com/nomadkaraoke/python-audio-separator |
| [S-KEY](https://github.com/deezer/skey) (Deezer) | Key detection | MIT | [vendor/skey](vendor/skey) |
| [librosa](https://librosa.org) 0.11.0 | BPM detection | ISC | https://github.com/librosa/librosa |
| [PyTorch](https://pytorch.org) 2.14.0 | Running the AI models | BSD 3-Clause | https://github.com/pytorch/pytorch |
| [CPython](https://www.python.org) 3.11.16 ([python-build-standalone](https://github.com/astral-sh/python-build-standalone)) | Runs the Python tools | PSF License | https://github.com/astral-sh/python-build-standalone |
| [Electron](https://www.electronjs.org) | App shell | MIT | https://github.com/electron/electron |
| [Express](https://expressjs.com), [Multer](https://github.com/expressjs/multer) | Local server inside the app | MIT | npm |
| [Archivo](https://github.com/Omnibus-Type/Archivo) font | Interface font | SIL Open Font License 1.1 | [public/fonts/OFL.txt](public/fonts/OFL.txt) |

The exact FFmpeg, LAME, Rubber Band and pylibrb source code used in each build is attached to its [GitHub release](https://github.com/Victordoesmusic/pocketedits/releases).

The full list of bundled Python packages and versions is in [build/requirements.txt](build/requirements.txt).

The Mel-Band RoFormer vocal models are not included in the app. They are downloaded from their authors' published releases the first time you use vocal removal.
