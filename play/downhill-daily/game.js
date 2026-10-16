/* Downhill Daily - a Classroom Connect original.
 * One-button downhill runner. Plain canvas, no dependencies.
 * Everyone gets the same mountain each day (seeded by the UTC date);
 * Free ride uses a random mountain every run.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants and helpers
  // ---------------------------------------------------------------------------
  const W = 480;                 // slope width in world units (10 units = 1 metre)
  const CHUNK = 360;             // course is generated in chunks of this height
  const RIDER_R = 8;             // rider collision radius
  const EDGE = 14;               // forest edge on either side of the slope
  const THETA_MAX = 1.0;         // max carve angle from straight downhill (radians)
  const SPIN_DUR = 0.34;         // seconds for one 360 in the air
  const GHOST_STEP = 0.05;       // ghost sample interval (seconds)
  const LAUNCH_UTC = Date.UTC(2026, 9, 16); // Mountain #1
  const TURN = { snow: 4.6, ice: 2.2, powder: 3.4 };
  const GRIP = { snow: 14, ice: 4.0, powder: 10 };
  const DRAG = { snow: 0.8, ice: 0.35, powder: 1.9 };
  const SPEED_TO_KMH = 0.25;

  const reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  const fmt = (n) => Math.round(n).toLocaleString('en-GB');

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
    },
    prune(prefix, keepKey) {
      try {
        const doomed = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(prefix) && k !== keepKey) doomed.push(k);
        }
        doomed.forEach((k) => localStorage.removeItem(k));
      } catch (e) { /* ignore */ }
    },
  };

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash2(a, b) {
    let h = Math.imul((a ^ 0x9e3779b9) >>> 0, 0x85ebca6b) ^ Math.imul((b + 0x632be59b) >>> 0, 0xc2b2ae35);
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
    return h >>> 0;
  }

  const today = new Date();
  const DAY_KEY = today.getUTCFullYear() * 10000 + (today.getUTCMonth() + 1) * 100 + today.getUTCDate();
  const MOUNTAIN_NO = Math.max(1, Math.floor((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - LAUNCH_UTC) / 86400000) + 1);
  const DAY_LABEL = today.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const DAILY_SEED = hash2(DAY_KEY, 0xd0d0);
  const KEY_BEST_DAILY = 'dd_best_' + DAY_KEY;
  const KEY_GHOST = 'dd_ghost_' + DAY_KEY;
  store.prune('dd_best_2', KEY_BEST_DAILY);
  store.prune('dd_ghost_', KEY_GHOST);

  // ---------------------------------------------------------------------------
  // Course generation (deterministic from a seed)
  // ---------------------------------------------------------------------------
  class Course {
    constructor(seed) {
      this.seed = seed >>> 0;
      const r = mulberry32(hash2(this.seed, 0x51ed));
      this.a1 = 70 + r() * 40; this.l1 = 260 + r() * 100; this.p1 = r() * Math.PI * 2;
      this.a2 = 20 + r() * 25; this.l2 = 140 + r() * 60; this.p2 = r() * Math.PI * 2;
      this.chunks = new Map();
    }
    // The guaranteed-clear line down the mountain. Obstacles never sit on it.
    lineX(y) {
      const k = smooth(150, 1000, y);
      const wave = this.a1 * Math.sin(y / this.l1 + this.p1) + this.a2 * Math.sin(y / this.l2 + this.p2);
      return clamp(240 + k * wave, 90, 390);
    }
    corridor(y) { return Math.max(52, 120 - y * 0.0025); }
    gateWidth(y) { return Math.max(62, 100 - y * 0.0022); }
    rand(kind, k) { return mulberry32(hash2((this.seed ^ kind) >>> 0, k))(); }

    sequence(kind, base, step, spread, y0, y1) {
      const out = [];
      let k = Math.max(0, Math.floor((y0 - base) / step) - 1);
      for (; base + k * step - spread <= y1; k++) {
        const y = base + k * step + (this.rand(kind, k) - 0.5) * spread;
        if (y >= y0 && y < y1) out.push({ k, y });
      }
      return out;
    }
    gateYs(y0, y1) { return this.sequence(0xa11, 650, 470, 120, y0, y1); }
    rampYs(y0, y1) {
      // Keep ramps clear of gates so the two never stack up.
      return this.sequence(0xb33, 2600, 2300, 1200, y0 - 400, y1 + 400)
        .map((r) => {
          let y = r.y;
          const near = this.gateYs(y - 400, y + 400).some((g) => Math.abs(g.y - y) < 170 || Math.abs(g.y - (y + 220)) < 60);
          if (near) y += 220;
          return { k: r.k, y };
        })
        .filter((r) => r.y >= y0 && r.y < y1);
    }

    chunk(i) {
      let c = this.chunks.get(i);
      if (!c) { c = this.generate(i); this.chunks.set(i, c); }
      return c;
    }

    generate(i) {
      const y0 = i * CHUNK;
      const y1 = y0 + CHUNK;
      const r = mulberry32(hash2(this.seed, (i + 1000003) >>> 0));
      const c = { i, obstacles: [], patches: [], ramps: [], gates: [], decor: [] };

      for (const g of this.gateYs(y0, y1)) {
        c.gates.push({
          k: g.k, y: g.y, w: this.gateWidth(g.y),
          x: this.lineX(g.y) + (this.rand(0xb22, g.k) - 0.5) * 20,
          state: 0, // 0 waiting, 1 passed, -1 missed
        });
      }
      for (const rp of this.rampYs(y0, y1)) {
        c.ramps.push({ x: this.lineX(rp.y + 17), y: rp.y, w: 64, h: 34 });
      }

      if (y0 >= 1080) {
        if (r() < Math.min(0.55, 0.12 + y0 / 22000)) {
          const py = y0 + 60 + r() * (CHUNK - 120);
          c.patches.push({ t: 'ice', x: this.lineX(py) + (r() - 0.5) * 70, y: py, rx: 50 + r() * 45, ry: 32 + r() * 30, rot: (r() - 0.5) * 0.8 });
        }
        if (r() < 0.32) {
          const py = y0 + 40 + r() * (CHUNK - 80);
          c.patches.push({ t: 'powder', x: 60 + r() * 360, y: py, rx: 40 + r() * 40, ry: 26 + r() * 22, rot: (r() - 0.5) * 0.6, seed: (r() * 1e6) | 0 });
        }
      }

      if (y1 > 520) {
        const n = 5 + Math.floor(Math.min(11, y0 / 1400));
        let tries = 0;
        while (c.obstacles.length < n && tries < n * 14) {
          tries++;
          const y = y0 + r() * CHUNK;
          const roll = r();
          const t = roll < 0.68 ? 'tree' : roll < 0.9 ? 'rock' : 'log';
          const s = t === 'tree' ? 0.8 + r() * 0.55 : t === 'rock' ? 0.8 + r() * 0.5 : 1;
          const rad = t === 'tree' ? 8 * s : t === 'rock' ? 11 * s : 6;
          const half = t === 'log' ? 26 + r() * 10 : 0;
          const ang = t === 'log' ? (r() - 0.5) * 0.7 : 0;
          const x = 28 + r() * (W - 56);
          if (y < 520) continue;
          const ext = rad + Math.abs(Math.cos(ang)) * half;
          const vext = Math.abs(Math.sin(ang)) * half;
          let blocked = false;
          for (const yy of [y - vext, y, y + vext]) {
            if (Math.abs(x - this.lineX(yy)) < this.corridor(yy) + ext + 4) { blocked = true; break; }
          }
          if (blocked) continue;
          if (c.gates.some((g) => Math.abs(g.y - y) < 44 && Math.abs(g.x - x) < g.w / 2 + 34)) continue;
          if (c.ramps.some((rp) => y > rp.y - 60 && y < rp.y + 380 && Math.abs(x - this.lineX(y)) < this.corridor(y) + ext + 70)) continue;
          if (c.obstacles.some((o) => Math.hypot(o.x - x, o.y - y) < o.rad + rad + o.half + half + 26)) continue;
          const pts = t === 'rock' ? Array.from({ length: 7 }, () => 0.78 + r() * 0.34) : null;
          c.obstacles.push({ t, x, y, s, rad, half, ang, pts });
        }
      }

      // Forest: a wall of trees on each edge, and a deeper forest beyond.
      for (let k = 0; k < 5; k++) {
        c.decor.push({ x: 2 + r() * 12, y: y0 + r() * CHUNK, s: 0.9 + r() * 0.5 });
        c.decor.push({ x: W - 2 - r() * 12, y: y0 + r() * CHUNK, s: 0.9 + r() * 0.5 });
      }
      for (let k = 0; k < 20; k++) {
        const d = Math.pow(r(), 1.5) * 400 + 8;
        c.decor.push({ x: -d, y: y0 + r() * CHUNK, s: 0.85 + r() * 0.7 });
        c.decor.push({ x: W + d, y: y0 + r() * CHUNK, s: 0.85 + r() * 0.7 });
      }
      return c;
    }

    resetRunState() {
      for (const c of this.chunks.values()) for (const g of c.gates) g.state = 0;
    }

    pruneBefore(y) {
      const keepFrom = Math.floor(y / CHUNK) - 3;
      for (const i of this.chunks.keys()) if (i < keepFrom) this.chunks.delete(i);
    }

    surfaceAt(x, y) {
      const ci = Math.floor(y / CHUNK);
      let found = 'snow';
      for (let i = ci - 1; i <= ci + 1; i++) {
        for (const p of this.chunk(i).patches) {
          const dx = x - p.x, dy = y - p.y;
          const cs = Math.cos(-p.rot), sn = Math.sin(-p.rot);
          const lx = dx * cs - dy * sn, ly = dx * sn + dy * cs;
          if ((lx * lx) / (p.rx * p.rx) + (ly * ly) / (p.ry * p.ry) <= 1) {
            if (p.t === 'ice') return 'ice';
            found = 'powder';
          }
        }
      }
      return found;
    }
  }

  // ---------------------------------------------------------------------------
  // Sound (small synthesised effects, no audio files)
  // ---------------------------------------------------------------------------
  const sfx = {
    ctx: null, master: null, windGain: null, windFilter: null, noise: null,
    muted: !!store.get('dd_mute', false),
    ensure() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.7;
        this.master.connect(this.ctx.destination);
        const len = this.ctx.sampleRate * 2;
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const data = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        const src = this.ctx.createBufferSource();
        src.buffer = this.noise; src.loop = true;
        this.windFilter = this.ctx.createBiquadFilter();
        this.windFilter.type = 'bandpass'; this.windFilter.frequency.value = 500; this.windFilter.Q.value = 0.6;
        this.windGain = this.ctx.createGain(); this.windGain.gain.value = 0;
        src.connect(this.windFilter).connect(this.windGain).connect(this.master);
        src.start();
      } catch (e) { this.ctx = null; }
    },
    setMuted(m) {
      this.muted = m; store.set('dd_mute', m);
      if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.7, this.ctx.currentTime, 0.02);
    },
    wind(level, speed) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      this.windGain.gain.setTargetAtTime(level, t, 0.15);
      this.windFilter.frequency.setTargetAtTime(380 + speed * 2.2, t, 0.2);
    },
    burst(dur, type, freq, gain, q) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const src = this.ctx.createBufferSource(); src.buffer = this.noise;
      const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; if (q) f.Q.value = q;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(f).connect(g).connect(this.master);
      src.start(t, Math.random()); src.stop(t + dur + 0.05);
    },
    tone(freq, dur, gain, type, when, slideTo) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime + (when || 0);
      const o = this.ctx.createOscillator(); o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.05);
    },
    carve() { this.burst(0.16, 'highpass', 1800, 0.22); },
    gate(combo) { const f = 660 * Math.pow(1.12, combo - 1); this.tone(f, 0.22, 0.18); this.tone(f * 1.5, 0.28, 0.14, 'sine', 0.07); },
    miss() { this.tone(220, 0.18, 0.12, 'triangle'); },
    launch() { this.burst(0.35, 'bandpass', 900, 0.25, 0.8); },
    spin() { this.burst(0.3, 'bandpass', 1400, 0.18, 1.2); },
    land(clean) { this.burst(0.2, 'lowpass', 500, 0.3); if (clean) this.tone(880, 0.25, 0.14, 'sine', 0.05); },
    crash() { this.tone(140, 0.45, 0.4, 'sine', 0, 45); this.burst(0.5, 'lowpass', 700, 0.45); },
  };

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const ui = {
    hud: $('hud'), score: $('hudScore'), dist: $('hudDist'), modeLabel: $('hudModeLabel'), speed: $('hudSpeed'),
    combo: $('hudCombo'), comboVal: $('hudComboVal'),
    menu: $('menu'), menuSub: $('menuSub'), menuBest: $('menuBest'),
    pause: $('pause'), results: $('results'),
    resultTitle: $('resultTitle'), resultReason: $('resultReason'), resultScore: $('resultScore'),
    resultNewBest: $('resultNewBest'), resultBest: $('resultBest'),
    statDist: $('statDist'), statGates: $('statGates'), statTricks: $('statTricks'), statTop: $('statTop'),
    toast: $('toast'), sr: $('srStatus'),
  };

  // ---------------------------------------------------------------------------
  // Game state
  // ---------------------------------------------------------------------------
  const game = {
    state: 'menu',          // menu | play | paused | dead | results
    mode: 'daily',
    course: new Course(DAILY_SEED),
    attractY: 0,
    crashT: 0,
    reason: '',
  };
  let rider = null;
  let run = null;
  let ghost = null;          // flat array of recorded samples [x, y, theta*100, h*100, ...]
  let trail = [];
  let particles = [];
  let texts = [];
  const view = { cssW: 0, cssH: 0, dpr: 1, base: 1, zoom: 1, scale: 1, offX: 0, camY: 0, shake: 0 };
  const flakes = [];

  function gravity(y) { return 210 + Math.min(150, y * 0.012); }

  function newRider() {
    return {
      x: game.course.lineX(0), y: 0, s: 120, theta: 0.35, phi: 0.35, dir: 1,
      air: false, airT: 0, airDur: 0, spin: null, spins: 0,
      alive: true, tumble: 0,
    };
  }

  function startRun(mode) {
    game.mode = mode;
    const seed = mode === 'daily' ? DAILY_SEED : (Math.random() * 4294967296) >>> 0;
    if (game.course.seed !== seed || game.course.chunks.size > 40) game.course = new Course(seed);
    game.course.resetRunState();
    rider = newRider();
    run = { bonus: 0, combo: 1, gates: 0, gatesSeen: 0, spins: 0, top: 0, t: 0, rec: [], recAcc: 0, best: bestFor(mode) };
    ghost = mode === 'daily' ? store.get(KEY_GHOST, null) : null;
    trail = []; particles = []; texts = [];
    view.zoom = 1; view.shake = 0;
    game.state = 'play';
    ui.menu.hidden = true; ui.results.hidden = true; ui.pause.hidden = true; ui.hud.hidden = false;
    ui.modeLabel.textContent = mode === 'daily' ? 'Mountain #' + MOUNTAIN_NO : 'Free ride';
    ui.combo.hidden = true;
    sfx.ensure();
    canvas.focus({ preventScroll: true });
  }

  function bestFor(mode) { return store.get(mode === 'daily' ? KEY_BEST_DAILY : 'dd_best_free', 0); }

  function score() { return Math.floor(Math.max(0, rider.y) / 10) + run.bonus; }

  function action() {
    if (game.state !== 'play') return;
    if (rider.air) {
      if (!rider.spin) { rider.spin = { t: 0, dir: rider.dir }; sfx.spin(); }
      return;
    }
    setDir(-rider.dir);
  }

  function setDir(d) {
    if (game.state !== 'play' || rider.air || d === rider.dir) return;
    rider.dir = d;
    sfx.carve();
    sprayBurst(10);
  }

  function crash(reason) {
    if (!rider.alive) return;
    rider.alive = false;
    game.reason = reason;
    game.state = 'dead';
    game.crashT = 0;
    view.shake = reducedMotion ? 0 : 12;
    sfx.crash();
    sfx.wind(0, 0);
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, v = 40 + Math.random() * 160;
      particles.push({ x: rider.x, y: rider.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, life: 0, max: 0.6 + Math.random() * 0.6, r: 1.5 + Math.random() * 2.5, c: Math.random() < 0.7 ? '#ffffff' : '#cfdced' });
    }
  }

  function showResults() {
    game.state = 'results';
    const sc = score();
    const prev = run.best;
    const isBest = sc > prev;
    if (isBest) {
      store.set(game.mode === 'daily' ? KEY_BEST_DAILY : 'dd_best_free', sc);
      if (game.mode === 'daily' && run.rec.length > 8) store.set(KEY_GHOST, run.rec);
    }
    ui.hud.hidden = true;
    ui.resultTitle.textContent = game.mode === 'daily' ? 'Mountain #' + MOUNTAIN_NO : 'Free ride';
    ui.resultReason.textContent = game.reason;
    ui.resultScore.textContent = fmt(sc);
    ui.resultNewBest.hidden = !isBest || prev === 0;
    ui.resultNewBest.textContent = 'New best, up from ' + fmt(prev);
    ui.resultBest.textContent = (game.mode === 'daily' ? 'Best today: ' : 'Best free ride: ') + fmt(Math.max(sc, prev));
    ui.statDist.textContent = fmt(rider.y / 10);
    ui.statGates.textContent = run.gates + '/' + run.gatesSeen;
    ui.statTricks.textContent = run.spins;
    ui.statTop.textContent = fmt(run.top * SPEED_TO_KMH);
    ui.results.hidden = false;
    ui.sr.textContent = 'Run over. ' + game.reason + ' Score ' + fmt(sc) + '.';
    $('againBtn').focus({ preventScroll: true });
  }

  function showMenu() {
    game.state = 'menu';
    if (game.course.seed !== DAILY_SEED) game.course = new Course(DAILY_SEED);
    game.attractY = 0;
    rider = null;
    ui.hud.hidden = true; ui.results.hidden = true; ui.pause.hidden = true; ui.menu.hidden = false;
    ui.menuSub.textContent = 'Mountain #' + MOUNTAIN_NO + ' · ' + DAY_LABEL;
    const bd = store.get(KEY_BEST_DAILY, 0), bf = store.get('dd_best_free', 0);
    const parts = [];
    if (bd) parts.push('Best today: ' + fmt(bd));
    if (bf) parts.push('Best free ride: ' + fmt(bf));
    ui.menuBest.textContent = parts.join('  ·  ');
    sfx.wind(0, 0);
  }

  function setPaused(p) {
    if (p && game.state === 'play') {
      game.state = 'paused'; ui.pause.hidden = false; sfx.wind(0, 0);
      $('resumeBtn').focus({ preventScroll: true });
    } else if (!p && game.state === 'paused') {
      game.state = 'play'; ui.pause.hidden = true; sfx.ensure();
      canvas.focus({ preventScroll: true });
    }
  }

  function toast(msg) {
    ui.toast.textContent = msg; ui.toast.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => ui.toast.classList.remove('show'), 1800);
  }

  function addText(x, y, text, color) { texts.push({ x, y, text, color: color || '#17253b', life: 0 }); }

  function sprayBurst(n) {
    if (!rider) return;
    const side = rider.dir; // spray kicks out away from the new carve
    for (let i = 0; i < n; i++) {
      const a = rider.phi + Math.PI / 2 * -side + (Math.random() - 0.5) * 0.9;
      const v = 40 + Math.random() * 90;
      particles.push({ x: rider.x, y: rider.y, vx: Math.sin(a) * v, vy: Math.cos(a) * v * 0.6 - 10, life: 0, max: 0.35 + Math.random() * 0.35, r: 1 + Math.random() * 1.8, c: '#ffffff' });
    }
  }

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------
  function update(dt) {
    if (game.state === 'menu') { game.attractY += 70 * dt; updateParticles(dt); return; }
    if (game.state === 'paused' || game.state === 'results') return;
    if (game.state === 'dead') {
      game.crashT += dt;
      rider.tumble += dt * 9 * Math.max(0, 1 - game.crashT * 1.4);
      rider.x += Math.sin(rider.phi) * rider.s * dt * Math.max(0, 1 - game.crashT * 3);
      rider.y += Math.cos(rider.phi) * rider.s * dt * Math.max(0, 1 - game.crashT * 3);
      updateParticles(dt);
      if (game.crashT > 1.0) showResults();
      return;
    }

    // play: sub-step for stable collisions at speed
    const steps = Math.ceil(dt / (1 / 240));
    const h = dt / steps;
    for (let i = 0; i < steps && game.state === 'play'; i++) step(h);

    run.t += dt;
    run.top = Math.max(run.top, rider.s);
    run.recAcc += dt;
    while (run.recAcc >= GHOST_STEP) {
      run.recAcc -= GHOST_STEP;
      run.rec.push(Math.round(rider.x), Math.round(rider.y), Math.round(rider.phi * 100), Math.round(airHeight() * 100));
    }

    // Trail and ambient spray
    if (!rider.air) {
      trail.push({ x: rider.x, y: rider.y, p: rider.phi });
      const surf = game.course.surfaceAt(rider.x, rider.y);
      const slide = Math.abs(rider.theta - rider.phi);
      const chance = surf === 'powder' ? 0.9 : Math.min(0.6, slide * 2 + Math.abs(rider.theta) * 0.15);
      if (Math.random() < chance) sprayBurst(1);
    } else if (trail.length && trail[trail.length - 1] !== null) {
      trail.push(null);
    }
    if (trail.length > 320) trail.splice(0, trail.length - 320);

    updateParticles(dt);
    game.course.pruneBefore(rider.y - 600);

    const level = clamp((rider.s - 60) / 420, 0, 1) * 0.16;
    sfx.wind(level, rider.s);
  }

  function airHeight() {
    if (!rider || !rider.air) return 0;
    return Math.sin(Math.PI * clamp(rider.airT / rider.airDur, 0, 1));
  }

  function step(dt) {
    const R = rider;
    const course = game.course;
    if (!R.air) {
      const surf = course.surfaceAt(R.x, R.y);
      const target = R.dir * THETA_MAX;
      const tr = TURN[surf] * dt;
      R.theta += clamp(target - R.theta, -tr, tr);
      R.phi += (R.theta - R.phi) * Math.min(1, GRIP[surf] * dt);
      R.s += (gravity(R.y) * Math.cos(R.theta) - DRAG[surf] * R.s) * dt;
      if (R.s < 70) R.s = 70;
    } else {
      R.airT += dt;
      R.s = Math.max(70, R.s - 12 * dt);
      if (R.spin) {
        R.spin.t += dt;
        if (R.spin.t >= SPIN_DUR) { R.spins++; R.spin = null; }
      }
      if (R.airT >= R.airDur) land();
      if (game.state !== 'play') return;
    }

    const py = R.y;
    R.x += Math.sin(R.phi) * R.s * dt;
    R.y += Math.cos(R.phi) * R.s * dt;

    if (R.x < EDGE || R.x > W - EDGE) { crash('You rode into the forest.'); return; }

    const ci = Math.floor(R.y / CHUNK);
    for (let i = ci - 1; i <= ci + 1; i++) {
      const c = course.chunk(i);
      for (const g of c.gates) {
        if (g.state === 0 && py < g.y && R.y >= g.y) {
          run.gatesSeen++;
          if (Math.abs(R.x - g.x) <= g.w / 2) {
            g.state = 1;
            const pts = 50 * run.combo;
            run.bonus += pts; run.gates++;
            sfx.gate(run.combo);
            addText(g.x, g.y - 30, '+' + pts, '#1f8f55');
            run.combo = Math.min(5, run.combo + 1);
          } else {
            g.state = -1;
            if (run.combo > 1) addText(R.x, R.y - 30, 'Combo lost', '#7a8798');
            run.combo = 1;
            sfx.miss();
          }
        }
      }
      if (!R.air) {
        for (const rp of c.ramps) {
          if (Math.abs(R.x - rp.x) < rp.w / 2 && R.y >= rp.y && R.y <= rp.y + rp.h) { launch(); break; }
        }
        for (const o of c.obstacles) {
          if (Math.abs(o.y - R.y) > 60) continue;
          let d;
          if (o.t === 'log') {
            const ex = Math.cos(o.ang) * o.half, ey = Math.sin(o.ang) * o.half;
            d = segDist(R.x, R.y, o.x - ex, o.y - ey, o.x + ex, o.y + ey);
          } else {
            d = Math.hypot(R.x - o.x, R.y - o.y);
          }
          if (d < RIDER_R + o.rad) {
            crash(o.t === 'tree' ? 'You hit a tree.' : o.t === 'rock' ? 'You hit a rock.' : 'You hit a log.');
            return;
          }
        }
      }
    }
  }

  function segDist(px, py, ax, ay, bx, by) {
    const vx = bx - ax, vy = by - ay;
    const t = clamp(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy), 0, 1);
    return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
  }

  function launch() {
    const R = rider;
    // Ramps point down the line, so take-off straightens you up along it.
    const course = game.course;
    const lineHeading = Math.atan2(course.lineX(R.y + 60) - course.lineX(R.y), 60);
    R.phi = R.phi * 0.3 + lineHeading * 0.7; R.theta = R.phi;
    R.air = true; R.airT = 0; R.airDur = 0.45 + R.s / 1500; R.spin = null; R.spins = 0;
    sfx.launch();
    addText(R.x, R.y - 34, 'Air!', '#3f7fd6');
  }

  function land() {
    const R = rider;
    R.air = false;
    if (R.spin) { crash('You landed mid-spin.'); return; }
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, v = 30 + Math.random() * 60;
      particles.push({ x: R.x, y: R.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.5, life: 0, max: 0.4 + Math.random() * 0.3, r: 1.2 + Math.random() * 1.8, c: '#ffffff' });
    }
    if (R.spins > 0) {
      const n = Math.min(4, R.spins);
      const pts = 150 * n * run.combo;
      run.bonus += pts; run.spins += n;
      const name = ['Spin', 'Double spin', 'Triple spin', 'Quad spin'][n - 1];
      addText(R.x, R.y - 34, name + '! +' + pts, '#e2453a');
      sfx.land(true);
    } else {
      sfx.land(false);
    }
    R.spins = 0;
  }

  function updateParticles(dt) {
    for (const p of particles) {
      p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - 2.5 * dt; p.vy *= 1 - 2.5 * dt;
    }
    if (particles.length) particles = particles.filter((p) => p.life < p.max);
    for (const t of texts) t.life += dt;
    if (texts.length) texts = texts.filter((t) => t.life < 1.1);
    view.shake *= Math.max(0, 1 - 6 * dt);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  let speckle = null;
  function makeSpeckle() {
    const c = document.createElement('canvas');
    c.width = c.height = 160;
    const g = c.getContext('2d');
    const r = mulberry32(7);
    for (let i = 0; i < 220; i++) {
      g.fillStyle = r() < 0.5 ? 'rgba(120,150,190,0.10)' : 'rgba(255,255,255,0.9)';
      g.beginPath(); g.arc(r() * 160, r() * 160, 0.4 + r() * 1.1, 0, Math.PI * 2); g.fill();
    }
    for (let i = 0; i < 26; i++) {
      g.strokeStyle = 'rgba(140,170,205,0.10)'; g.lineWidth = 1;
      const x = r() * 160, y = r() * 160;
      g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 6, y + 3, x + 14 + r() * 10, y + r() * 4); g.stroke();
    }
    speckle = ctx.createPattern(c, 'repeat');
  }

  function resize() {
    view.dpr = Math.min(2, window.devicePixelRatio || 1);
    view.cssW = window.innerWidth; view.cssH = window.innerHeight;
    canvas.width = Math.round(view.cssW * view.dpr);
    canvas.height = Math.round(view.cssH * view.dpr);
    view.base = Math.min(view.cssW / W, view.cssH / 640);
    flakes.length = 0;
    const n = reducedMotion ? 12 : 46;
    for (let i = 0; i < n; i++) flakes.push({ x: Math.random() * view.cssW, y: Math.random() * view.cssH, r: 0.8 + Math.random() * 1.8, s: 0.4 + Math.random() * 0.8, p: Math.random() * 6 });
  }

  function worldTransform() {
    const sx = view.shake ? (Math.random() - 0.5) * view.shake : 0;
    const sy = view.shake ? (Math.random() - 0.5) * view.shake : 0;
    const k = view.dpr * view.scale;
    ctx.setTransform(k, 0, 0, k, view.dpr * (view.offX + sx), view.dpr * (-view.camY * view.scale + sy));
  }

  function render(dt) {
    // Camera
    const focusY = rider ? rider.y : game.attractY;
    const speed = rider ? rider.s : 140;
    const targetZoom = 1 - 0.18 * smooth(180, 480, speed);
    view.zoom += (targetZoom - view.zoom) * Math.min(1, 2 * dt);
    view.scale = view.base * view.zoom;
    view.offX = (view.cssW - W * view.scale) / 2;
    view.camY = focusY - (view.cssH * 0.2) / view.scale;
    const top = view.camY - 40;
    const bottom = view.camY + view.cssH / view.scale + 60;
    const left = -view.offX / view.scale - 20;
    const right = (view.cssW - view.offX) / view.scale + 20;

    // Background outside the slope
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.fillStyle = '#dbe5ef';
    ctx.fillRect(0, 0, view.cssW, view.cssH);

    worldTransform();
    // Slope
    ctx.fillStyle = '#f6f9fc';
    ctx.fillRect(0, top, W, bottom - top);
    if (speckle) { ctx.fillStyle = speckle; ctx.fillRect(left, top, right - left, bottom - top); }
    const eg = ctx.createLinearGradient(0, 0, 28, 0);
    eg.addColorStop(0, 'rgba(120,150,185,0.22)'); eg.addColorStop(1, 'rgba(120,150,185,0)');
    ctx.fillStyle = eg; ctx.fillRect(0, top, 28, bottom - top);
    const eg2 = ctx.createLinearGradient(W, 0, W - 28, 0);
    eg2.addColorStop(0, 'rgba(120,150,185,0.22)'); eg2.addColorStop(1, 'rgba(120,150,185,0)');
    ctx.fillStyle = eg2; ctx.fillRect(W - 28, top, 28, bottom - top);

    const course = game.course;
    const c0 = Math.floor(top / CHUNK), c1 = Math.floor(bottom / CHUNK);
    const chunks = [];
    for (let i = c0; i <= c1; i++) chunks.push(course.chunk(i));

    for (const c of chunks) for (const p of c.patches) drawPatch(p);
    if (top < 40 && bottom > -40) drawStartLine();
    for (const c of chunks) for (const rp of c.ramps) drawRamp(rp);
    for (const c of chunks) for (const g of c.gates) drawGateLine(g);
    drawTrail();

    // Sprites sorted by ground y
    const sprites = [];
    for (const c of chunks) {
      for (const o of c.obstacles) sprites.push({ y: o.y, o, k: 'o' });
      for (const d of c.decor) if (d.x > left - 30 && d.x < right + 30) sprites.push({ y: d.y, o: d, k: 'd' });
      for (const g of c.gates) sprites.push({ y: g.y, o: g, k: 'g' });
    }
    const gs = ghostSample();
    if (gs) sprites.push({ y: gs.y, o: gs, k: 'ghost' });
    if (rider) sprites.push({ y: rider.y, o: rider, k: 'r' });
    sprites.sort((a, b) => a.y - b.y);

    // Shadows first
    for (const s of sprites) {
      if (s.k === 'o') drawObstacleShadow(s.o);
      else if (s.k === 'd') drawTreeShadow(s.o.x, s.o.y, s.o.s);
    }
    for (const s of sprites) {
      if (s.k === 'o') drawObstacle(s.o);
      else if (s.k === 'd') drawTree(s.o.x, s.o.y, s.o.s, 0.92);
      else if (s.k === 'g') drawGateFlags(s.o);
      else if (s.k === 'ghost') drawRider(s.o.x, s.o.y, s.o.phi, s.o.phi, s.o.h, 0, 0, true);
      else if (s.k === 'r') {
        const R = s.o;
        const spinAng = R.spin ? (R.spin.t / SPIN_DUR) * Math.PI * 2 * R.spin.dir : 0;
        drawRider(R.x, R.y, R.phi, R.theta, airHeight(), spinAng, R.tumble, false);
      }
    }

    // Particles and floating text
    for (const p of particles) {
      const a = 1 - p.life / p.max;
      ctx.globalAlpha = a;
      ctx.fillStyle = p.c;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    for (const t of texts) {
      const a = 1 - smooth(0.6, 1.1, t.life);
      ctx.globalAlpha = a;
      ctx.font = '800 15px ui-rounded, system-ui, sans-serif';
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText(t.text, t.x, t.y - t.life * 26);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y - t.life * 26);
    }
    ctx.globalAlpha = 1;
    drawHint();

    // Screen-space effects
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    drawFlakes(dt, speed);
    if (!reducedMotion && rider && game.state === 'play' && rider.s > 330) drawSpeedLines(rider.s);
    const vg = ctx.createRadialGradient(view.cssW / 2, view.cssH / 2, Math.min(view.cssW, view.cssH) * 0.45, view.cssW / 2, view.cssH / 2, Math.max(view.cssW, view.cssH) * 0.75);
    vg.addColorStop(0, 'rgba(23,37,59,0)'); vg.addColorStop(1, 'rgba(23,37,59,0.14)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, view.cssW, view.cssH);
  }

  function drawHint() {
    if (!rider || game.state !== 'play' || run.best > 0 || run.t > 4.5) return;
    const a = 1 - smooth(3.5, 4.5, run.t);
    const pulse = 0.85 + 0.15 * Math.sin(run.t * 6);
    ctx.globalAlpha = a;
    ctx.font = '800 14px ui-rounded, system-ui, sans-serif';
    ctx.textAlign = 'center';
    const label = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ? 'Tap to switch direction' : 'Space or tap to switch direction';
    const x = clamp(rider.x, 110, W - 110), y = rider.y + 70;
    const w = ctx.measureText(label).width + 22;
    ctx.fillStyle = 'rgba(23,37,59,' + (0.78 * pulse) + ')';
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x - w / 2, y - 16, w, 26, 13) : ctx.rect(x - w / 2, y - 16, w, 26); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x, y + 2);
    ctx.globalAlpha = 1;
  }

  function ghostSample() {
    if (!ghost || !run || !rider || game.mode !== 'daily') return null;
    const f = run.t / GHOST_STEP;
    const i = Math.floor(f);
    const n = ghost.length / 4;
    if (i + 1 >= n) return null;
    const t = f - i, a = i * 4, b = a + 4;
    return {
      x: ghost[a] + (ghost[b] - ghost[a]) * t,
      y: ghost[a + 1] + (ghost[b + 1] - ghost[a + 1]) * t,
      phi: (ghost[a + 2] + (ghost[b + 2] - ghost[a + 2]) * t) / 100,
      h: (ghost[a + 3] + (ghost[b + 3] - ghost[a + 3]) * t) / 100,
    };
  }

  function drawStartLine() {
    ctx.fillStyle = 'rgba(255,90,78,0.18)';
    ctx.fillRect(EDGE + 10, -3, W - 2 * EDGE - 20, 6);
    ctx.font = '900 italic 30px ui-rounded, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(23,37,59,0.10)';
    ctx.fillText(game.mode === 'daily' || game.state === 'menu' ? 'MOUNTAIN #' + MOUNTAIN_NO : 'FREE RIDE', W / 2, -24);
  }

  function drawPatch(p) {
    ctx.save();
    ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    if (p.t === 'ice') {
      const g = ctx.createLinearGradient(-p.rx, -p.ry, p.rx, p.ry);
      g.addColorStop(0, '#d9f3fd'); g.addColorStop(0.5, '#b8e6f8'); g.addColorStop(1, '#a2dcf3');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, 0, p.rx, p.ry, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(80,160,210,0.45)'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-p.rx * 0.5, -p.ry * 0.25); ctx.lineTo(-p.rx * 0.1, -p.ry * 0.45); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p.rx * 0.05, p.ry * 0.3); ctx.lineTo(p.rx * 0.45, p.ry * 0.05); ctx.stroke();
    } else {
      const g = ctx.createRadialGradient(0, 0, 4, 0, 0, Math.max(p.rx, p.ry));
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.75, '#ffffff'); g.addColorStop(1, 'rgba(205,220,236,0.9)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, 0, p.rx, p.ry, 0, 0, Math.PI * 2); ctx.fill();
      const r = mulberry32(p.seed);
      for (let i = 0; i < 9; i++) {
        const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 0.75;
        const x = Math.cos(a) * p.rx * d, y = Math.sin(a) * p.ry * d;
        ctx.fillStyle = 'rgba(170,195,222,0.45)';
        ctx.beginPath(); ctx.ellipse(x, y + 2, 5 + r() * 5, 2, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.ellipse(x, y, 5 + r() * 4, 2.5, 0, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawRamp(rp) {
    const x0 = rp.x - rp.w / 2;
    ctx.fillStyle = 'rgba(70,100,140,0.18)';
    ctx.fillRect(x0 + 4, rp.y + 6, rp.w, rp.h);
    const g = ctx.createLinearGradient(0, rp.y, 0, rp.y + rp.h);
    g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#cfe0f0');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x0, rp.y, rp.w, rp.h, 4) : ctx.rect(x0, rp.y, rp.w, rp.h); ctx.fill();
    ctx.fillStyle = '#7fa6cc'; ctx.fillRect(x0, rp.y + rp.h - 3, rp.w, 3);
    ctx.strokeStyle = '#3f7fd6'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const dy of [8, 18]) {
      ctx.beginPath(); ctx.moveTo(rp.x - 9, rp.y + dy); ctx.lineTo(rp.x, rp.y + dy + 6); ctx.lineTo(rp.x + 9, rp.y + dy); ctx.stroke();
    }
  }

  function gateColor(g) {
    if (g.state === 1) return '#2fa866';
    if (g.state === -1) return '#a7b2bf';
    return g.k % 2 ? '#3f7fd6' : '#ff5a4e';
  }

  function drawGateLine(g) {
    ctx.strokeStyle = g.state === -1 ? 'rgba(167,178,191,0.35)' : 'rgba(63,127,214,0.22)';
    ctx.lineWidth = 2; ctx.setLineDash([5, 6]);
    ctx.beginPath(); ctx.moveTo(g.x - g.w / 2, g.y); ctx.lineTo(g.x + g.w / 2, g.y); ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawGateFlags(g) {
    const col = gateColor(g);
    for (const side of [-1, 1]) {
      const px = g.x + side * g.w / 2;
      ctx.fillStyle = 'rgba(70,100,140,0.18)';
      ctx.beginPath(); ctx.ellipse(px + 4, g.y + 1, 5, 2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#5b6b80'; ctx.lineWidth = 2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(px, g.y); ctx.lineTo(px, g.y - 34); ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(px, g.y - 34); ctx.lineTo(px - side * 17, g.y - 28); ctx.lineTo(px, g.y - 21); ctx.closePath(); ctx.fill();
    }
  }

  function drawTreeShadow(x, y, s) {
    ctx.fillStyle = 'rgba(60,90,130,0.15)';
    ctx.beginPath(); ctx.ellipse(x + 7 * s, y + 2 * s, 14 * s, 5 * s, -0.2, 0, Math.PI * 2); ctx.fill();
  }

  function tri(cx, baseY, halfW, h, color) {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(cx - halfW, baseY); ctx.lineTo(cx + halfW, baseY); ctx.lineTo(cx, baseY - h); ctx.closePath(); ctx.fill();
  }

  function drawTree(x, y, s, shade) {
    const k = shade || 1;
    ctx.fillStyle = '#7a5236';
    ctx.fillRect(x - 2.2 * s, y - 5 * s, 4.4 * s, 7 * s);
    tri(x, y - 3 * s, 15 * s, 16 * s, k < 1 ? '#2a5f4c' : '#2e6b55');
    tri(x, y - 11 * s, 12 * s, 15 * s, k < 1 ? '#326f56' : '#37805f');
    tri(x, y - 19 * s, 8.5 * s, 14 * s, k < 1 ? '#3b7f61' : '#449468');
    tri(x, y - 27.5 * s, 3.4 * s, 5.5 * s, 'rgba(255,255,255,0.95)');
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillRect(x - 10 * s, y - 4.5 * s, 7 * s, 1.6 * s);
    ctx.fillRect(x + 2 * s, y - 12.5 * s, 6 * s, 1.5 * s);
  }

  function drawObstacleShadow(o) {
    if (o.t === 'tree') drawTreeShadow(o.x, o.y, o.s);
    else if (o.t === 'rock') {
      ctx.fillStyle = 'rgba(60,90,130,0.16)';
      ctx.beginPath(); ctx.ellipse(o.x + 6, o.y + 3, 15 * o.s, 6 * o.s, 0, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.save(); ctx.translate(o.x + 4, o.y + 4); ctx.rotate(o.ang);
      ctx.fillStyle = 'rgba(60,90,130,0.16)';
      ctx.beginPath(); ctx.ellipse(0, 0, o.half + 6, 6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  function drawObstacle(o) {
    if (o.t === 'tree') { drawTree(o.x, o.y, o.s); return; }
    if (o.t === 'rock') {
      const r = 14 * o.s;
      ctx.fillStyle = '#7d8996';
      ctx.beginPath();
      o.pts.forEach((f, i) => {
        const a = (i / o.pts.length) * Math.PI * 2 - Math.PI / 2;
        const px = o.x + Math.cos(a) * r * f, py = o.y - 5 * o.s + Math.sin(a) * r * f * 0.75;
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      });
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#a3aebb';
      ctx.beginPath(); ctx.ellipse(o.x - 2.5 * o.s, o.y - 9 * o.s, 7.5 * o.s, 4.2 * o.s, -0.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.ellipse(o.x - 1 * o.s, o.y - 13 * o.s, 6.5 * o.s, 2.6 * o.s, -0.15, 0, Math.PI * 2); ctx.fill();
      return;
    }
    ctx.save();
    ctx.translate(o.x, o.y - 4); ctx.rotate(o.ang);
    ctx.fillStyle = '#8b5a3c';
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-o.half, -6, o.half * 2, 12, 6) : ctx.rect(-o.half, -6, o.half * 2, 12); ctx.fill();
    ctx.fillStyle = '#a8714b'; ctx.fillRect(-o.half + 5, -3.5, o.half * 2 - 10, 2.5);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(-o.half + 6, -6.5, o.half * 2 - 12, 2.2);
    for (const e of [-1, 1]) {
      ctx.fillStyle = '#d8a676';
      ctx.beginPath(); ctx.ellipse(e * o.half, 0, 3.5, 6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#b88352';
      ctx.beginPath(); ctx.ellipse(e * o.half, 0, 1.6, 3, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawTrail() {
    ctx.strokeStyle = 'rgba(105,135,172,0.30)';
    ctx.lineWidth = 1.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      let pen = false;
      for (const p of trail) {
        if (!p) { pen = false; continue; }
        const ox = Math.cos(p.p) * 3 * side, oy = -Math.sin(p.p) * 3 * side;
        if (pen) ctx.lineTo(p.x + ox, p.y + oy); else { ctx.moveTo(p.x + ox, p.y + oy); pen = true; }
      }
      ctx.stroke();
    }
  }

  function drawRider(x, y, phi, theta, h, spinAng, tumble, isGhost) {
    const lift = h * 22;
    // ground shadow
    ctx.fillStyle = isGhost ? 'rgba(63,127,214,0.10)' : 'rgba(40,60,90,' + (0.22 - h * 0.1) + ')';
    ctx.beginPath(); ctx.ellipse(x + 4 + h * 8, y + 3, 18 - h * 4, 7 - h * 1.5, 0, 0, Math.PI * 2); ctx.fill();

    ctx.save();
    if (isGhost) ctx.globalAlpha = 0.38;
    ctx.translate(x, y - lift);
    const sc = (1 + h * 0.22) * 1.45;
    ctx.scale(sc, sc);
    ctx.rotate(Math.PI / 2 - phi + spinAng + tumble);
    // board
    ctx.fillStyle = isGhost ? '#3f7fd6' : '#17253b';
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-14, -4, 28, 8, 4) : ctx.rect(-14, -4, 28, 8); ctx.fill();
    ctx.fillStyle = isGhost ? '#7fb0ea' : '#3fa9d6';
    ctx.fillRect(-10, -1.2, 20, 2.4);
    // body: lean into the carve
    const lean = clamp((theta - phi) * 4, -2.5, 2.5);
    ctx.translate(0, lean);
    ctx.fillStyle = isGhost ? '#5d93df' : '#ff5a4e';
    ctx.beginPath(); ctx.ellipse(0, 0, 8, 5.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = isGhost ? '#4c84d4' : '#e2453a';
    ctx.beginPath(); ctx.arc(-8, 1.5, 2.4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(8, 1.5, 2.4, 0, Math.PI * 2); ctx.fill();
    // head and beanie
    ctx.fillStyle = isGhost ? '#cfe0f5' : '#f1c7a3';
    ctx.beginPath(); ctx.arc(0, 0, 3.9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = isGhost ? '#2f5f9f' : '#17253b';
    ctx.beginPath(); ctx.arc(0, -0.6, 3.6, Math.PI * 0.05, Math.PI * 1.95, true); ctx.fill();
    ctx.fillStyle = isGhost ? '#ffffff' : '#ffd166';
    ctx.beginPath(); ctx.arc(0, -3.4, 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    if (isGhost) {
      ctx.globalAlpha = 0.6;
      ctx.font = '700 10px ui-rounded, system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.fillStyle = '#3f7fd6';
      ctx.fillText('your best', x, y - lift - 22);
      ctx.globalAlpha = 1;
    }
  }

  function drawFlakes(dt, speed) {
    const scrollPx = (game.state === 'play' || game.state === 'menu' ? speed : 0) * view.scale * dt;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const f of flakes) {
      f.p += dt * f.s;
      f.y += (18 * f.s) * dt - scrollPx * 0.35 * f.s;
      f.x += Math.sin(f.p) * 8 * dt;
      if (f.y < -5) { f.y = view.cssH + 5; f.x = Math.random() * view.cssW; }
      if (f.y > view.cssH + 5) { f.y = -5; f.x = Math.random() * view.cssW; }
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawSpeedLines(s) {
    const a = clamp((s - 330) / 200, 0, 1) * 0.35;
    ctx.strokeStyle = 'rgba(150,175,205,' + a + ')';
    ctx.lineWidth = 1.2;
    const t = performance.now() / 1000;
    for (let i = 0; i < 10; i++) {
      const x = ((i * 97.3 + Math.sin(i) * 40) % view.cssW + view.cssW) % view.cssW;
      const y = ((t * 900 + i * 173) % (view.cssH + 200)) - 100;
      ctx.beginPath(); ctx.moveTo(x, view.cssH - y); ctx.lineTo(x, view.cssH - y - 60); ctx.stroke();
    }
  }

  // ---------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------
  let lastCombo = 0;
  function updateHud() {
    if (!rider || (game.state !== 'play' && game.state !== 'dead')) return;
    ui.score.textContent = fmt(score());
    ui.dist.textContent = fmt(Math.max(0, rider.y) / 10) + ' m';
    ui.speed.textContent = fmt(rider.s * SPEED_TO_KMH);
    if (run.combo !== lastCombo) {
      lastCombo = run.combo;
      ui.combo.hidden = run.combo < 2;
      ui.comboVal.textContent = 'Combo x' + run.combo;
    }
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------
  canvas.tabIndex = 0;
  canvas.addEventListener('pointerdown', (e) => {
    if (game.state === 'play') { e.preventDefault(); action(); }
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    const onButton = document.activeElement && document.activeElement.tagName === 'BUTTON';
    if (k === 'm' || k === 'M') { toggleMute(); return; }
    if (game.state === 'play') {
      if (k === ' ' || k === 'Enter' || k === 'ArrowUp' || k === 'w' || k === 'W') { e.preventDefault(); if (!e.repeat) action(); }
      else if (k === 'ArrowLeft' || k === 'a' || k === 'A') { e.preventDefault(); setDir(-1); }
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') { e.preventDefault(); setDir(1); }
      else if (k === 'Escape' || k === 'p' || k === 'P') { e.preventDefault(); setPaused(true); }
      return;
    }
    if (game.state === 'paused' && (k === 'Escape' || k === 'p' || k === 'P')) { e.preventDefault(); setPaused(false); return; }
    if (onButton) return; // let focused buttons handle Space/Enter themselves
    if (k === ' ' || k === 'Enter') {
      e.preventDefault();
      if (game.state === 'menu') startRun('daily');
      else if (game.state === 'results') startRun(game.mode);
    }
  });

  document.addEventListener('visibilitychange', () => { if (document.hidden) setPaused(true); });
  window.addEventListener('blur', () => setPaused(true));

  function toggleMute() {
    sfx.setMuted(!sfx.muted);
    syncMuteButtons();
  }
  function syncMuteButtons() {
    for (const id of ['muteBtnMenu', 'muteBtnPause']) {
      const b = $(id);
      b.textContent = 'Sound: ' + (sfx.muted ? 'off' : 'on');
      b.setAttribute('aria-pressed', String(sfx.muted));
    }
  }

  $('playDaily').addEventListener('click', () => startRun('daily'));
  $('playFree').addEventListener('click', () => startRun('free'));
  $('pauseBtn').addEventListener('click', () => setPaused(true));
  $('resumeBtn').addEventListener('click', () => setPaused(false));
  $('restartBtn').addEventListener('click', () => startRun(game.mode));
  $('quitBtn').addEventListener('click', showMenu);
  $('againBtn').addEventListener('click', () => startRun(game.mode));
  $('menuBtn').addEventListener('click', showMenu);
  $('muteBtnMenu').addEventListener('click', toggleMute);
  $('muteBtnPause').addEventListener('click', toggleMute);
  $('shareBtn').addEventListener('click', () => {
    const sc = fmt(score());
    const label = game.mode === 'daily' ? 'Downhill Daily #' + MOUNTAIN_NO : 'Downhill Daily free ride';
    const text = label + ' · ' + sc + ' pts, ' + fmt(rider.y / 10) + ' m, ' + run.gates + ' gates\nhttps://classroom-connect.co.uk/game/downhill-daily/';
    const done = () => toast('Result copied');
    const fail = () => toast('Copy not available here');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
    else fail();
  });

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.033, Math.max(0, (now - last) / 1000));
    last = now;
    update(dt);
    render(dt);
    updateHud();
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  resize();
  makeSpeckle();
  syncMuteButtons();
  showMenu();
  requestAnimationFrame(frame);

  // Test hooks (used by automated checks; harmless in production).
  window.__downhill = {
    get state() { return game.state; },
    get rider() { return rider; },
    get run() { return run; },
    get reason() { return game.reason; },
    get view() { return view; },
    course: () => game.course,
    start: startRun,
    act: action,
    dir: setDir,
    step: (dt) => update(dt),
  };
})();
