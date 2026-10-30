// Shared audio plumbing for the Edit and Join tabs.
//
// Audio is held as { sampleRate, channels: [Float32Array, ...] } (one or two channels).
// The server decodes any format to float WAV (/api/decode), and everything else here
// is plain sample math, so previews and edits are instant and exact.

const AudioTools = (() => {
  // ---------- WAV in/out ----------

  function parseWav(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const tag = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file.');

    let format = null;
    let offset = 12;
    while (offset + 8 <= view.byteLength) {
      const id = tag(offset);
      const size = view.getUint32(offset + 4, true);
      const body = offset + 8;
      if (id === 'fmt ') {
        let code = view.getUint16(body, true);
        // WAVE_FORMAT_EXTENSIBLE keeps the real format code at the start of its sub-format GUID.
        if (code === 0xfffe) code = view.getUint16(body + 24, true);
        format = {
          code,
          channels: view.getUint16(body + 2, true),
          sampleRate: view.getUint32(body + 4, true),
          bits: view.getUint16(body + 14, true),
        };
      } else if (id === 'data' && format) {
        // ffmpeg streaming to a pipe can leave the size as 0xFFFFFFFF; trust the buffer then.
        const dataSize = Math.min(size, view.byteLength - body);
        return decodeSamples(view, body, dataSize, format);
      }
      offset = body + size + (size % 2);
    }
    throw new Error('WAV file has no audio data.');
  }

  function decodeSamples(view, start, size, { code, channels, sampleRate, bits }) {
    const bytes = bits / 8;
    const frames = Math.floor(size / (bytes * channels));
    const out = Array.from({ length: channels }, () => new Float32Array(frames));
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        const p = start + (i * channels + c) * bytes;
        let v;
        if (code === 3) v = bits === 64 ? view.getFloat64(p, true) : view.getFloat32(p, true);
        else if (bits === 16) v = view.getInt16(p, true) / 32768;
        else if (bits === 24) v = ((view.getUint8(p + 2) << 24) | (view.getUint8(p + 1) << 16) | (view.getUint8(p) << 8)) / 2147483648;
        else if (bits === 32) v = view.getInt32(p, true) / 2147483648;
        else v = (view.getUint8(p) - 128) / 128;
        out[c][i] = v;
      }
    }
    return { sampleRate, channels: out };
  }

  // 32-bit float WAV: lossless hand-off to the server for stretching and encoding.
  function encodeWav(audio) {
    const { sampleRate, channels } = audio;
    const n = channels.length;
    const frames = channels[0].length;
    const buffer = new ArrayBuffer(44 + frames * n * 4);
    const view = new DataView(buffer);
    const writeTag = (o, s) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
    writeTag(0, 'RIFF');
    view.setUint32(4, 36 + frames * n * 4, true);
    writeTag(8, 'WAVE');
    writeTag(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 3, true);
    view.setUint16(22, n, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * n * 4, true);
    view.setUint16(32, n * 4, true);
    view.setUint16(34, 32, true);
    writeTag(36, 'data');
    view.setUint32(40, frames * n * 4, true);
    const samples = new Float32Array(buffer, 44);
    for (let i = 0; i < frames; i++) for (let c = 0; c < n; c++) samples[i * n + c] = channels[c][i];
    return new Blob([buffer], { type: 'audio/wav' });
  }

  async function errorFrom(response, fallback) {
    const data = await response.json().catch(() => ({}));
    return new Error(data.error || fallback);
  }

  async function decodeFile(file, { signal } = {}) {
    const form = new FormData();
    form.append('file', file);
    const response = await fetch('/api/decode', { method: 'POST', body: form, signal });
    if (!response.ok) throw await errorFrom(response, `Could not open "${file.name}".`);
    return parseWav(await response.arrayBuffer());
  }

  async function stretch(audio, factor, preservePitch, { signal } = {}) {
    const form = new FormData();
    form.append('file', encodeWav(audio), 'audio.wav');
    form.append('factor', String(factor));
    form.append('preservePitch', preservePitch ? '1' : '0');
    const response = await fetch('/api/stretch', { method: 'POST', body: form, signal });
    if (!response.ok) throw await errorFrom(response, 'Tempo change failed.');
    return parseWav(await response.arrayBuffer());
  }

  async function analyzeBpm(audio, { signal } = {}) {
    const form = new FormData();
    form.append('file', encodeWav(audio), 'audio.wav');
    const response = await fetch('/api/analyze', { method: 'POST', body: form, signal });
    if (!response.ok) throw await errorFrom(response, 'Could not detect the BPM.');
    return (await response.json()).bpm;
  }

  // output: { format, quality } from a FormatPicker. Resolves with saveResponse()'s result.
  async function save(audio, output, title, { signal } = {}) {
    const form = new FormData();
    form.append('format', output.format);
    form.append('quality', output.quality);
    form.append('sampleRate', output.sampleRate || 'original');
    form.append('title', title);
    form.append('file', encodeWav(audio), 'audio.wav');
    const response = await fetch('/api/encode', { method: 'POST', body: form, signal });
    return saveResponse(response);
  }

  // ---------- Sample math ----------

  const duration = (audio) => audio.channels[0].length / audio.sampleRate;
  const frameOf = (audio, seconds) => Math.max(0, Math.min(audio.channels[0].length, Math.round(seconds * audio.sampleRate)));
  const map = (audio, fn) => ({ sampleRate: audio.sampleRate, channels: audio.channels.map(fn) });

  function slice(audio, startSec, endSec) {
    const a = frameOf(audio, startSec);
    const b = frameOf(audio, endSec);
    return map(audio, (ch) => ch.slice(a, b));
  }

  // t runs 0→1 across the fade. "Curved" is a squared (exponential-style) shape: a fade-in
  // starts gently and a fade-out drops fast then tails off, which sounds more even to the ear.
  function fadeGain(t, curve) {
    return curve === 'curved' ? t * t : t;
  }

  function fade(audio, inSec, outSec, curve) {
    const frames = audio.channels[0].length;
    const inFrames = Math.min(frames, Math.round(inSec * audio.sampleRate));
    const outFrames = Math.min(frames, Math.round(outSec * audio.sampleRate));
    return map(audio, (ch) => {
      const out = ch.slice();
      for (let i = 0; i < inFrames; i++) out[i] *= fadeGain(i / inFrames, curve);
      for (let i = 0; i < outFrames; i++) out[frames - 1 - i] *= fadeGain(i / outFrames, curve);
      return out;
    });
  }

  // Finds how much leading/trailing silence to cut. Loudness is measured as the peak of
  // 10 ms windows across all channels, so a single click doesn't count as silence ending
  // early but a quiet intro above the threshold is kept.
  function findSilence(audio, { thresholdDb, minSilenceSec, paddingSec, start = true, end = true }) {
    const { sampleRate, channels } = audio;
    const frames = channels[0].length;
    const win = Math.max(1, Math.round(sampleRate * 0.01));
    const threshold = Math.pow(10, thresholdDb / 20);
    const loud = (w) => {
      const a = w * win;
      const b = Math.min(frames, a + win);
      for (const ch of channels) for (let i = a; i < b; i++) if (Math.abs(ch[i]) > threshold) return true;
      return false;
    };
    const windows = Math.ceil(frames / win);
    let first = 0;
    while (first < windows && !loud(first)) first++;
    if (first === windows) return { allSilent: true, startSec: 0, endSec: 0 };
    let last = windows - 1;
    while (last > first && !loud(last)) last--;

    const leadSec = (first * win) / sampleRate;
    const tailSec = Math.max(0, frames - Math.min(frames, (last + 1) * win)) / sampleRate;
    const cut = (silence) => (silence >= minSilenceSec ? Math.max(0, silence - paddingSec) : 0);
    return {
      allSilent: false,
      startSec: start ? cut(leadSec) : 0,
      endSec: end ? cut(tailSec) : 0,
    };
  }

  function trimSilence(audio, silence) {
    return slice(audio, silence.startSec, duration(audio) - silence.endSec);
  }

  const CHANNEL_OPS = {
    mono: (a) => {
      const [l, r] = a.channels;
      const m = new Float32Array(l.length);
      for (let i = 0; i < l.length; i++) m[i] = (l[i] + r[i]) / 2;
      return { sampleRate: a.sampleRate, channels: [m] };
    },
    left: (a) => ({ sampleRate: a.sampleRate, channels: [a.channels[0].slice()] }),
    right: (a) => ({ sampleRate: a.sampleRate, channels: [a.channels[1].slice()] }),
    swap: (a) => ({ sampleRate: a.sampleRate, channels: [a.channels[1].slice(), a.channels[0].slice()] }),
    dual: (a) => ({ sampleRate: a.sampleRate, channels: [a.channels[0].slice(), a.channels[0].slice()] }),
  };

  function withChannels(audio, count) {
    if (audio.channels.length === count) return audio;
    return count === 2 ? CHANNEL_OPS.dual(audio) : CHANNEL_OPS.mono(audio);
  }

  // Chromium's resampler, via an offline render. Used to bring joined files to one rate.
  async function resample(audio, targetRate) {
    if (audio.sampleRate === targetRate) return audio;
    const n = audio.channels.length;
    const frames = Math.ceil((audio.channels[0].length * targetRate) / audio.sampleRate);
    const ctx = new OfflineAudioContext(n, frames, targetRate);
    const source = ctx.createBufferSource();
    source.buffer = toAudioBuffer(audio);
    source.connect(ctx.destination);
    source.start();
    const rendered = await ctx.startRendering();
    return { sampleRate: targetRate, channels: Array.from({ length: n }, (_, c) => rendered.getChannelData(c).slice()) };
  }

  // Joins clips that already share a rate and channel count. gapSec inserts silence;
  // crossfadeSec overlaps neighbours with an equal-power crossfade so loudness stays even.
  function join(clips, { mode, seconds }) {
    const { sampleRate } = clips[0];
    const n = clips[0].channels.length;
    const span = Math.round((seconds || 0) * sampleRate);
    let total = 0;
    clips.forEach((clip, i) => {
      total += clip.channels[0].length;
      if (i > 0 && mode === 'gap') total += span;
      if (i > 0 && mode === 'crossfade') total -= overlapFrames(clips[i - 1], clip, span);
    });

    const out = Array.from({ length: n }, () => new Float32Array(total));
    let pos = 0;
    clips.forEach((clip, i) => {
      const frames = clip.channels[0].length;
      let overlap = 0;
      if (i > 0 && mode === 'gap') pos += span;
      if (i > 0 && mode === 'crossfade') overlap = overlapFrames(clips[i - 1], clip, span);
      const startAt = pos - overlap;
      for (let c = 0; c < n; c++) {
        const src = clip.channels[c];
        const dst = out[c];
        for (let k = 0; k < overlap; k++) {
          const t = (k + 0.5) / overlap;
          dst[startAt + k] = dst[startAt + k] * Math.cos((t * Math.PI) / 2) + src[k] * Math.sin((t * Math.PI) / 2);
        }
        dst.set(src.subarray(overlap), pos);
      }
      pos = startAt + frames;
    });
    return { sampleRate, channels: out };
  }

  // A crossfade can't be longer than half of either clip, or it would swallow it.
  function overlapFrames(a, b, span) {
    return Math.min(span, Math.floor(a.channels[0].length / 2), Math.floor(b.channels[0].length / 2));
  }

  // ---------- Playback ----------

  let context = null;
  function audioContext() {
    if (!context) context = new AudioContext();
    return context;
  }

  function toAudioBuffer(audio) {
    const buffer = new AudioBuffer({
      length: Math.max(1, audio.channels[0].length),
      numberOfChannels: audio.channels.length,
      sampleRate: audio.sampleRate,
    });
    audio.channels.forEach((ch, c) => buffer.copyToChannel(ch, c));
    return buffer;
  }

  // One shared player, so starting any preview stops whatever else was playing.
  const player = {
    source: null,
    startedAt: 0,
    offset: 0,
    onEnd: null,

    play(audio, fromSec = 0, toSec = duration(audio), onEnd = null) {
      this.stop();
      const ctx = audioContext();
      const source = ctx.createBufferSource();
      source.buffer = toAudioBuffer(audio);
      source.connect(ctx.destination);
      source.onended = () => {
        if (this.source !== source) return;
        this.source = null;
        const done = this.onEnd;
        this.onEnd = null;
        if (done) done();
      };
      this.source = source;
      this.offset = fromSec;
      this.onEnd = onEnd;
      this.startedAt = ctx.currentTime;
      source.start(0, fromSec, Math.max(0, toSec - fromSec));
    },

    stop() {
      if (!this.source) return;
      const source = this.source;
      const done = this.onEnd;
      this.source = null;
      this.onEnd = null;
      try {
        source.stop();
      } catch {
        // already stopped
      }
      if (done) done();
    },

    get playing() {
      return Boolean(this.source);
    },

    get position() {
      return this.offset + (audioContext().currentTime - this.startedAt);
    },
  };

  // ---------- Formatting ----------

  function formatTime(seconds, decimals = 1) {
    // Round first so 59.96s shows as 1:00.0, not 0:60.0.
    const s = Math.round(Math.max(0, seconds) * 10 ** decimals) / 10 ** decimals;
    const m = Math.floor(s / 60);
    const rest = (s - m * 60).toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0');
    return `${m}:${rest}`;
  }

  // Accepts 75, 75.5, 1:15, 1:15.5 → seconds; null if it doesn't parse.
  function parseTime(text) {
    const parts = String(text).trim().split(':');
    if (parts.length > 3 || parts.some((p) => p === '' || isNaN(Number(p)))) return null;
    return parts.reduce((total, p) => total * 60 + Number(p), 0);
  }

  return {
    parseWav,
    encodeWav,
    decodeFile,
    stretch,
    analyzeBpm,
    save,
    duration,
    slice,
    fade,
    fadeGain,
    findSilence,
    trimSilence,
    CHANNEL_OPS,
    withChannels,
    resample,
    join,
    player,
    audioContext,
    formatTime,
    parseTime,
  };
})();
