"""Estimate a track's tempo and musical key.

Invoked by server.js as a subprocess. Prints a single JSON object on stdout:
{"bpm": 128.0, "key": "A minor", "camelot": "8A"}
"""

import json
import os
import sys
import warnings

import librosa
import numpy as np
import torch

from skey.chromanet import ChromaNet
from skey.hcqt import VQT, CropCQT

# Key comes from Deezer's S-KEY (https://github.com/deezer/skey, MIT), a ChromaNet
# trained self-supervised on unlabelled songs. Its paper reports ~72% MIREX on FMAKv2,
# against ~53% for classic Krumhansl template matching.
SKEY_CHECKPOINT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skey", "models", "skey.pt")

# Spelled the way each key is usually written (Eb major, but G# minor).
MAJOR_NAMES = ["C", "D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"]
MINOR_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "G♯", "A", "B♭", "B"]


def camelot(pitch_class, is_major):
    """Camelot wheel code, e.g. C major -> 8B, A minor -> 8A."""
    number = (7 * pitch_class + (8 if is_major else 5)) % 12 or 12
    return f"{number}{'B' if is_major else 'A'}"


def detect_key(y):
    """y: mono audio at the checkpoint's sample rate (22.05kHz)."""
    ckpt = torch.load(SKEY_CHECKPOINT, map_location="cpu", weights_only=False)
    weights = ckpt["stone"]

    # Component settings mirror skey/key_detection.py's load_model_components.
    hcqt = VQT(harmonics=[1], fmin=27.5, n_bins=99, verbose=False)
    chromanet = ChromaNet(
        n_bins=84,
        n_harmonics=1,
        out_channels=[2, 3, 40, 40, 30, 10, 3],
        kernels=[7, 7, 7, 7, 7, 5, 5],
        temperature=1,
    )
    hcqt.load_state_dict({k.replace("hcqt.", ""): v for k, v in weights.items() if "hcqt" in k})
    chromanet.load_state_dict({k.replace("chromanet.", ""): v for k, v in weights.items() if "chromanet" in k})
    hcqt.eval()
    chromanet.eval()

    peak = np.abs(y).max()
    audio = torch.from_numpy(y / peak if peak > 0 else y).float().view(1, 1, -1)
    with torch.no_grad():
        logits = chromanet(CropCQT(84)(hcqt(audio), torch.zeros(1)))
    index = int(torch.mean(logits, dim=0).argmax())

    # S-KEY's output order: 0-11 are A..G# major, 12-23 are B..Bb minor.
    is_major = index < 12
    pitch_class = (9 + index) % 12 if is_major else (index - 1) % 12
    name = (MAJOR_NAMES if is_major else MINOR_NAMES)[pitch_class]
    return f"{name} {'major' if is_major else 'minor'}", camelot(pitch_class, is_major)


def detect_bpm(y, sr):
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr, hop_length=256, units="time")
    # beat_track's own tempo is snapped to a coarse grid (100 BPM can read as 99.4), so
    # refine it from the slope of a line through the tracked beat times.
    if len(beats) >= 8:
        seconds_per_beat = np.polyfit(np.arange(len(beats)), beats, 1)[0]
        if seconds_per_beat > 0:
            return round(60.0 / seconds_per_beat, 1)
    return round(float(np.atleast_1d(tempo)[0]), 1)


def main():
    input_path = sys.argv[1]
    warnings.filterwarnings("ignore")
    y, sr = librosa.load(input_path, sr=22050, mono=True)
    key, camelot_code = detect_key(y)
    json.dump({"bpm": detect_bpm(y, sr), "key": key, "camelot": camelot_code}, sys.stdout)


if __name__ == "__main__":
    main()
