import math

import nnAudio.features.vqt
import torch


# relies on nnAudio v0.3.2
# pip install git+https://github.com/KinWaiCheuk/nnAudio.git#subdirectory=Installation
def amplitude_to_db(x, top_db=80.0):
    """Same as torchaudio.transforms.AmplitudeToDB(top_db=80) on power input (the
    default), so torchaudio need not be bundled: 10*log10, floored per item at top_db
    below that item's peak."""
    x_db = 10.0 * torch.log10(torch.clamp(x, min=1e-10))
    peak = x_db.reshape(x_db.shape[0], -1).amax(dim=1).view(-1, *([1] * (x_db.dim() - 1)))
    return torch.max(x_db, peak - top_db)


class VQT(nnAudio.features.vqt.VQT):
    r"""Harmonic VQT: A collection of VQTs with different shifts.
    Inspired by Bittner, McFee, Salamon, Li, Bello.
    "Deep Salience Representations for F0 Estimation in Polyphonic Music". ISMIR 2017

    Args:
        harmonics (Collection[float]): Harmonics to be included.
        fmin (float): Minimum frequency to be included.
        n_bins (int): Number of bins in the output spectrogram.
        bins_per_octave (int, optional): Number of bins per octave. Defaults to 12.
    """

    def __init__(self, *, harmonics, fmin, n_bins, bins_per_octave=12, **kwargs):
        self.harmonics = harmonics
        self.bin_shifts = []
        self.n_bins_per_slice = n_bins
        self.fmin = fmin
        for harmonic in harmonics:
            shift = round(bins_per_octave * math.log2(harmonic))
            self.bin_shifts.append(shift)
        low_octave_shift = min([0] + self.bin_shifts) / bins_per_octave
        fmin = fmin * (2**low_octave_shift)
        n_bins = n_bins + max([0] + self.bin_shifts) - min([0] + self.bin_shifts)
        super().__init__(fmin=fmin, n_bins=n_bins, bins_per_octave=bins_per_octave, **kwargs)

    def forward(self, x, output_format="Magnitude", normalization_type="librosa"):
        vqt = super().forward(x, output_format, normalization_type)
        hvqt = []
        for shift in self.bin_shifts:
            bin_start = shift - min([0] + self.bin_shifts)
            bin_stop = bin_start + self.n_bins_per_slice
            vqt_slice = vqt[:, bin_start:bin_stop, ...]
            hvqt.append(vqt_slice)
        hvqt = torch.stack(hvqt, dim=1)
        log_hcqt = ((1.0 / 80.0) * amplitude_to_db(hvqt, top_db=80)) + 1.0
        return log_hcqt


class CropCQT(torch.nn.Module):
    """
    A PyTorch module for cropping Constant-Q Transform (CQT) spectrograms.

    Args:
        height (int): The height of the cropped spectrogram.

    Methods:
        forward(spectrograms, transpose):
            Crops the input spectrograms based on the provided transpose values.

            Args:
                spectrograms (torch.Tensor): A batch of spectrograms to be cropped.
                transpose (torch.Tensor): A tensor containing the starting indices for cropping.

            Returns:
                torch.Tensor: A batch of cropped spectrograms.
    """

    def __init__(self, height: int):
        super(CropCQT, self).__init__()
        self.height = height

    def forward(self, spectrograms: torch.Tensor, transpose: torch.Tensor) -> torch.Tensor:
        return torch.stack(
            [s[:, int(start_idx) : int(start_idx) + self.height, :] for s, start_idx in zip(spectrograms, transpose)]
        )
