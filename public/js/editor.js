// Edit tab: one track loaded into memory, shown as a waveform, changed by the tools below
// it, then saved. Every change is undoable.
(() => {
  const T = AudioTools;
  const $ = (id) => document.getElementById(id);

  const workspace = $('edit-workspace');
  const dropzone = $('edit-dropzone');
  const canvas = $('edit-wave');
  const statusEl = $('edit-status');
  const picker = FormatPicker.create($('edit-format'), { id: 'edit' });
  const results = Results.create($('edit-results'));
  const MAX_UNDO = 5; // each step is a full copy of the audio, so keep this modest

  let audio = null;
  let title = '';
  let history = [];
  let selection = null; // { start, end } in seconds
  let playhead = 0;
  let mainPlaying = false; // whether the shared player is playing the track itself (vs a preview)
  let activeTool = 'trim';
  let busy = false;

  const fmt3 = (s) => T.formatTime(s, 3);

  function status(message, kind = 'info') {
    if (!message) {
      statusEl.classList.add('hidden');
      return;
    }
    setStatus(statusEl, message, kind);
    statusEl.classList.remove('mt-4');
  }

  // ---------- Loading ----------

  function load(newAudio, name) {
    audio = newAudio.channels.length > 2 ? { sampleRate: newAudio.sampleRate, channels: newAudio.channels.slice(0, 2) } : newAudio;
    title = name;
    history = [];
    selection = null;
    playhead = 0;
    dropzone.classList.add('hidden');
    workspace.classList.remove('hidden');
    $('edit-name').textContent = name;
    $('edit-load-status').classList.add('hidden');
    status(null);
    refresh();
  }

  function commit(newAudio, message) {
    history.push(audio);
    if (history.length > MAX_UNDO) history.shift();
    audio = newAudio;
    selection = null;
    playhead = 0;
    status(message, 'success');
    refresh();
  }

  wireDropzone({
    zoneId: 'edit-dropzone',
    labelId: 'edit-label',
    spinnerId: 'edit-spinner',
    inputId: 'edit-input',
    idleLabel: 'Drop a track to edit',
    busyLabel: 'Opening…',
    onFile: async (file) => {
      const controller = new AbortController();
      const untrack = trackController(controller);
      const wasOpen = Boolean(audio);
      if (wasOpen) status(`Opening "${file.name}"…`);
      try {
        T.player.stop();
        load(await T.decodeFile(file, { signal: controller.signal }), file.name.replace(/\.[^.]+$/, ''));
      } catch (err) {
        const message = err.name === 'AbortError' ? 'Stopped.' : err.message;
        if (wasOpen) status(message, 'error');
        else setStatus($('edit-load-status'), message, 'error');
      } finally {
        untrack();
      }
    },
  });
  $('edit-open').addEventListener('click', () => $('edit-input').click());

  // ---------- Waveform ----------

  let peaks = null; // { audio, width, min: Float32Array, max: Float32Array }

  function computePeaks(width) {
    if (peaks && peaks.audio === audio && peaks.width === width) return peaks;
    const frames = audio.channels[0].length;
    const min = new Float32Array(width);
    const max = new Float32Array(width);
    const per = frames / width;
    const chs = audio.channels;
    for (let x = 0; x < width; x++) {
      const a = Math.floor(x * per);
      const b = Math.max(a + 1, Math.floor((x + 1) * per));
      let lo = 0;
      let hi = 0;
      for (let c = 0; c < chs.length; c++) {
        const ch = chs[c];
        for (let i = a; i < b && i < frames; i++) {
          const v = ch[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      min[x] = lo;
      max[x] = hi;
    }
    peaks = { audio, width, min, max };
    return peaks;
  }

  function draw() {
    if (!audio || workspace.classList.contains('hidden')) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (!cssW) return;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const dur = T.duration(audio);
    const xOf = (t) => (t / dur) * cssW;
    const mid = cssH / 2;
    const { min, max } = computePeaks(Math.floor(cssW));

    // Regions that the silence tool would cut.
    const silence = activeTool === 'silence' ? currentSilence() : null;
    if (silence && !silence.allSilent) {
      ctx.fillStyle = 'rgba(163, 38, 27, 0.22)';
      if (silence.startSec > 0) ctx.fillRect(0, 0, xOf(silence.startSec), cssH);
      if (silence.endSec > 0) ctx.fillRect(xOf(dur - silence.endSec), 0, cssW, cssH);
    }

    if (selection) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
      ctx.fillRect(xOf(selection.start), 0, xOf(selection.end) - xOf(selection.start), cssH);
    }

    ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
    ctx.fillRect(0, mid - 0.5, cssW, 1);

    const selA = selection ? xOf(selection.start) : -1;
    const selB = selection ? xOf(selection.end) : -1;
    // Rounded bars mirrored around the centre, like the waveform on the PocketEdits site:
    // black normally, white inside the selection, faded outside it, red where silence is cut.
    const scale = mid * 0.9;
    const STEP = 3;
    const BAR = 2;
    for (let x = 0; x < min.length; x += STEP) {
      let peak = 0;
      for (let k = x; k < Math.min(min.length, x + STEP); k++) peak = Math.max(peak, max[k], -min[k]);
      const centre = x + BAR / 2;
      const inSel = centre >= selA && centre <= selB;
      const cut = silence && !silence.allSilent && (centre < xOf(silence.startSec) || centre > xOf(dur - silence.endSec));
      ctx.fillStyle = cut ? 'rgba(163, 38, 27, 0.75)' : inSel ? '#ffffff' : selection ? 'rgba(0, 0, 0, 0.4)' : '#000000';
      const h = Math.max(BAR, peak * scale * 2);
      ctx.beginPath();
      ctx.roundRect(x, mid - h / 2, BAR, h, BAR / 2);
      ctx.fill();
    }

    // Fade envelope while the fade tool is open.
    if (activeTool === 'fade') {
      const { inSec, outSec, curve } = fadeSettings();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const steps = 40;
      const yOf = (g) => cssH - 4 - g * (cssH - 8);
      if (inSec > 0) {
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const x = xOf(Math.min(inSec, dur) * t);
          i ? ctx.lineTo(x, yOf(T.fadeGain(t, curve))) : ctx.moveTo(x, yOf(0));
        }
      } else ctx.moveTo(0, yOf(1));
      if (outSec > 0) {
        ctx.lineTo(xOf(dur - Math.min(outSec, dur)), yOf(1));
        for (let i = steps; i >= 0; i--) ctx.lineTo(xOf(dur - Math.min(outSec, dur) * (i / steps)), yOf(T.fadeGain(i / steps, curve)));
      } else ctx.lineTo(cssW, yOf(1));
      ctx.stroke();
    }

    ctx.fillStyle = '#000000';
    ctx.fillRect(Math.min(cssW - 2, xOf(playhead)), 0, 2, cssH);
  }

  window.addEventListener('resize', draw);
  Tabs.onChange((tab) => {
    if (tab !== 'edit' && mainPlaying) T.player.stop();
    requestAnimationFrame(draw);
  });

  // Drag to select, click to place the playhead.
  let dragFrom = null;
  let dragging = false;
  const timeAt = (e) => {
    const r = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * T.duration(audio);
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!audio) return;
    canvas.setPointerCapture(e.pointerId);
    dragFrom = { x: e.clientX, t: timeAt(e) };
    dragging = false;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragFrom) return;
    if (!dragging && Math.abs(e.clientX - dragFrom.x) < 4) return;
    dragging = true;
    const t = timeAt(e);
    selection = { start: Math.min(dragFrom.t, t), end: Math.max(dragFrom.t, t) };
    playhead = selection.start;
    refresh();
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!dragFrom) return;
    if (!dragging) {
      const wasPlaying = mainPlaying;
      selection = null;
      playhead = timeAt(e);
      if (wasPlaying) playMain();
    }
    dragFrom = null;
    refresh();
  });

  // ---------- Transport ----------

  function setPlayingUi(on) {
    $('edit-play').querySelector('.icon-play').classList.toggle('hidden', on);
    $('edit-play').querySelector('.icon-pause').classList.toggle('hidden', !on);
    $('edit-play').setAttribute('aria-label', on ? 'Pause' : 'Play');
  }

  function playMain() {
    const from = selection ? selection.start : playhead >= T.duration(audio) - 0.05 ? 0 : playhead;
    const to = selection ? selection.end : T.duration(audio);
    const returnTo = from;
    T.player.play(audio, from, to, () => {
      mainPlaying = false;
      setPlayingUi(false);
      playhead = returnTo;
      refresh();
    });
    mainPlaying = true;
    setPlayingUi(true);
    const tick = () => {
      if (!mainPlaying) return;
      playhead = Math.min(to, T.player.position);
      updateTime();
      draw();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function togglePlay() {
    if (!audio) return;
    if (T.player.playing) {
      const wasMain = mainPlaying;
      const pos = T.player.position;
      T.player.stop();
      if (wasMain && !selection) playhead = Math.min(pos, T.duration(audio));
      refresh();
      if (wasMain) return;
    }
    playMain();
  }

  function preview(clip, message) {
    T.player.play(clip, 0, T.duration(clip), () => status(null));
    mainPlaying = false;
    setPlayingUi(false);
    if (message) status(message);
  }

  $('edit-play').addEventListener('click', togglePlay);
  // Space plays/pauses even when a button has focus, so it must not also click that button
  // (which fires on keyup).
  const spaceIsOurs = (e) => e.code === 'Space' && Tabs.current === 'edit' && audio && !isTypingTarget(e.target);
  document.addEventListener('keydown', (e) => {
    if (!spaceIsOurs(e)) return;
    e.preventDefault();
    if (!e.repeat) togglePlay();
  });
  document.addEventListener('keyup', (e) => spaceIsOurs(e) && e.preventDefault());

  $('edit-undo').addEventListener('click', () => {
    if (!history.length) return;
    T.player.stop();
    audio = history.pop();
    selection = null;
    playhead = 0;
    status('Undone.');
    refresh();
  });

  function updateTime() {
    $('edit-time').textContent = `${T.formatTime(playhead)} / ${T.formatTime(T.duration(audio))}`;
  }

  function refresh() {
    if (!audio) return;
    const dur = T.duration(audio);
    const chs = audio.channels.length === 1 ? 'mono' : 'stereo';
    $('edit-info').textContent = `${T.formatTime(dur)} · ${chs} · ${(audio.sampleRate / 1000).toFixed(1)} kHz`;
    $('edit-selection').textContent = selection
      ? `Selected ${fmt3(selection.start)} – ${fmt3(selection.end)} (${(selection.end - selection.start).toFixed(2)} s)`
      : 'Drag across the waveform to select · click to move the playhead · space to play';
    $('edit-undo').disabled = !history.length || busy;
    if (document.activeElement !== $('trim-start')) $('trim-start').value = fmt3(selection ? selection.start : 0);
    if (document.activeElement !== $('trim-end')) $('trim-end').value = fmt3(selection ? selection.end : dur);
    refreshChannels();
    refreshSilence();
    refreshTempo();
    updateTime();
    draw();
  }

  // ---------- Tool switching ----------

  document.querySelectorAll('[data-tool-btn]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTool = btn.dataset.toolBtn;
      document.querySelectorAll('[data-tool-btn]').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
      document.querySelectorAll('[data-tool]').forEach((p) => p.classList.toggle('hidden', p.dataset.tool !== activeTool));
      status(null);
      refresh();
    });
  });

  function segValue(attr) {
    return document.querySelector(`[${attr}][aria-checked="true"]`).getAttribute(attr);
  }
  function wireSeg(attr, onChange) {
    document.querySelectorAll(`[${attr}]`).forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll(`[${attr}]`).forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
        onChange(btn.getAttribute(attr));
      });
    });
  }

  // Wraps a tool action: blocks double clicks, routes errors to the status line, and
  // lets the floating Stop button cancel server work.
  async function run(action) {
    if (!audio || busy) return;
    busy = true;
    document.querySelectorAll('#edit-workspace button').forEach((b) => (b.disabled = true));
    const controller = new AbortController();
    const untrack = trackController(controller);
    try {
      await action(controller.signal);
    } catch (err) {
      status(err.name === 'AbortError' ? 'Stopped.' : err.message || 'Something went wrong.', 'error');
    } finally {
      untrack();
      busy = false;
      document.querySelectorAll('#edit-workspace button').forEach((b) => (b.disabled = false));
      refresh();
    }
  }

  // ---------- Trim ----------

  function readTrimFields() {
    const dur = T.duration(audio);
    const start = T.parseTime($('trim-start').value);
    const end = T.parseTime($('trim-end').value);
    if (start === null || end === null) throw new Error('Times should look like 1:15.250 or 75.25.');
    const s = Math.max(0, Math.min(dur, start));
    const e = Math.max(0, Math.min(dur, end));
    if (e - s < 0.01) throw new Error('End must be after start.');
    return { start: s, end: e };
  }

  ['trim-start', 'trim-end'].forEach((id) => {
    $(id).addEventListener('change', () => {
      try {
        const r = readTrimFields();
        selection = r.start <= 0 && r.end >= T.duration(audio) ? null : r;
        playhead = r.start;
        status(null);
      } catch (err) {
        status(err.message, 'error');
      }
      refresh();
    });
    $(id).addEventListener('keydown', (e) => e.key === 'Enter' && $(id).blur());
  });

  $('trim-play').addEventListener('click', () => {
    try {
      const r = readTrimFields();
      selection = r.start <= 0 && r.end >= T.duration(audio) ? null : r;
      if (T.player.playing) T.player.stop();
      playMain();
    } catch (err) {
      status(err.message, 'error');
    }
  });

  $('trim-apply').addEventListener('click', () =>
    run(async () => {
      const r = readTrimFields();
      if (r.start <= 0 && r.end >= T.duration(audio)) throw new Error('Select the part you want to keep first.');
      T.player.stop();
      commit(T.slice(audio, r.start, r.end), `Trimmed to ${T.formatTime(r.end - r.start)}.`);
    })
  );

  // ---------- Fade ----------

  function fadeSettings() {
    return {
      inSec: Math.max(0, Number($('fade-in').value) || 0),
      outSec: Math.max(0, Number($('fade-out').value) || 0),
      curve: segValue('data-fade-curve'),
    };
  }
  ['fade-in', 'fade-out'].forEach((id) => $(id).addEventListener('input', draw));
  wireSeg('data-fade-curve', draw);

  $('fade-preview-in').addEventListener('click', () => {
    const { inSec, curve } = fadeSettings();
    if (!inSec) return status('Set a fade-in length first.', 'error');
    const clip = T.slice(audio, 0, Math.min(T.duration(audio), inSec + 3));
    preview(T.fade(clip, inSec, 0, curve), 'Playing the start with the fade-in…');
  });
  $('fade-preview-out').addEventListener('click', () => {
    const { outSec, curve } = fadeSettings();
    if (!outSec) return status('Set a fade-out length first.', 'error');
    const dur = T.duration(audio);
    const clip = T.slice(audio, Math.max(0, dur - outSec - 3), dur);
    preview(T.fade(clip, 0, outSec, curve), 'Playing the end with the fade-out…');
  });
  $('fade-apply').addEventListener('click', () =>
    run(async () => {
      const { inSec, outSec, curve } = fadeSettings();
      if (!inSec && !outSec) throw new Error('Set a fade-in or fade-out length first.');
      if (inSec + outSec > T.duration(audio)) throw new Error('The fades are longer than the track.');
      T.player.stop();
      commit(T.fade(audio, inSec, outSec, curve), 'Fades applied.');
    })
  );

  // ---------- Silence ----------

  function silenceSettings() {
    return {
      thresholdDb: Number($('silence-threshold').value),
      minSilenceSec: Math.max(0, Number($('silence-min').value) || 0) / 1000,
      paddingSec: Math.max(0, Number($('silence-padding').value) || 0) / 1000,
      start: $('silence-start').checked,
      end: $('silence-end').checked,
    };
  }

  let silenceCache = null;
  function currentSilence() {
    const settings = silenceSettings();
    const key = JSON.stringify(settings);
    if (!silenceCache || silenceCache.audio !== audio || silenceCache.key !== key) {
      silenceCache = { audio, key, result: T.findSilence(audio, settings) };
    }
    return silenceCache.result;
  }

  function refreshSilence() {
    $('silence-threshold-value').textContent = `${$('silence-threshold').value} dB`;
    if (activeTool !== 'silence') return;
    const s = currentSilence();
    let text;
    if (s.allSilent) text = 'The whole track is below the threshold — lower it to keep the quiet parts.';
    else if (!s.startSec && !s.endSec) text = 'No silence to trim with these settings.';
    else {
      const parts = [];
      if (s.startSec) parts.push(`${s.startSec.toFixed(2)} s from the beginning`);
      if (s.endSec) parts.push(`${s.endSec.toFixed(2)} s from the end`);
      text = `Removes ${parts.join(' and ')} (shown in red).`;
    }
    $('silence-summary').textContent = text;
  }

  ['silence-threshold', 'silence-min', 'silence-padding', 'silence-start', 'silence-end'].forEach((id) =>
    $(id).addEventListener('input', () => {
      refreshSilence();
      draw();
    })
  );

  $('silence-preview').addEventListener('click', () => {
    const s = currentSilence();
    if (s.allSilent || (!s.startSec && !s.endSec)) return status('Nothing to remove with these settings.', 'error');
    const trimmed = T.trimSilence(audio, s);
    const dur = T.duration(trimmed);
    // Play just the new beginning and end, back to back, since that's all that changes.
    const clip =
      dur <= 10
        ? trimmed
        : T.join([T.slice(trimmed, 0, 4), T.slice(trimmed, dur - 4, dur)], { mode: 'gap', seconds: 0.6 });
    preview(clip, dur <= 10 ? 'Playing the trimmed track…' : 'Playing the new beginning, then the new end…');
  });

  $('silence-apply').addEventListener('click', () =>
    run(async () => {
      const s = currentSilence();
      if (s.allSilent) throw new Error('The whole track is below the threshold.');
      if (!s.startSec && !s.endSec) throw new Error('Nothing to remove with these settings.');
      T.player.stop();
      commit(T.trimSilence(audio, s), `Removed ${(s.startSec + s.endSec).toFixed(2)} s of silence.`);
    })
  );

  // ---------- Channels ----------

  const STEREO_OPS = ['mono', 'left', 'right', 'swap'];

  function refreshChannels() {
    const stereo = audio.channels.length === 2;
    $('channels-source').textContent = stereo ? 'This track is stereo (left and right).' : 'This track is mono (one channel).';
    const radios = [...document.querySelectorAll('input[name="channel-op"]')];
    radios.forEach((r) => (r.disabled = stereo ? !STEREO_OPS.includes(r.value) : r.value !== 'dual'));
    const checked = radios.find((r) => r.checked && !r.disabled);
    if (!checked) radios.find((r) => !r.disabled).checked = true;
  }

  const channelOp = () => document.querySelector('input[name="channel-op"]:checked').value;
  const CHANNEL_DONE = {
    mono: 'Mixed down to mono.',
    left: 'Kept the left channel (now mono).',
    right: 'Kept the right channel (now mono).',
    swap: 'Swapped left and right.',
    dual: 'Converted to dual mono (stereo).',
  };

  $('channels-preview').addEventListener('click', () => {
    const from = selection ? selection.start : playhead;
    const clip = T.slice(audio, from, Math.min(T.duration(audio), from + 8));
    preview(T.CHANNEL_OPS[channelOp()](clip), 'Playing 8 seconds from the playhead…');
  });
  $('channels-apply').addEventListener('click', () =>
    run(async () => {
      T.player.stop();
      commit(T.CHANNEL_OPS[channelOp()](audio), CHANNEL_DONE[channelOp()]);
    })
  );

  // ---------- Tempo ----------

  function tempoFactor() {
    if (segValue('data-tempo-mode') === 'percent') {
      const pct = Number($('tempo-percent').value);
      return pct > 0 ? pct / 100 : null;
    }
    const from = Number($('tempo-from').value);
    const to = Number($('tempo-to').value);
    return from > 0 && to > 0 ? to / from : null;
  }

  function refreshTempo() {
    const f = tempoFactor();
    const el = $('tempo-summary');
    if (!f) {
      el.textContent = segValue('data-tempo-mode') === 'bpm' ? 'Enter the original and target BPM (or press Detect).' : '';
      return;
    }
    if (f < 0.25 || f > 4) {
      el.textContent = 'Keep the change between 25% and 400%.';
      return;
    }
    const dur = T.duration(audio);
    let text = `${Math.round(f * 1000) / 10}% speed · new length ${T.formatTime(dur / f)} (was ${T.formatTime(dur)})`;
    if (!$('tempo-keep-pitch').checked && Math.abs(f - 1) > 1e-6) {
      const semis = 12 * Math.log2(f);
      text += ` · pitch ${semis > 0 ? 'up' : 'down'} ${Math.abs(semis).toFixed(1)} semitones`;
    }
    el.textContent = text;
  }

  wireSeg('data-tempo-mode', (mode) => {
    document.querySelectorAll('[data-tempo-fields]').forEach((el) => el.classList.toggle('hidden', el.dataset.tempoFields !== mode));
    refreshTempo();
  });
  ['tempo-percent', 'tempo-from', 'tempo-to', 'tempo-keep-pitch'].forEach((id) => $(id).addEventListener('input', refreshTempo));

  function checkedFactor() {
    const f = tempoFactor();
    if (!f) throw new Error(segValue('data-tempo-mode') === 'bpm' ? 'Enter both BPM values first.' : 'Enter a speed first.');
    if (f < 0.25 || f > 4) throw new Error('Keep the change between 25% and 400%.');
    if (Math.abs(f - 1) < 1e-6) throw new Error('That is the same tempo as now.');
    return f;
  }

  $('tempo-detect').addEventListener('click', () =>
    run(async (signal) => {
      status('Detecting BPM…');
      const bpm = await T.analyzeBpm(audio, { signal });
      $('tempo-from').value = Math.round(bpm * 10) / 10;
      if (!$('tempo-to').value) $('tempo-to').value = Math.round(bpm);
      status(`Detected about ${Math.round(bpm)} BPM. If it's double or half what you hear, halve or double it.`, 'success');
    })
  );

  $('tempo-preview').addEventListener('click', () =>
    run(async (signal) => {
      const f = checkedFactor();
      const from = selection ? selection.start : playhead >= T.duration(audio) - 1 ? 0 : playhead;
      // About 10 seconds of output, so the preview is ready in a moment.
      const clip = T.slice(audio, from, Math.min(T.duration(audio), from + 10 * f));
      status('Preparing preview…');
      preview(await T.stretch(clip, f, $('tempo-keep-pitch').checked, { signal }), 'Playing 10 seconds at the new tempo…');
    })
  );

  $('tempo-apply').addEventListener('click', () =>
    run(async (signal) => {
      const f = checkedFactor();
      T.player.stop();
      const minutes = T.duration(audio) / 60;
      status(`Changing tempo… about ${Math.max(1, Math.round(minutes * 3))} seconds.`);
      const result = await T.stretch(audio, f, $('tempo-keep-pitch').checked, { signal });
      commit(result, `Tempo changed to ${Math.round(f * 1000) / 10}%.`);
      if (segValue('data-tempo-mode') === 'bpm') {
        $('tempo-from').value = $('tempo-to').value;
      } else {
        $('tempo-percent').value = 100;
      }
      refreshTempo();
    })
  );

  // ---------- Save ----------

  $('edit-save').addEventListener('click', () =>
    run(async (signal) => {
      T.player.stop();
      status('Saving…');
      const saved = await T.save(audio, picker.value, `${title} (edited)`, { signal });
      results.add(saved, picker.describe());
      status(saved.saved ? null : 'Not saved.');
    })
  );
})();
