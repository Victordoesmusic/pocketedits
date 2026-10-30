// Metronome tab. Clicks are scheduled slightly ahead on the audio clock (the standard
// "lookahead" pattern), so timing stays sample-accurate even if the page is busy.
(() => {
  const $ = (id) => document.getElementById(id);
  const MIN = 30;
  const MAX = 300;
  const LOOKAHEAD_S = 0.12;
  const TICK_MS = 25;

  let bpm = 120;
  let beatsPerBar = 4;
  let running = false;
  let timer = null;
  let nextTime = 0;
  let beat = 0;
  let visualQueue = [];
  let master = null;

  try {
    const saved = JSON.parse(localStorage.getItem('audiosmith-metronome') || '{}');
    if (saved.bpm) bpm = clamp(saved.bpm);
    if (saved.beatsPerBar) beatsPerBar = saved.beatsPerBar;
  } catch {
    // defaults
  }

  function clamp(v) {
    return Math.max(MIN, Math.min(MAX, Math.round(v)));
  }

  function remember() {
    try {
      localStorage.setItem('audiosmith-metronome', JSON.stringify({ bpm, beatsPerBar }));
    } catch {
      // not remembered
    }
  }

  // ---------- UI ----------

  const beatsSelect = $('metro-beats');
  for (let n = 1; n <= 12; n++) {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n === 1 ? '1 (no bar)' : String(n);
    beatsSelect.appendChild(opt);
  }

  function renderDots() {
    const dots = $('metro-dots');
    dots.innerHTML = '';
    for (let i = 0; i < beatsPerBar; i++) {
      const d = document.createElement('span');
      d.className = `metro-dot${i === 0 && $('metro-accent').checked && beatsPerBar > 1 ? ' accent' : ''}`;
      dots.appendChild(d);
    }
  }

  function setBpm(v) {
    bpm = clamp(v);
    $('metro-bpm').textContent = bpm;
    $('metro-slider').value = bpm;
    remember();
  }

  $('metro-slider').addEventListener('input', (e) => setBpm(Number(e.target.value)));
  $('metro-down').addEventListener('click', () => setBpm(bpm - 1));
  $('metro-up').addEventListener('click', () => setBpm(bpm + 1));
  beatsSelect.addEventListener('change', () => {
    beatsPerBar = Number(beatsSelect.value);
    beat = beat % beatsPerBar;
    renderDots();
    remember();
  });
  $('metro-accent').addEventListener('change', renderDots);

  // Tap tempo: average of the last few taps; a pause of 2s starts a fresh count.
  let taps = [];
  $('metro-tap').addEventListener('click', () => {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    taps = taps.slice(-5);
    if (taps.length >= 2) setBpm(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)));
  });

  // ---------- Sound ----------

  function click(time, isAccent) {
    const ctx = AudioTools.audioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = isAccent ? 1760 : 1100;
    const peak = Number($('metro-volume').value) * (isAccent ? 1 : 0.7);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
    osc.connect(gain).connect(master);
    osc.start(time);
    osc.stop(time + 0.07);
  }

  function schedule() {
    const ctx = AudioTools.audioContext();
    while (nextTime < ctx.currentTime + LOOKAHEAD_S) {
      const accent = beat === 0 && beatsPerBar > 1 && $('metro-accent').checked;
      click(nextTime, accent);
      visualQueue.push({ beat, time: nextTime });
      nextTime += 60 / bpm;
      beat = (beat + 1) % beatsPerBar;
    }
  }

  function animate() {
    if (!running) return;
    const now = AudioTools.audioContext().currentTime;
    let current = null;
    while (visualQueue.length && visualQueue[0].time <= now) current = visualQueue.shift();
    if (current) {
      const dots = $('metro-dots').children;
      [...dots].forEach((d, i) => d.classList.toggle('on', i === current.beat));
      // Let the light fall back shortly after each click.
      setTimeout(() => dots[current.beat]?.classList.remove('on'), Math.min(120, (60 / bpm) * 500));
    }
    requestAnimationFrame(animate);
  }

  async function start() {
    const ctx = AudioTools.audioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    master = ctx.createGain();
    master.connect(ctx.destination);
    running = true;
    beat = 0;
    visualQueue = [];
    nextTime = ctx.currentTime + 0.05;
    schedule();
    timer = setInterval(schedule, TICK_MS);
    $('metro-toggle').textContent = 'Stop';
    requestAnimationFrame(animate);
  }

  function stop() {
    if (!running) return;
    running = false;
    clearInterval(timer);
    // Cut off anything already scheduled ahead.
    master.disconnect();
    master = null;
    visualQueue = [];
    [...$('metro-dots').children].forEach((d) => d.classList.remove('on'));
    $('metro-toggle').textContent = 'Start';
  }

  const toggle = () => (running ? stop() : start());
  $('metro-toggle').addEventListener('click', toggle);

  const spaceIsOurs = (e) => e.code === 'Space' && Tabs.current === 'metronome' && !isTypingTarget(e.target);
  document.addEventListener('keydown', (e) => {
    if (!spaceIsOurs(e)) return;
    e.preventDefault();
    if (!e.repeat) toggle();
  });
  document.addEventListener('keyup', (e) => spaceIsOurs(e) && e.preventDefault());
  Tabs.onChange((tab) => tab !== 'metronome' && stop());

  beatsSelect.value = beatsPerBar;
  setBpm(bpm);
  renderDots();
})();
