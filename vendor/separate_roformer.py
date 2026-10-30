"""Run one audio-separator model and report where each stem landed.

Invoked by server.js as a subprocess. Prints a single JSON object on stdout:
{"vocals": "<path>", "instrumental": "<path>"}
"""

import json
import os
import sys

from audio_separator.separator import Separator


def classify(filename):
    """Map audio-separator's output names onto our two stem slots."""
    lowered = filename.lower()
    if "(vocals)" in lowered:
        return "vocals"
    # Depending on the model, the non-vocal stem is labelled Instrumental, No Other or Other.
    if "(instrumental)" in lowered or "(no vocals)" in lowered or "(other)" in lowered:
        return "instrumental"
    return None


def main():
    input_path, output_dir, model_filename, model_dir = sys.argv[1:5]
    os.makedirs(model_dir, exist_ok=True)
    os.makedirs(output_dir, exist_ok=True)

    separator = Separator(
        model_file_dir=model_dir,
        output_dir=output_dir,
        output_format="wav",
        # Keep the model's own logging off stdout so it stays pure JSON.
        log_level=40,
    )
    separator.load_model(model_filename=model_filename)
    produced = separator.separate(input_path)

    stems = {}
    for name in produced:
        path = name if os.path.isabs(name) else os.path.join(output_dir, name)
        slot = classify(os.path.basename(name))
        if slot and slot not in stems:
            stems[slot] = path

    json.dump(stems, sys.stdout)


if __name__ == "__main__":
    main()
