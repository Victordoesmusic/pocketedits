const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const multer = require('multer');

const app = express();
const DEFAULT_PORT = 3000;

// When packaged by electron-builder, native binaries live outside app.asar
// (asarUnpack) since a binary can't be executed from inside the asar archive.
// This is a no-op in dev, where nothing is packed into an asar in the first place.
function unpackedPath(p) {
  return p.replace('app.asar', 'app.asar.unpacked');
}

// Audio-only LGPL FFmpeg built by build/build-ffmpeg.sh (the ffmpeg-static build has
// nonfree parts and can't be redistributed).
const ffmpegPath = unpackedPath(path.join(__dirname, 'vendor', 'ffmpeg', 'ffmpeg'));

function runFfmpeg(args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 20, signal }, (error, stdout, stderr) => {
      if (error) return reject(Object.assign(error, { stderr, stdout }));
      resolve({ stdout, stderr });
    });
  });
}

// Vocal/instrumental separation runs on RoFormer models via a relocatable Python bundled in
// vendor/. A normal venv would break here: it points at whichever Python built it, and
// that Python (Xcode Command Line Tools) isn't present on a stock Mac.
const PYTHON_PATH = unpackedPath(path.join(__dirname, 'vendor', 'python', 'bin', 'python3'));

// The client may have disconnected (e.g. the Stop button) by the time a route is ready
// to respond — writing to an already-closed response throws, so every response goes
// through this guard instead of calling res.status()/json() directly.
function safeRespond(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.status(status).json(body);
  } catch {
    // client is gone; nothing to do
  }
}

// Builds a Content-Disposition header safe for both old (Latin-1 only) and
// modern (UTF-8 via RFC 5987) clients, then streams the file and deletes the
// given temp files once the response finishes (successfully or not).
const AUDIO_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4' };

function sendAudioFile(res, filePath, title, cleanupPaths, ext = 'mp3') {
  const cleanup = () => cleanupPaths.forEach((p) => fs.unlink(p, () => {}));

  if (res.writableEnded || res.destroyed) {
    cleanup();
    return;
  }

  const asciiSafeName = title
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/[^\x20-\xff]/g, '')
    .trim()
    .slice(0, 100) || 'audio';

  res.setHeader('Content-Type', AUDIO_TYPES[ext]);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiSafeName}.${ext}"; filename*=UTF-8''${encodeURIComponent(title.slice(0, 150))}.${ext}`
  );

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('close', cleanup);
  stream.on('error', cleanup);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4GB — video files run much larger than WAV
  // Browsers send file names as UTF-8; multer's latin1 default turns Chinese names into mojibake.
  defParamCharset: 'utf8',
});

// Video formats are accepted too: ffmpeg's -vn flag drops the video stream and keeps the audio.
const MEDIA_EXT_RE = /\.(wav|wave|aiff?|flac|m4a|aac|ogg|opus|wma|caf|mp3|mp4|mov|m4v|avi|mkv|webm|flv|wmv|mpe?g|3gp|ts)$/i;

// --- Output formats (Convert, Edit and Join all save through these) ---

// Allowed qualities per format; the first is the default. Anything else is rejected, so
// format/quality can be passed straight into ffmpeg arguments.
// maxRate is the codec's ceiling: LAME (MP3) stops at 48 kHz and ffmpeg's AAC at 96 kHz,
// so an "original" rate above that is brought down to the nearest rate in the same family.
const OUTPUT_FORMATS = {
  mp3: { qualities: ['320', '256', '192', '128'], sampleRates: ['original', '44100', '48000'], maxRate: 48000 },
  m4a: { qualities: ['256', '192', '128'], sampleRates: ['original', '44100', '48000', '96000'], maxRate: 96000 },
  wav: { qualities: ['24', '16', '32f'], sampleRates: ['original', '44100', '48000', '88200', '96000'] },
  flac: { qualities: ['16', '24'], sampleRates: ['original', '44100', '48000', '88200', '96000'] },
};

function resolveFormat(format, quality, sampleRate) {
  const spec = OUTPUT_FORMATS[format] ? format : 'mp3';
  const { qualities, sampleRates } = OUTPUT_FORMATS[spec];
  return {
    format: spec,
    quality: qualities.includes(String(quality)) ? String(quality) : qualities[0],
    sampleRate: sampleRates.includes(String(sampleRate)) ? String(sampleRate) : 'original',
  };
}

// ffmpeg prints the input's streams and exits non-zero when given no output; that's
// all a probe needs.
async function probeSampleRate(input, { signal } = {}) {
  try {
    await runFfmpeg(['-hide_banner', '-i', input], { signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    const m = (err.stderr || '').match(/Audio:[^\n]*?(\d+) Hz/);
    return m ? Number(m[1]) : null;
  }
  return null;
}

// Codec arguments plus -ar when the rate must change: an explicit choice, or a source
// faster than the codec allows. "Original" otherwise leaves the rate untouched.
async function encodeArgs(output, input, { signal } = {}) {
  const args = codecArgs(output);
  const { maxRate } = OUTPUT_FORMATS[output.format];
  let rate = output.sampleRate === 'original' ? null : Number(output.sampleRate);
  if (!rate && maxRate) {
    const source = await probeSampleRate(input, { signal });
    if (source && source > maxRate) rate = source % 11025 === 0 ? (maxRate === 48000 ? 44100 : 88200) : maxRate;
  }
  return rate ? [...args, '-ar', String(rate)] : args;
}

function codecArgs({ format, quality }) {
  switch (format) {
    case 'm4a':
      return ['-codec:a', 'aac', '-b:a', `${quality}k`, '-movflags', '+faststart'];
    case 'wav':
      return ['-codec:a', { 16: 'pcm_s16le', 24: 'pcm_s24le', '32f': 'pcm_f32le' }[quality]];
    case 'flac':
      return quality === '24' ? ['-codec:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24'] : ['-codec:a', 'flac', '-sample_fmt', 's16'];
    default:
      return ['-codec:a', 'libmp3lame', '-b:a', `${quality}k`];
  }
}

// --- Background jobs with progress (Convert tab) ---
// A conversion starts as a job and the page polls it for progress, then fetches the file.
// One long request can't report progress, and polling survives the page being busy.

const JOB_TTL_MS = 60 * 60 * 1000;
const jobs = new Map();

function createJob() {
  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id,
    state: 'running',
    stage: 'Starting…',
    progress: null, // 0..1, or null when the current step can't measure it
    title: 'audio',
    ext: null,
    outPath: null,
    error: null,
    controller: new AbortController(),
    touched: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

// Every temp file a job makes starts with this, so disposal can sweep partial files too.
const jobPrefix = (job) => `job-${job.id}`;

function disposeJob(job) {
  job.controller.abort();
  jobs.delete(job.id);
  fs.readdir(os.tmpdir(), (err, names) => {
    if (err) return;
    names.filter((n) => n.startsWith(jobPrefix(job))).forEach((n) => fs.unlink(path.join(os.tmpdir(), n), () => {}));
  });
}

setInterval(() => {
  for (const job of jobs.values()) if (Date.now() - job.touched > JOB_TTL_MS) disposeJob(job);
}, 10 * 60 * 1000).unref();

function setProgress(job, stage, progress) {
  job.stage = stage;
  job.progress = progress === null ? null : Math.max(0, Math.min(1, progress));
  job.touched = Date.now();
}

// Like execFile, but hands over output line by line as it arrives (for progress parsing).
function spawnLines(cmd, args, { signal, onStdoutLine, onStderrLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { signal });
    const keep = { stdout: '', stderr: '' };
    const pump = (name, onLine) => {
      let partial = '';
      child[name].on('data', (chunk) => {
        const text = chunk.toString();
        // Only the tail is kept for error messages; progress output can be long.
        keep[name] = (keep[name] + text).slice(-200000);
        if (!onLine) return;
        const lines = (partial + text).split(/\r?\n|\r/);
        partial = lines.pop();
        lines.forEach(onLine);
      });
    };
    pump('stdout', onStdoutLine);
    pump('stderr', onStderrLine);
    child.on('error', (err) => reject(Object.assign(err, keep)));
    child.on('close', (code) => {
      if (code === 0) resolve(keep);
      else reject(Object.assign(new Error(`${path.basename(cmd)} exited with code ${code}`), keep));
    });
  });
}

// ffmpeg encode that reports 0..1 via onProgress, using the input's duration from its log
// and -progress's out_time. Progress stays null if the duration isn't known.
function encodeWithProgress(input, output, args, { signal, onProgress }) {
  let duration = null;
  return spawnLines(
    ffmpegPath,
    ['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', input, '-vn', ...args, output],
    {
      signal,
      onStderrLine: (line) => {
        const m = duration === null && line.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
        if (m) duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      },
      onStdoutLine: (line) => {
        const m = line.match(/^out_time_us=(\d+)/);
        if (m && duration) onProgress(Number(m[1]) / 1e6 / duration);
      },
    }
  );
}

function formatFromBody(body) {
  return resolveFormat(body?.format, body?.quality, body?.sampleRate);
}

// File → audio. Uploading is shown by the page itself; this reports the encode.
app.post('/api/jobs/convert-file', upload.single('file'), (req, res) => {
  const uploaded = req.file;
  if (!uploaded) return res.status(400).json({ error: 'No file received.' });

  const originalName = uploaded.originalname || 'audio';
  if (!MEDIA_EXT_RE.test(originalName)) {
    fs.unlink(uploaded.path, () => {});
    return res.status(400).json({ error: `"${originalName}" doesn't look like an audio or video file.` });
  }

  const output = formatFromBody(req.body);
  const job = createJob();
  job.title = originalName.replace(MEDIA_EXT_RE, '');
  job.ext = output.format;
  job.outPath = path.join(os.tmpdir(), `${jobPrefix(job)}-out.${output.format}`);
  res.json({ jobId: job.id });

  setProgress(job, 'Converting', 0);
  const { signal } = job.controller;
  encodeArgs(output, uploaded.path, { signal })
    .then((args) =>
      encodeWithProgress(uploaded.path, job.outPath, args, {
        signal,
        onProgress: (p) => setProgress(job, 'Converting', p),
      })
    )
    .then(() => {
      setProgress(job, 'Done', 1);
      job.state = 'done';
    })
    .catch((err) => {
      if (err.name === 'AbortError' || !jobs.has(job.id)) return;
      console.error(err);
      job.state = 'error';
      job.error = /does not contain any stream|Output file is empty|matches no streams/i.test(err.stderr || '')
        ? `"${originalName}" has no audio track to extract.`
        : `Couldn't convert "${originalName}". It may not be a valid audio or video file.`;
    })
    .finally(() => fs.unlink(uploaded.path, () => {}));
});

app.get('/api/output-formats', (req, res) => {
  res.json(Object.fromEntries(Object.entries(OUTPUT_FORMATS).map(([k, v]) => [k, { qualities: v.qualities, sampleRates: v.sampleRates }])));
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'That conversion has expired. Please run it again.' });
  job.touched = Date.now();
  res.json({ state: job.state, stage: job.stage, progress: job.progress, title: job.title, error: job.error });
});

app.get('/api/jobs/:id/file', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.state !== 'done') return res.status(404).json({ error: 'That conversion has expired. Please run it again.' });
  jobs.delete(job.id);
  sendAudioFile(res, job.outPath, job.title, [job.outPath], job.ext);
});

app.delete('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (job) disposeJob(job);
  res.json({ ok: true });
});

// Separation produces two files from one expensive run, so results are held in a temp
// job directory and fetched individually rather than re-running the model per stem.
const SEPARATION_TTL_MS = 60 * 60 * 1000;
const STEMS = ['vocals', 'instrumental'];

// RoFormer checkpoints are ~0.5-1GB each, so they are downloaded on first use rather than
// bundled, and they live outside the .app so they survive reinstalls.
const ROFORMER_MODEL_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'PocketEdits', 'models');

// If AudioSmith (the sibling app) already downloaded these models, reuse them instead of
// fetching ~1GB again. On APFS the copy is a clone, so it takes no extra disk space.
const AUDIOSMITH_MODEL_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'AudioSmith', 'models');
function adoptExistingModels() {
  try {
    if (!fs.existsSync(AUDIOSMITH_MODEL_DIR)) return;
    fs.mkdirSync(ROFORMER_MODEL_DIR, { recursive: true });
    for (const name of fs.readdirSync(AUDIOSMITH_MODEL_DIR)) {
      const target = path.join(ROFORMER_MODEL_DIR, name);
      if (!fs.existsSync(target)) fs.copyFileSync(path.join(AUDIOSMITH_MODEL_DIR, name), target, fs.constants.COPYFILE_FICLONE);
    }
  } catch (err) {
    console.error('Could not reuse existing models:', err.message);
  }
}
adoptExistingModels();
const ROFORMER_SCRIPT = unpackedPath(path.join(__dirname, 'vendor', 'separate_roformer.py'));

// A curated slice of what audio-separator supports — the full list is ~90 RoFormer models,
// which is not a useful menu. Labels describe the result rather than the model, and
// stemNames are what each output file is called, since the karaoke model's "vocals" is
// only the lead and its instrumental keeps the backing vocals.
const SEPARATION_MODELS = [
  {
    // Mel-Band RoFormer by Kim (vocal SDR 12.6)
    id: 'mel-roformer-kim',
    label: 'Remove all vocals',
    note: 'Two files: vocals · instrumental (no vocals)',
    filename: 'vocals_mel_band_roformer.ckpt',
    stemNames: { vocals: 'vocals', instrumental: 'instrumental' },
  },
  {
    // Mel-Band RoFormer karaoke by aufr33 & viperx
    id: 'mel-roformer-karaoke',
    label: 'Remove lead vocal only',
    note: 'Two files: lead vocal · instrumental with backing vocals & harmonies',
    filename: 'mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt',
    stemNames: { vocals: 'lead vocal', instrumental: 'instrumental + harmonies' },
  },
];

function findModel(id) {
  return SEPARATION_MODELS.find((m) => m.id === id);
}

function isModelDownloaded(model) {
  return fs.existsSync(path.join(ROFORMER_MODEL_DIR, model.filename));
}

function runRoformer(inputPath, outputDir, model, { signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_PATH,
      [ROFORMER_SCRIPT, inputPath, outputDir, model.filename, ROFORMER_MODEL_DIR],
      {
        maxBuffer: 1024 * 1024 * 50,
        signal,
        env: {
          ...process.env,
          // audio-separator shells out to ffmpeg by name, so the bundled one must be findable.
          PATH: `${path.dirname(ffmpegPath)}:${process.env.PATH || ''}`,
          PYTHONUNBUFFERED: '1',
        },
      },
      (error, stdout, stderr) => {
        if (error) return reject(Object.assign(error, { stderr, stdout }));
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          reject(Object.assign(new Error('Could not read separation output.'), { stderr, stdout }));
        }
      }
    );
  });
}

app.get('/api/models', (req, res) => {
  res.json(
    SEPARATION_MODELS.map(({ id, label, note }) => ({
      id,
      label,
      note,
      downloaded: isModelDownloaded(findModel(id)),
    }))
  );
});

function separationJobDir(jobId) {
  return path.join(os.tmpdir(), `mp3grabber-sep-${jobId}`);
}

function sweepStaleSeparations() {
  const cutoff = Date.now() - SEPARATION_TTL_MS;
  let entries = [];
  try {
    entries = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith('mp3grabber-sep-')) continue;
    const dir = path.join(os.tmpdir(), entry);
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // another run may have cleaned it up already
    }
  }
}

app.post('/api/separate', upload.single('file'), async (req, res) => {
  const uploaded = req.file;

  if (!uploaded) {
    return res.status(400).json({ error: 'No file received.' });
  }

  const originalName = uploaded.originalname || 'audio';
  if (!MEDIA_EXT_RE.test(originalName)) {
    fs.unlink(uploaded.path, () => {});
    return res.status(400).json({ error: 'That doesn\'t look like an audio or video file.' });
  }

  const model = findModel(req.body?.model || SEPARATION_MODELS[0].id);
  if (!model) {
    fs.unlink(uploaded.path, () => {});
    return res.status(400).json({ error: 'Unknown separation model.' });
  }

  sweepStaleSeparations();

  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const { signal } = controller;

  const jobId = crypto.randomBytes(8).toString('hex');
  const jobDir = separationJobDir(jobId);
  const wavPath = path.join(jobDir, 'input.wav');
  const title = originalName.replace(MEDIA_EXT_RE, '');

  try {
    fs.mkdirSync(jobDir, { recursive: true });
    // Decode up front so the models only ever see plain WAV, which they read without
    // needing an ffmpeg of their own.
    await runFfmpeg(['-y', '-i', uploaded.path, '-vn', '-ac', '2', '-ar', '44100', wavPath], { signal });
    fs.unlink(uploaded.path, () => {});

    const sources = await runRoformer(wavPath, path.join(jobDir, 'roformer'), model, { signal });

    for (const stem of STEMS) {
      const source = sources[stem];
      if (!source || !fs.existsSync(source)) {
        throw new Error(`Separation did not produce a ${stem} track.`);
      }
      await runFfmpeg(
        ['-y', '-i', source, '-codec:a', 'libmp3lame', '-b:a', '320k', path.join(jobDir, `${stem}.mp3`)],
        { signal }
      );
    }

    fs.rmSync(path.join(jobDir, 'roformer'), { recursive: true, force: true });
    fs.unlink(wavPath, () => {});
    fs.writeFileSync(path.join(jobDir, 'meta.json'), JSON.stringify({ title, stemNames: model.stemNames }));

    if (!res.writableEnded && !res.destroyed) res.json({ jobId, title, stems: STEMS, stemNames: model.stemNames });
  } catch (err) {
    fs.unlink(uploaded.path, () => {});
    fs.rmSync(jobDir, { recursive: true, force: true });
    if (err.name === 'AbortError') return;
    console.error(err);
    const details = `${err.stderr || ''}${err.message || ''}`;
    let error = 'Separation failed. The file may not be a valid audio or video file.';
    if (/does not contain any stream|Output file is empty/i.test(details)) {
      error = 'That file has no audio track to separate.';
    } else if (/ConnectionError|Max retries|Temporary failure|getaddrinfo|Network|SSLError/i.test(details)) {
      error = 'Could not download the separation model. Check your connection and try again.';
    }
    safeRespond(res, 500, { error });
  }
});

app.get('/api/separate/:jobId/:stem', (req, res) => {
  const { jobId, stem } = req.params;

  // jobId and stem land in a filesystem path, so both are validated against strict
  // allowlists rather than trusted.
  if (!/^[a-f0-9]{16}$/.test(jobId) || !STEMS.includes(stem)) {
    return res.status(400).json({ error: 'Bad request.' });
  }

  const jobDir = separationJobDir(jobId);
  const filePath = path.join(jobDir, `${stem}.mp3`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Those results have expired. Run the separation again.' });
  }

  let title = 'audio';
  let stemName = stem;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(jobDir, 'meta.json'), 'utf8'));
    title = meta.title || title;
    stemName = meta.stemNames?.[stem] || stemName;
  } catch {
    // fall back to the generic names
  }

  // Both stems come from one job dir, so the files stay until the TTL sweep clears them.
  sendAudioFile(res, filePath, `${title} (${stemName})`, []);
});

const ANALYZE_SCRIPT = unpackedPath(path.join(__dirname, 'vendor', 'analyze.py'));

function runAnalysis(inputPath, { signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_PATH,
      [ANALYZE_SCRIPT, inputPath],
      { maxBuffer: 1024 * 1024 * 5, signal, env: { ...process.env, PYTHONUNBUFFERED: '1' } },
      (error, stdout, stderr) => {
        if (error) return reject(Object.assign(error, { stderr, stdout }));
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          reject(Object.assign(new Error('Could not read analysis output.'), { stderr, stdout }));
        }
      }
    );
  });
}

// Decodes any audio/video to mono at librosa's working rate (analysis needs nothing more,
// and it keeps the temp file small), then runs vendor/analyze.py on it.
async function analyzeMedia(inputPath, { signal } = {}) {
  const wavPath = tempPath('analyze', 'wav');
  try {
    await runFfmpeg(['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '22050', wavPath], { signal });
    return await runAnalysis(wavPath, { signal });
  } finally {
    fs.unlink(wavPath, () => {});
  }
}

app.post('/api/analyze', upload.single('file'), async (req, res) => {
  const uploaded = req.file;

  if (!uploaded) {
    return res.status(400).json({ error: 'No file received.' });
  }

  const originalName = uploaded.originalname || 'audio';
  if (!MEDIA_EXT_RE.test(originalName)) {
    fs.unlink(uploaded.path, () => {});
    return res.status(400).json({ error: 'That doesn\'t look like an audio or video file.' });
  }

  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const { signal } = controller;

  try {
    const { bpm, key, camelot } = await analyzeMedia(uploaded.path, { signal });
    safeRespond(res, 200, { title: originalName.replace(MEDIA_EXT_RE, ''), bpm, key, camelot });
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    const noAudioTrack = /does not contain any stream|Output file is empty/i.test(err.stderr || '');
    safeRespond(res, 500, {
      error: noAudioTrack
        ? 'That file has no audio track to analyze.'
        : 'Analysis failed. The file may not be a valid audio or video file.',
    });
  } finally {
    fs.unlink(uploaded.path, () => {});
  }
});

// --- Editing tools (trim, fade, silence, channels, tempo, join) ---
// Most editing runs in the browser on raw samples. The server only does what the browser
// can't do well: decode any format (including video), stretch tempo, and encode MP3.

function tempPath(prefix, ext) {
  return path.join(os.tmpdir(), `${prefix}-${crypto.randomBytes(8).toString('hex')}.${ext}`);
}

// Any audio or video in, 32-bit float WAV out at the source's own sample rate. Surround
// sources are folded down to stereo, since every tool works on one or two channels.
app.post('/api/decode', upload.single('file'), async (req, res) => {
  const uploaded = req.file;
  if (!uploaded) return res.status(400).json({ error: 'No file received.' });

  const originalName = uploaded.originalname || 'audio';
  if (!MEDIA_EXT_RE.test(originalName)) {
    fs.unlink(uploaded.path, () => {});
    return res.status(400).json({ error: `"${originalName}" doesn't look like an audio or video file.` });
  }

  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const wavPath = tempPath('decode', 'wav');

  try {
    await runFfmpeg(
      ['-y', '-i', uploaded.path, '-vn', '-af', 'aformat=channel_layouts=mono|stereo', '-c:a', 'pcm_f32le', wavPath],
      { signal: controller.signal }
    );
    fs.unlink(uploaded.path, () => {});
    if (res.writableEnded || res.destroyed) return fs.unlink(wavPath, () => {});
    res.setHeader('Content-Type', 'audio/wav');
    const stream = fs.createReadStream(wavPath);
    stream.pipe(res);
    stream.on('close', () => fs.unlink(wavPath, () => {}));
  } catch (err) {
    fs.unlink(uploaded.path, () => {});
    fs.unlink(wavPath, () => {});
    if (err.name === 'AbortError') return;
    console.error(err);
    const noAudioTrack = /does not contain any stream|Output file is empty/i.test(err.stderr || '');
    safeRespond(res, 500, {
      error: noAudioTrack ? `"${originalName}" has no audio track.` : `Could not open "${originalName}".`,
    });
  }
});

const STRETCH_SCRIPT = unpackedPath(path.join(__dirname, 'vendor', 'stretch.py'));

// WAV in (from the editor), tempo-changed WAV out.
app.post('/api/stretch', upload.single('file'), async (req, res) => {
  const uploaded = req.file;
  if (!uploaded) return res.status(400).json({ error: 'No audio received.' });

  const factor = Number(req.body?.factor);
  if (!Number.isFinite(factor) || factor < 0.25 || factor > 4) {
    fs.unlink(uploaded.path, () => {});
    return res.status(400).json({ error: 'Tempo change must be between 25% and 400% of the original.' });
  }
  const preserve = req.body?.preservePitch === '0' ? '0' : '1';

  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const outPath = tempPath('stretch', 'wav');

  try {
    await new Promise((resolve, reject) => {
      execFile(
        PYTHON_PATH,
        [STRETCH_SCRIPT, uploaded.path, outPath, String(factor), preserve],
        { maxBuffer: 1024 * 1024 * 5, signal: controller.signal },
        (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr, stdout })) : resolve())
      );
    });
    if (res.writableEnded || res.destroyed) return fs.unlink(outPath, () => {});
    res.setHeader('Content-Type', 'audio/wav');
    const stream = fs.createReadStream(outPath);
    stream.pipe(res);
    stream.on('close', () => fs.unlink(outPath, () => {}));
  } catch (err) {
    fs.unlink(outPath, () => {});
    if (err.name === 'AbortError') return;
    console.error(err);
    safeRespond(res, 500, { error: 'Tempo change failed.' });
  } finally {
    fs.unlink(uploaded.path, () => {});
  }
});

// WAV in (from the editor or joiner), saved in the chosen format and quality.
app.post('/api/encode', upload.single('file'), async (req, res) => {
  const uploaded = req.file;
  if (!uploaded) return res.status(400).json({ error: 'No audio received.' });

  const output = formatFromBody(req.body);
  const title = String(req.body?.title || 'audio').slice(0, 150);
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const outPath = tempPath('encode', output.format);

  try {
    const args = await encodeArgs(output, uploaded.path, { signal: controller.signal });
    await runFfmpeg(['-y', '-i', uploaded.path, '-vn', ...args, outPath], { signal: controller.signal });
    fs.unlink(uploaded.path, () => {});
    sendAudioFile(res, outPath, title, [outPath], output.format);
  } catch (err) {
    fs.unlink(uploaded.path, () => {});
    fs.unlink(outPath, () => {});
    if (err.name === 'AbortError') return;
    console.error(err);
    safeRespond(res, 500, { error: 'Saving failed.' });
  }
});

function start(port = DEFAULT_PORT) {
  return new Promise((resolve, reject) => {
    const server = app
      .listen(port, () => {
        console.log(`PocketEdits running at http://localhost:${port}`);
        resolve(server);
      })
      .on('error', reject);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
