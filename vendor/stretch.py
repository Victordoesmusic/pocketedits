"""Change a track's tempo, optionally keeping its pitch.

Invoked by server.js as a subprocess:
    stretch.py <input.wav> <output.wav> <tempo factor> <preserve pitch: 1|0>
A factor of 1.25 plays 25% faster. Writes a float WAV at the input's sample rate.
"""

import sys

import numpy as np
import pylibrb
import soundfile as sf
import soxr

# Rubber Band's R3 ("finer") engine — https://breakfastquay.com/rubberband/ (GPL). It is
# the best-sounding open-source stretcher on full mixes, vocals and bass-heavy music.
OPTIONS = (
    pylibrb.Option.PROCESS_OFFLINE
    | pylibrb.Option.ENGINE_FINER
    | pylibrb.Option.CHANNELS_TOGETHER
    | pylibrb.Option.FORMANT_PRESERVED
)
CHUNK = 16384


def stretch_keep_pitch(audio, sr, factor):
    """audio: (channels, samples) float32."""
    stretcher = pylibrb.RubberBandStretcher(
        sample_rate=sr, channels=audio.shape[0], options=OPTIONS, initial_time_ratio=1.0 / factor
    )
    stretcher.set_expected_input_duration(audio.shape[1])
    stretcher.set_max_process_size(CHUNK)

    # Offline mode reads the whole track once first, so it can place transients exactly.
    for start in range(0, audio.shape[1], CHUNK):
        stretcher.study(audio[:, start : start + CHUNK], final=start + CHUNK >= audio.shape[1])

    out = []
    for start in range(0, audio.shape[1], CHUNK):
        stretcher.process(audio[:, start : start + CHUNK], final=start + CHUNK >= audio.shape[1])
        if stretcher.available() > 0:
            out.append(stretcher.retrieve_available())
    while not stretcher.is_done() or stretcher.available() > 0:
        if stretcher.available() > 0:
            out.append(stretcher.retrieve_available())
    return np.concatenate(out, axis=1)


def change_speed(audio, sr, factor):
    """Tape-style: tempo and pitch move together, like speeding up a record."""
    return soxr.resample(audio.T, sr * factor, sr, quality="VHQ").T


def main():
    input_path, output_path, factor, preserve = sys.argv[1:5]
    factor = float(factor)
    data, sr = sf.read(input_path, dtype="float32", always_2d=True)
    audio = np.ascontiguousarray(data.T)

    if abs(factor - 1.0) < 1e-6:
        result = audio
    elif preserve == "1":
        result = stretch_keep_pitch(audio, sr, factor)
    else:
        result = change_speed(audio, sr, factor)

    sf.write(output_path, np.ascontiguousarray(result.T), sr, subtype="FLOAT")


if __name__ == "__main__":
    main()
