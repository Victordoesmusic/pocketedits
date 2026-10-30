// Helpers shared by every tab: status messages, saving downloads, the floating Stop button,
// drop targets and small text utilities.

// The Electron bridge (preload.js). Missing when the page runs in a plain browser.
const bridge = window.audiosmith || null;

function setStatus(el, message, kind) {
  el.className = `status status-${kind === 'error' || kind === 'success' ? kind : 'info'} mt-4 fade-in`;
  el.textContent = message;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------- Saving ----------

// Electron reports each finished download (with where it went) by the blob URL that
// started it; this maps those reports back to the waiting saveResponse() call.
const pendingSaves = new Map();
if (bridge) {
  bridge.onDownloadDone((info) => {
    const resolve = pendingSaves.get(info.url);
    if (!resolve) return;
    pendingSaves.delete(info.url);
    resolve(info);
  });
}

function filenameFrom(response, fallback) {
  const disposition = response.headers.get('Content-Disposition') || '';
  // Prefer the UTF-8 name (filename*=); the plain filename= is ASCII-only and drops
  // characters such as Chinese.
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const asciiMatch = disposition.match(/filename="(.+?)"/);
  let filename = asciiMatch ? asciiMatch[1] : fallback;
  if (utf8Match) {
    try {
      filename = decodeURIComponent(utf8Match[1]);
    } catch {
      // keep the ASCII fallback
    }
  }
  return filename;
}

// Saves a file response through the normal download flow (Electron shows a save dialog)
// and resolves once it's written: { filename, objectUrl, size, savedPath, saved }.
// The blob URL is kept alive so a results list can play the file back.
async function saveResponse(response) {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Saving failed.');
  }

  const blob = await response.blob();
  const filename = filenameFrom(response, 'audio.mp3');
  const objectUrl = URL.createObjectURL(blob);
  const done = bridge ? new Promise((resolve) => pendingSaves.set(objectUrl, resolve)) : null;

  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  const info = done ? await done : { state: 'completed', savePath: null };
  if (info.state !== 'completed') URL.revokeObjectURL(objectUrl);
  return {
    filename,
    objectUrl,
    size: blob.size,
    savedPath: info.savePath || null,
    saved: info.state === 'completed',
  };
}

// ---------- Stop button: aborts whichever operation(s) are currently in flight ----------

const stopBtn = document.getElementById('stop-btn');
const activeControllers = new Set();

function updateStopButton() {
  const idle = activeControllers.size === 0;
  stopBtn.classList.toggle('stop-bar-inactive', idle);
  // Invisible while idle, so keep it out of the Tab order and screen readers too.
  stopBtn.tabIndex = idle ? -1 : 0;
  stopBtn.setAttribute('aria-hidden', String(idle));
}
updateStopButton();
function trackController(controller) {
  activeControllers.add(controller);
  updateStopButton();
  return () => {
    activeControllers.delete(controller);
    updateStopButton();
  };
}
stopBtn.addEventListener('click', () => activeControllers.forEach((c) => c.abort()));

// ---------- Drop targets ----------

// The whole card accepts drops; `highlight` picks what lights up (usually the visible
// drop zone). onDrop gets the DataTransfer, so callers can take several files or a link.
function wireDropTarget(card, { onDrop, accepts = () => true, highlight = () => card }) {
  let depth = 0; // dragenter/leave fire for every child; count them so the highlight doesn't flicker
  let lit = null;
  const clear = () => {
    lit?.classList.remove('drop-active');
    lit = null;
  };
  card.addEventListener('dragenter', (e) => {
    if (!accepts()) return;
    e.preventDefault();
    depth++;
    if (!lit) {
      lit = highlight() || card;
      lit.classList.add('drop-active');
    }
  });
  card.addEventListener('dragover', (e) => {
    if (!accepts()) return;
    e.preventDefault();
  });
  card.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) clear();
  });
  card.addEventListener('drop', (e) => {
    depth = 0;
    clear();
    if (!accepts()) return;
    e.preventDefault();
    onDrop(e.dataTransfer);
  });
}

// Single-file drop zone: click or Enter opens the picker; dropping anywhere on the card works.
function wireDropzone({ zoneId, labelId, spinnerId, inputId, idleLabel, busyLabel, onFile }) {
  const zone = document.getElementById(zoneId);
  const label = document.getElementById(labelId);
  const spinner = document.getElementById(spinnerId);
  const input = document.getElementById(inputId);
  let busy = false;

  const setBusy = (isBusy) => {
    busy = isBusy;
    zone.setAttribute('aria-disabled', isBusy ? 'true' : 'false');
    zone.classList.toggle('is-busy', isBusy);
    label.textContent = isBusy ? busyLabel : idleLabel;
    spinner.classList.toggle('hidden', !isBusy);
  };

  const handle = async (file) => {
    if (!file || busy) return;
    setBusy(true);
    try {
      await onFile(file);
    } finally {
      setBusy(false);
    }
  };

  zone.addEventListener('click', () => !busy && input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!busy) input.click();
    }
  });
  input.addEventListener('change', () => {
    handle(input.files[0]);
    input.value = '';
  });
  wireDropTarget(zone.closest('.card') || zone, {
    accepts: () => !busy,
    highlight: () => (zone.offsetParent ? zone : null),
    onDrop: (dt) => dt.files && dt.files.length && handle(dt.files[0]),
  });
}

// ---------- Save folder ----------

// Every saved file goes to one folder (chosen with the native picker, remembered by the
// app). Each [data-destination] slot shows it with a Change button; all slots stay in sync.
const Destination = (() => {
  const slots = [...document.querySelectorAll('[data-destination]')];
  if (!bridge || !bridge.getOutputDir) {
    slots.forEach((el) => el.remove());
    return { get name() { return null; } };
  }
  let current = null;

  function render() {
    slots.forEach((el) => {
      el.innerHTML = `
        <div class="dest-row">
          <span class="field-label" style="min-width:52px">Save to</span>
          <span class="dest-folder" title="${escapeHtml(current?.path || '')}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
            <span>${escapeHtml(current?.name || '…')}</span>
          </span>
          <button type="button" class="text-btn" data-change aria-label="Change save folder (currently ${escapeHtml(current?.name || '')})">Change</button>
        </div>`;
      el.querySelector('[data-change]').addEventListener('click', async () => {
        current = await bridge.chooseOutputDir();
        render();
      });
    });
  }

  bridge.getOutputDir().then((dir) => {
    current = dir;
    render();
  });
  render();

  return {
    get name() {
      return current?.name || null;
    },
  };
})();

// ---------- Playback ----------

// One shared player for every play button in the app, so starting one stops the others.
const Playback = (() => {
  const audio = new Audio();
  let onStop = null;
  const stop = () => {
    audio.pause();
    const done = onStop;
    onStop = null;
    done?.();
  };
  audio.addEventListener('ended', stop);
  return {
    // Plays url (or stops it if it's the one playing). onChange(true|false) tracks state.
    toggle(url, onChange) {
      const same = onStop && audio.src === url;
      stop();
      if (same) return;
      audio.src = url;
      onStop = () => onChange(false);
      onChange(true);
      audio.play().catch(stop);
    },
    stop,
  };
})();
