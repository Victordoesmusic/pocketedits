// Output settings: format chips, the setting that matters for that format (bitrate or bit
// depth), and sample rate under "Advanced". Options are limited to what the server's
// /api/output-formats says it accepts, so nothing unsupported is ever offered.
const FormatPicker = (() => {
  const FORMATS = {
    mp3: {
      label: 'MP3',
      setting: 'Bitrate',
      note: 'Plays on almost anything',
      qualities: { 320: '320 kbps', 256: '256 kbps', 192: '192 kbps', 128: '128 kbps' },
      rateNote: 'MP3 goes up to 48 kHz; faster sources are converted down.',
    },
    wav: {
      label: 'WAV',
      setting: 'Bit depth',
      note: 'Uncompressed, largest files',
      qualities: { 24: '24-bit', 16: '16-bit', '32f': '32-bit float' },
      rateNote: '',
    },
    flac: {
      label: 'FLAC',
      setting: 'Bit depth',
      note: 'Lossless, about half the size of WAV',
      qualities: { 16: '16-bit', 24: '24-bit' },
      rateNote: '',
    },
    m4a: {
      label: 'M4A',
      setting: 'Bitrate',
      note: 'AAC codec, smaller than MP3 at the same quality',
      qualities: { 256: '256 kbps', 192: '192 kbps', 128: '128 kbps' },
      rateNote: 'AAC goes up to 96 kHz; faster sources are converted down.',
    },
  };
  const RATE_LABELS = { original: 'Same as source', 44100: '44.1 kHz', 48000: '48 kHz', 88200: '88.2 kHz', 96000: '96 kHz' };

  // What the backend accepts; filled in once, shared by every picker.
  let caps = null;
  const capsReady = fetch('/api/output-formats')
    .then((r) => r.json())
    .then((c) => (caps = c))
    .catch(() => null);

  const CHECK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
  const CHEVRON = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
  let uid = 0;

  function create(container, { id }) {
    const n = ++uid;
    const storageKey = `audiosmith-format-${id}`;
    const listeners = [];
    let state = { format: 'mp3', quality: '320', sampleRate: 'original', advanced: false };
    try {
      Object.assign(state, JSON.parse(localStorage.getItem(storageKey) || '{}'));
    } catch {
      // defaults
    }

    container.classList.add('format-picker');
    container.innerHTML = `
      <div class="flex flex-col gap-2">
        <span class="field-label" id="fmt-label-${n}">Output format</span>
        <div class="chips" role="radiogroup" aria-labelledby="fmt-label-${n}">
          ${Object.entries(FORMATS)
            .map(([key, f]) => `<button type="button" role="radio" class="chip" data-format="${key}">${CHECK}${f.label}</button>`)
            .join('')}
        </div>
      </div>
      <div class="setting-row">
        <label class="flex flex-col gap-2">
          <span class="field-label" data-setting-label></span>
          <select class="select-field w-full" data-quality></select>
        </label>
        <p class="note" data-note></p>
      </div>
      <div class="flex flex-col gap-2">
        <button type="button" class="disclosure" aria-expanded="false" aria-controls="fmt-adv-${n}">${CHEVRON}Advanced</button>
        <div id="fmt-adv-${n}" class="setting-row hidden">
          <label class="flex flex-col gap-2">
            <span class="field-label">Sample rate</span>
            <select class="select-field w-full" data-rate></select>
          </label>
          <p class="note" data-rate-note></p>
        </div>
      </div>`;

    const qualitySelect = container.querySelector('[data-quality]');
    const rateSelect = container.querySelector('[data-rate]');
    const disclosure = container.querySelector('.disclosure');
    const advanced = container.querySelector(`#fmt-adv-${n}`);

    // Option lists for the current format: the backend's list when known, else ours.
    function options(kind) {
      const f = FORMATS[state.format];
      const fromServer = caps && caps[state.format] && caps[state.format][kind === 'quality' ? 'qualities' : 'sampleRates'];
      const ours = kind === 'quality' ? Object.keys(f.qualities) : Object.keys(RATE_LABELS);
      const values = fromServer || ours;
      const labels = kind === 'quality' ? f.qualities : RATE_LABELS;
      return values.filter((v) => labels[v]).map((v) => [v, labels[v]]);
    }

    function render() {
      if (!FORMATS[state.format]) state.format = 'mp3';
      const f = FORMATS[state.format];
      container.querySelectorAll('[data-format]').forEach((b) => {
        const on = b.dataset.format === state.format;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1; // one Tab stop for the group; arrows move inside it
      });

      const qualities = options('quality');
      if (!qualities.some(([v]) => v === state.quality)) state.quality = qualities[0][0];
      container.querySelector('[data-setting-label]').textContent = f.setting;
      qualitySelect.setAttribute('aria-label', f.setting);
      qualitySelect.innerHTML = qualities.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
      qualitySelect.value = state.quality;
      container.querySelector('[data-note]').textContent = f.note;

      const rates = options('rate');
      if (!rates.some(([v]) => v === state.sampleRate)) state.sampleRate = 'original';
      rateSelect.innerHTML = rates.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
      rateSelect.value = state.sampleRate;
      container.querySelector('[data-rate-note]').textContent = f.rateNote;

      disclosure.setAttribute('aria-expanded', String(state.advanced));
      advanced.classList.toggle('hidden', !state.advanced);

      try {
        localStorage.setItem(storageKey, JSON.stringify(state));
      } catch {
        // not remembered
      }
      listeners.forEach((fn) => fn());
    }

    container.querySelectorAll('[data-format]').forEach((b) =>
      b.addEventListener('click', () => {
        if (state.format === b.dataset.format) return;
        state.format = b.dataset.format;
        state.quality = null; // the new format's recommended setting
        render();
      })
    );
    // Arrow keys move between chips, as in any radio group.
    container.querySelector('.chips').addEventListener('keydown', (e) => {
      if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
      const keys = Object.keys(FORMATS);
      const next = keys[(keys.indexOf(state.format) + (e.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length];
      e.preventDefault();
      container.querySelector(`[data-format="${next}"]`).click();
      container.querySelector(`[data-format="${next}"]`).focus();
    });
    qualitySelect.addEventListener('change', () => {
      state.quality = qualitySelect.value;
      render();
    });
    rateSelect.addEventListener('change', () => {
      state.sampleRate = rateSelect.value;
      render();
    });
    disclosure.addEventListener('click', () => {
      state.advanced = !state.advanced;
      render();
    });

    render();
    capsReady.then(render);

    return {
      get value() {
        return { format: state.format, quality: state.quality, sampleRate: state.sampleRate };
      },
      get label() {
        return FORMATS[state.format].label;
      },
      // e.g. "MP3, 320 kbps", for saved-file rows
      describe() {
        const f = FORMATS[state.format];
        const rate = state.sampleRate === 'original' ? '' : `, ${RATE_LABELS[state.sampleRate]}`;
        return `${f.label}, ${f.qualities[state.quality]}${rate}`;
      },
      onChange(fn) {
        listeners.push(fn);
      },
    };
  }

  return { create };
})();
