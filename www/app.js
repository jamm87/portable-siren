(() => {
"use strict";

/* ---------------- parameters and mappings ---------------- */
const el = id => document.getElementById(id);
const clamp = (v,a,b) => Math.min(b,Math.max(a,v));
const logMap= (t,a,b) => a*Math.pow(b/a,t);          // t 0..1 -> a..b logarithmic
const unlog = (v,a,b) => Math.log(v/a)/Math.log(b/a);

const P = {                       // normalized 0..1 values
  pitch:.42, rate:.33, depth:.48, spread:.09,
  // fback .75 leaves a ~5.8s echo tail once the pad is released (measured to
  // -60dB at the default 149ms delay); .62 died away in 2.8s, too short for dub.
  dtime:.42, fback:.75, tone:.52, send:.70, vol:.70,
  wave:"sine", shape:"sine"
};
const HZ    = () => logMap(P.pitch, 45, 1800);
const RATE  = () => logMap(P.rate, .15, 28);
const CENTS = () => P.depth * 4200;
const SPREAD= () => P.spread * 900;
const DTIME = () => logMap(P.dtime, .035, 1.1);
const FB    = () => P.fback * .92;
const TONE  = () => logMap(P.tone, 260, 9000);

/* ---------------- theme: A light ground / B dark ground ----------------
   The CSS follows prefers-color-scheme on its own; a stored choice pins
   data-theme on <html> and overrides it. The canvas draws the scope and plate
   itself, so it can't inherit any of this — it reads the same custom
   properties into SKIN and redraws from there. */
const THEME_KEY = "dubsiren-theme-v1";
let SKIN = {};
function readSkin(){
  const cs = getComputedStyle(document.documentElement);
  const g = n => cs.getPropertyValue(n).trim();
  SKIN = {
    bg: g("--bg"), fg: g("--fg"), field: g("--field"),
    grid: g("--grid"), gridSoft: g("--grid-soft"),
    trace: g("--trace"), traceIdle: g("--trace-idle"),
    traceRgb: g("--trace-rgb"), hotRgb: g("--hot-rgb")
  };
  const meta = el("themeColor");
  if (meta) meta.setAttribute("content", SKIN.bg);
}
const systemDark = () =>
  !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
let themeMode = null;   // null = follow the system
try {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") themeMode = saved;
} catch(e){}
function applyTheme(){
  if (themeMode) document.documentElement.dataset.theme = themeMode;
  else delete document.documentElement.dataset.theme;
  readSkin();
}
applyTheme();
if (window.matchMedia){
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const follow = () => { if (!themeMode) readSkin(); };
  if (mq.addEventListener) mq.addEventListener("change", follow); else mq.addListener(follow);
}

/* ---------------- audio engine ---------------- */
let ctx, master, comp, dry, osc1, osc2, mix, voice,
    lfo, lfoAmt, send, delay, fbGain, fbFilt, hp, sat, echoOut;
let ready = false, playing = false, latch = false, blast = false;

/* --- status shown in the panel --- */
function status(m){ const e = el("stat"); if (e) e.textContent = m; }
function statusAuto(){
  if (!ctx) { status("standby"); return; }
  status(ctx.state + " · " + Math.round(ctx.sampleRate/100)/10 + " kHz");
}
window.addEventListener("error", e => status("error: " + (e.message || "?")));

// Saturator curve for the echo feedback loop. Two properties matter, because
// this sits *inside* a feedback path:
//   1. Odd-symmetric, so input 0 maps to exactly 0. (Spanning i/(n-1) instead
//      of i/n is what guarantees it: with an even n the interpolated sample at
//      zero input lands between two mirrored values that cancel. The old
//      i*2/n-1 spacing left a -1.6e-3 DC offset that seeded the loop forever.)
//   2. Slope 1 at the origin, so small signals pass at unity instead of being
//      amplified — dividing by DRIVE normalizes it. Without this the loop gain
//      was 1.66 x feedback and the delay self-oscillated around 200 Hz on its
//      own, with nothing played.
const DRIVE = 1.8;
function shaperCurve(){
  const n = 1024, c = new Float32Array(n);
  for (let i=0;i<n;i++){ const x = (i/(n-1))*2 - 1; c[i] = Math.tanh(x*DRIVE)/DRIVE; }
  return c;
}

function build(){
  if (ready) return;
  // iOS: declare a playback session so audio isn't muted by the silent switch.
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch(e){}
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC){ status("no Web Audio"); return; }
  ctx = new AC();
  ctx.onstatechange = statusAuto;

  master = ctx.createGain();  master.gain.value = P.vol;
  comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -8; comp.knee.value = 6;
  comp.ratio.value = 14; comp.attack.value = .003; comp.release.value = .18;
  master.connect(comp).connect(ctx.destination);

  // voice
  voice = ctx.createGain(); voice.gain.value = 0;
  mix   = ctx.createGain(); mix.gain.value = .5;
  osc1 = ctx.createOscillator(); osc2 = ctx.createOscillator();
  osc1.type = osc2.type = P.wave;
  osc1.frequency.value = osc2.frequency.value = HZ();
  osc2.detune.value = SPREAD();
  osc1.connect(mix); osc2.connect(mix); mix.connect(voice);

  // LFO
  lfoAmt = ctx.createGain(); lfoAmt.gain.value = CENTS();
  lfo = ctx.createOscillator(); lfo.type = "sine"; lfo.frequency.value = RATE();
  lfoAmt.connect(osc1.detune); lfoAmt.connect(osc2.detune);

  // echo
  dry = ctx.createGain(); dry.gain.value = 1;
  send = ctx.createGain(); send.gain.value = P.send;
  delay = ctx.createDelay(1.5); delay.delayTime.value = DTIME();
  fbGain = ctx.createGain(); fbGain.gain.value = FB();
  fbFilt = ctx.createBiquadFilter(); fbFilt.type = "lowpass";
  fbFilt.frequency.value = TONE(); fbFilt.Q.value = .7;
  // Q pinned to Butterworth: the default Q=1 puts a resonant bump right above
  // the corner, which is extra loop gain exactly where the delay wants to ring.
  hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 170; hp.Q.value = .707;
  sat = ctx.createWaveShaper(); sat.curve = shaperCurve(); sat.oversample = "2x";
  echoOut = ctx.createGain(); echoOut.gain.value = .95;

  voice.connect(dry).connect(master);
  voice.connect(send).connect(delay);
  delay.connect(fbFilt).connect(hp).connect(sat).connect(fbGain).connect(delay);
  delay.connect(echoOut).connect(master);

  osc1.start(); osc2.start(); lfo.start();
  ready = true;
  setShape(P.shape);
  statusAuto();
}

function ensure(){
  build();
  if (ready && ctx.state !== "running") ctx.resume().then(statusAuto, statusAuto);
}

function on(){
  ensure();
  const t = ctx.currentTime;
  voice.gain.cancelScheduledValues(t);
  voice.gain.setTargetAtTime(.5, t, .006);
  playing = true;
}
function off(){
  // Mutes the dry voice only — the delay/feedback loop below is untouched,
  // so any echo already in flight keeps ringing out on its own instead of
  // being cut dead.
  if (!ready) return;
  const t = ctx.currentTime;
  voice.gain.cancelScheduledValues(t);
  voice.gain.setTargetAtTime(0, t, .015);
  playing = false;
}

/* --- leaving the app: kill everything, echo tail included --- */
// Unlike off(), this also shuts the delay path so nothing keeps ringing in the
// background. asleep stays true until wake() has drained the delay line, and
// apply() leaves the echo gains alone while it's set.
let asleep = false;

function hardStop(){
  latch = false;
  latchBtn.setAttribute("aria-pressed", "false");
  blast = false;
  playing = false;
  if (!ready) return;
  const t = ctx.currentTime;
  [voice.gain, fbGain.gain, echoOut.gain].forEach(g => {
    g.cancelScheduledValues(t);
    g.value = 0;   // set outright, not scheduled: suspend() below can land first
  });
  asleep = true;
  if (ctx.state === "running") ctx.suspend().then(statusAuto, statusAuto);
}

function wake(){
  if (!ready || !asleep) return;
  const restore = () => {
    asleep = false;
    // Hold the echo silent for one delay period first: with feedback at 0 that
    // empties whatever was still sitting in the delay line, so the tail from
    // before can't reappear when coming back.
    const t = ctx.currentTime, drain = DTIME() + .05;
    echoOut.gain.setValueAtTime(0, t);
    echoOut.gain.setValueAtTime(.95, t + drain);
    fbGain.gain.setValueAtTime(0, t);
    fbGain.gain.setValueAtTime(FB(), t + drain);
    statusAuto();
  };
  if (ctx.state !== "running") ctx.resume().then(restore, statusAuto);
  else restore();
}

function apply(){
  if (!ready) return;
  const t = ctx.currentTime;
  osc1.frequency.setTargetAtTime(HZ(), t, .012);
  osc2.frequency.setTargetAtTime(HZ(), t, .012);
  osc2.detune.setTargetAtTime(SPREAD(), t, .02);
  lfo.frequency.setTargetAtTime(RATE(), t, .02);
  lfoAmt.gain.setTargetAtTime(CENTS(), t, .02);
  delay.delayTime.setTargetAtTime(DTIME(), t, .09);   // tape-style glide
  fbFilt.frequency.setTargetAtTime(TONE(), t, .03);
  send.gain.setTargetAtTime(P.send, t, .03);
  master.gain.setTargetAtTime(P.vol, t, .03);
  if (!asleep) fbGain.gain.setTargetAtTime(blast ? .99 : FB(), t, .03);
}

function setWave(w){
  P.wave = w;
  if (ready){ osc1.type = w; osc2.type = w; }
}
function setShape(s){
  P.shape = s;
  if (!ready) return;
  try{ lfo.disconnect(lfoAmt); }catch(e){}
  lfo.type = s; lfo.connect(lfoAmt);
}

/* ---------------- sliders ---------------- */
const fmt = {
  pitch: () => Math.round(HZ()) + " Hz",
  rate:  () => RATE().toFixed(RATE() < 10 ? 2 : 1) + " Hz",
  depth: () => Math.round(P.depth*100) + " %",
  spread:() => Math.round(SPREAD()) + " ct",
  dtime: () => Math.round(DTIME()*1000) + " ms",
  fback: () => Math.round(P.fback*100) + " %",
  tone:  () => (TONE() >= 1000 ? (TONE()/1000).toFixed(1)+" k" : Math.round(TONE())+" Hz"),
  send:  () => Math.round(P.send*100) + " %",
  vol:   () => Math.round(P.vol*100) + " %"
};
// The console bar fills from the left, which a native range can't express:
// the track paints a hard-stop gradient at this percentage instead.
const setFill = s => s.style.setProperty("--fill", (s.value/10) + "%");
const keys = Object.keys(fmt);
keys.forEach(k => {
  const s = el(k), o = el(k+"V");
  s.value = P[k]*1000;
  const upd = () => { P[k] = s.value/1000; o.textContent = fmt[k](); setFill(s); apply(); };
  s.addEventListener("input", upd);   // keyboard: Tab to it, then arrows
  o.textContent = fmt[k]();
  setFill(s);

  // iOS only drags a range input by its thumb — a touch on the track does
  // nothing at all — and the pointer we draw is a 22x11 triangle, made smaller
  // still as a target because clip-path clips hit-testing too. So the value is
  // driven from the pointer's x instead: a tap anywhere on the row jumps there,
  // and a sideways drag from anywhere slides it. Full-width mapping, so the
  // pointer also stops drifting from the fill at the two ends, which the
  // native half-a-thumb inset caused.
  const setFromX = e => {
    const r = s.getBoundingClientRect();
    s.value = Math.round(clamp((e.clientX - r.left) / r.width, 0, 1) * 1000);
    upd();
  };
  // One gesture, one outcome. "pending" until the direction is known, then
  // either "slide" (ours) or "given-up" (the pane is scrolling). A cancelled
  // pointer goes straight to idle WITHOUT the tap branch: letting it fall back
  // to "pending" made the pointerup that follows a scroll read as a tap and
  // nudge the value.
  // Chromium moves the thumb on touchstart and keeps dragging it on touchmove,
  // with a mapping inset by half a thumb, so left alone it overrides this and
  // lands ~11px off. It can't be cancelled at touchstart without killing the
  // pane's scrolling, so instead: remember the value, cancel touchmove only
  // once the gesture is known to be sideways, and put the value back if the
  // pane ends up taking the gesture.
  let x0 = 0, y0 = 0, mode = "idle", v0 = 0;
  s.addEventListener("pointerdown", e => {
    x0 = e.clientX; y0 = e.clientY; mode = "pending"; v0 = Number(s.value);
    e.preventDefault();   // for a mouse this is enough to stop the native drag
    s.focus({ preventScroll: true });
  });
  s.addEventListener("touchmove", e => {
    if (mode === "slide") e.preventDefault();
  }, { passive: false });
  s.addEventListener("pointermove", e => {
    if (mode === "pending"){
      const dx = Math.abs(e.clientX - x0), dy = Math.abs(e.clientY - y0);
      if (dx < 4 && dy < 4) return;
      if (dy > dx){ mode = "given-up"; return; }   // the pane takes it
      mode = "slide";
      try { s.setPointerCapture(e.pointerId); } catch(err){}
    }
    if (mode !== "slide") return;
    e.preventDefault();
    setFromX(e);
  });
  s.addEventListener("pointerup", e => {
    if (mode === "pending") setFromX(e);   // a tap that never became a drag
    mode = "idle";
    try { s.releasePointerCapture(e.pointerId); } catch(err){}
  });
  s.addEventListener("pointercancel", () => {
    // the pane is scrolling: undo the jump the native handler made on touchstart
    if (mode !== "slide" && Number(s.value) !== v0){ s.value = v0; upd(); }
    mode = "idle";
  });
});
function refresh(){
  keys.forEach(k => {
    const s = el(k);
    s.value = P[k]*1000; el(k+"V").textContent = fmt[k](); setFill(s);
  });
  apply();
}

/* ---------------- chips ---------------- */
function chipGroup(id, fn){
  const box = el(id);
  box.addEventListener("click", e => {
    const b = e.target.closest(".chip"); if (!b) return;
    [...box.children].forEach(c => c.setAttribute("aria-pressed", c === b));
    fn(b.dataset.v);
  });
}
chipGroup("wave", setWave);
chipGroup("shape", setShape);
function syncChips(){
  [...el("wave").children].forEach(c => c.setAttribute("aria-pressed", c.dataset.v === P.wave));
  [...el("shape").children].forEach(c => c.setAttribute("aria-pressed", c.dataset.v === P.shape));
}

/* ---------------- buttons ---------------- */
const latchBtn = el("latch");

// Is a finger physically down on something that's sounding right now?
const holding = () => touchId !== null || presetPointer !== null;

function toggleLatch(){
  latch = !latch;
  latchBtn.setAttribute("aria-pressed", latch);
  // Latching mid-hold is the whole point: you find a sound on the plate and
  // pin it without lifting. Unlatching mid-hold must leave it running too —
  // the finger is still down, so off() here would mute under it.
  if (latch) on();
  else if (!holding()) off();
}

// pointerdown, not click: with the plate already holding a captured pointer,
// iOS doesn't synthesise a click for a second finger landing here, so
// "hold the plate, tap Latch" silently did nothing. Feedback and the presets
// are on pointer events for the same reason.
latchBtn.addEventListener("pointerdown", e => { e.preventDefault(); toggleLatch(); });
// Keyboard activation (Enter/Space) arrives as a click with no pointer behind
// it — detail 0 — which is also how a pointer-driven click gets filtered out.
latchBtn.addEventListener("click", e => { if (e.detail === 0) toggleLatch(); });

const blastBtn = el("blast");
const blastOn  = e => { e.preventDefault(); blast = true; ensure(); apply(); };
const blastOff = e => { e.preventDefault(); blast = false; apply(); };
blastBtn.addEventListener("pointerdown", blastOn);
blastBtn.addEventListener("pointerup", blastOff);
blastBtn.addEventListener("pointercancel", blastOff);
blastBtn.addEventListener("pointerleave", blastOff);

const stopBtn = el("stop");
stopBtn.addEventListener("click", () => {
  latch = false;
  latchBtn.setAttribute("aria-pressed","false");
  off();
});

/* ---------------- tap tempo (sets RATE) ---------------- */
const tapBtn = el("tap");
const TAP_LABEL = "Tap";
let tapTimes = [];
let tapResetTimer = null;
function registerTap(){
  const now = performance.now();
  if (tapTimes.length && now - tapTimes[tapTimes.length-1] > 2000) tapTimes = []; // idle too long: restart
  tapTimes.push(now);
  if (tapTimes.length > 5) tapTimes.shift();      // average the last few taps

  clearTimeout(tapResetTimer);
  tapResetTimer = setTimeout(() => { tapTimes = []; tapBtn.textContent = TAP_LABEL; }, 2000);

  if (tapTimes.length < 2) return;                // need at least one interval
  const intervals = [];
  for (let i=1;i<tapTimes.length;i++) intervals.push(tapTimes[i]-tapTimes[i-1]);
  const avgMs = intervals.reduce((a,b) => a+b, 0) / intervals.length;
  const hz = clamp(1000/avgMs, .15, 28);
  P.rate = clamp(unlog(hz, .15, 28), 0, 1);
  refresh();
  tapBtn.textContent = Math.round(hz*60) + " BPM";
}

// pointerdown, not click: same reason as Latch above — a second finger landing
// here while the plate already holds a captured pointer never gets a
// synthesised click. It also times each tap from when the finger lands rather
// than when it lifts, which is the beat you're actually tapping to.
tapBtn.addEventListener("pointerdown", e => { e.preventDefault(); registerTap(); });
tapBtn.addEventListener("click", e => { if (e.detail === 0) registerTap(); });

/* ---------------- presets ---------------- */
// pitch/rate/depth below are solved (not guessed) from real target
// frequencies and cycle times using this file's own HZ()/RATE()/CENTS()
// mappings, so each preset actually lands on the numbers in the comment.
const PRESETS = {
  // Wails smoothly between 150 Hz and 450 Hz over a slow ~6s cycle, buzzy
  // sawtooth motor timbre — the classic air-raid siren.
  airraid:{pitch:.48,rate:.02,depth:.23,spread:.05,dtime:.40,fback:.50,tone:.40,send:.55,wave:"sawtooth",shape:"triangle"},
  // Clean sine tone snapping between 520 Hz and 720 Hz roughly twice a
  // second — the European two-tone "nee-naw" siren, kept dry to stay crisp.
  police: {pitch:.71,rate:.35,depth:.07,spread:.02,dtime:.25,fback:.35,tone:.65,send:.35,wave:"sine",shape:"square"},
  // Fast ramps from 500 Hz up to 1400 Hz that snap back down about 4-5
  // times a second — sci-fi blaster zaps — with a short, bright, cascading
  // echo for the repeated "pew-pew".
  laser:  {pitch:.79,rate:.65,depth:.21,spread:.15,dtime:.15,fback:.65,tone:.80,send:.75,wave:"square",shape:"sawtooth"},
  // Slow sine wobble between 300 Hz and 480 Hz (~2.6s cycle) with wide
  // oscillator detune for an unstable, beating shimmer — a hovering,
  // otherworldly hum.
  ufo:    {pitch:.58,rate:.18,depth:.10,spread:.25,dtime:.55,fback:.60,tone:.50,send:.70,wave:"triangle",shape:"sine"},
  // Big air/ship horn: a sustained 164 Hz sawtooth blast rather than a sweep
  // (the waver spans well under a semitone), with the two oscillators detuned
  // 36 cents so they beat against each other at ~3.4 Hz — the growl of a
  // twin-reed horn — under a dark 297 ms harbour echo.
  horn:   {pitch:.35,rate:.34,depth:.01,spread:.04,dtime:.62,fback:.72,tone:.41,send:.55,wave:"sawtooth",shape:"sine"},
  // Pure classic dub siren: plain sine tone, sine sweep, zero detune (no
  // chorus/beating — just the one clean pitch). Warbles smoothly between
  // ~300 Hz and ~600 Hz about once a second, thrown into a long, heavy-
  // feedback dub echo — the King Tubby-style "siren pon the riddim".
  dub: {pitch:.61,rate:.39,depth:.29,spread:0,dtime:.69,fback:.87,tone:.56,send:.62,wave:"sine",shape:"sine"}
};
// Press and hold a preset to load it and sound it for as long as it's held —
// same gesture as the plate, so presets can be played rather than just picked.
// Latch still wins: with it on, letting go leaves the siren running.
const presetsBox = el("presets");
let presetPointer = null;

presetsBox.addEventListener("pointerdown", e => {
  const b = e.target.closest(".preset"); if (!b) return;
  const p = PRESETS[b.dataset.p]; if (!p) return;
  e.preventDefault();
  presetPointer = e.pointerId;
  try { b.setPointerCapture(e.pointerId); } catch(err){}
  b.classList.add("held");   // preventDefault above suppresses :active on touch
  Object.assign(P, p);
  build(); setWave(P.wave); setShape(P.shape); syncChips(); refresh();
  on();
});

const presetRelease = e => {
  if (e.pointerId !== presetPointer) return;
  presetPointer = null;
  [...presetsBox.children].forEach(c => c.classList.remove("held"));
  if (!latch) off();
};
presetsBox.addEventListener("pointerup", presetRelease);
presetsBox.addEventListener("pointercancel", presetRelease);

/* ---------------- mem: 3 user-savable slots (hold to save, tap to load) ---------------- */
const MEM_KEY = "dubsiren-mem-v1", MEM_HOLD_MS = 600;
let memSlots;
try { memSlots = JSON.parse(localStorage.getItem(MEM_KEY)); } catch(e){ memSlots = null; }
if (!Array.isArray(memSlots) || memSlots.length !== 3) memSlots = [null,null,null];

const memBtns = [...el("mem").children];
function renderMem(){
  memBtns.forEach((b,i) => {
    const filled = !!memSlots[i];
    b.classList.toggle("filled", filled);
    b.textContent = filled ? "MEM " + (i+1) : "— " + (i+1) + " —";
  });
}
renderMem();

memBtns.forEach((b,i) => {
  let holdTimer = null, saved = false;
  b.addEventListener("pointerdown", e => {
    e.preventDefault();
    saved = false;
    holdTimer = setTimeout(() => {
      saved = true;
      memSlots[i] = { ...P };
      try { localStorage.setItem(MEM_KEY, JSON.stringify(memSlots)); } catch(e){}
      renderMem();
      b.classList.add("saved");
      setTimeout(() => b.classList.remove("saved"), 250);
    }, MEM_HOLD_MS);
  });
  const cancel = () => clearTimeout(holdTimer);
  b.addEventListener("pointerup", e => {
    clearTimeout(holdTimer);
    if (saved) return;
    const slot = memSlots[i]; if (!slot) return;
    Object.assign(P, slot);
    build(); setWave(P.wave); setShape(P.shape); syncChips(); refresh();
  });
  b.addEventListener("pointercancel", cancel);
  b.addEventListener("pointerleave", cancel);
});

/* ---------------- touch plate ---------------- */
const plate = el("plate"), pctx = plate.getContext("2d");
const scope = el("scope"), sctx = scope.getContext("2d");
let plateW = 0, plateH = 0, scopeW = 0, scopeH = 0;

function fit(cv, c){
  const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  cv.width = Math.round(r.width*d); cv.height = Math.round(r.height*d);
  c.setTransform(d,0,0,d,0,0);
  return [r.width, r.height];
}
function resize(){
  [plateW, plateH] = fit(plate, pctx);
  [scopeW, scopeH] = fit(scope, sctx);
}
window.addEventListener("resize", resize);
window.addEventListener("orientationchange", () => setTimeout(resize, 250));

let touchId = null;
function fromEvent(e){
  const r = plate.getBoundingClientRect();
  P.pitch = clamp((e.clientX - r.left)/r.width, 0, 1);
  P.rate  = clamp(1 - (e.clientY - r.top)/r.height, 0, 1);
  refresh();
}
plate.addEventListener("pointerdown", e => {
  e.preventDefault();
  touchId = e.pointerId; plate.setPointerCapture(e.pointerId);
  fromEvent(e); on();
});
plate.addEventListener("pointermove", e => {
  if (e.pointerId !== touchId) return;
  e.preventDefault(); fromEvent(e);
});
const release = e => {
  if (e.pointerId !== touchId) return;
  touchId = null;
  if (!latch) off();
};
plate.addEventListener("pointerup", release);
plate.addEventListener("pointercancel", release);

/* ---------------- drawing ---------------- */
const led = el("led");
const shapeFn = {
  sine:   p => Math.sin(2*Math.PI*p),
  triangle:p => 2*Math.abs(2*(p%1)-1)-1,
  sawtooth:p => 2*(p%1)-1,
  square: p => ((p%1) < .5 ? 1 : -1)
};
const trace = new Array(180).fill(0);
// matches --mono in style.css, for the canvas overlay label
const MONO = 'ui-monospace,"SF Mono",Menlo,"Courier New",monospace';

function draw(now){
  requestAnimationFrame(draw);
  const t = now/1000;
  const r = RATE();
  const phase = (t*r) % 1;
  const v = (shapeFn[P.shape] || shapeFn.sine)(phase);
  const cents = v * CENTS();
  const f = HZ() * Math.pow(2, cents/1200);

  led.classList.toggle("on", playing && phase < .5);

  /* --- scope: live pitch trace, flat when silent --- */
  sctx.clearRect(0,0,scopeW,scopeH);
  sctx.fillStyle = SKIN.field; sctx.fillRect(0,0,scopeW,scopeH);
  sctx.strokeStyle = SKIN.gridSoft; sctx.lineWidth = 1;
  for (let i=1;i<4;i++){
    const y = scopeH*i/4; sctx.beginPath();
    sctx.moveTo(0,y+.5); sctx.lineTo(scopeW,y+.5); sctx.stroke();
  }
  if (playing){
    trace.push(f); if (trace.length > 180) trace.shift();
    sctx.beginPath();
    for (let i=0;i<trace.length;i++){
      const x = i/(trace.length-1)*scopeW;
      const y = scopeH - clamp(unlog(clamp(trace[i],40,9000),40,9000),0,1)*(scopeH-8) - 4;
      i ? sctx.lineTo(x,y) : sctx.moveTo(x,y);
    }
    sctx.strokeStyle = SKIN.trace; sctx.lineWidth = 1.6; sctx.lineJoin = "round";
    sctx.shadowColor = "rgba(" + SKIN.traceRgb + ",.85)"; sctx.shadowBlur = 7;
    sctx.stroke(); sctx.shadowBlur = 0;
  } else {
    trace.fill(f);   // keep the buffer primed so the trace doesn't jump when sound resumes
    sctx.strokeStyle = SKIN.traceIdle; sctx.lineWidth = 1.6;
    sctx.beginPath(); sctx.moveTo(0,scopeH/2+.5); sctx.lineTo(scopeW,scopeH/2+.5); sctx.stroke();
  }

  /* --- Feedback held: soft red pulse over the scope, with a corner label --- */
  if (blast){
    const pulse = .18 + .17*(.5 + .5*Math.sin(t*2*Math.PI*2.2));   // ~2.2 Hz, stays gentle
    sctx.fillStyle = "rgba(" + SKIN.hotRgb + "," + pulse.toFixed(3) + ")";
    sctx.fillRect(0,0,scopeW,scopeH);
    sctx.strokeStyle = "rgba(" + SKIN.hotRgb + "," + (pulse + .55).toFixed(3) + ")";
    sctx.lineWidth = 1;
    sctx.strokeRect(.5,.5,scopeW-1,scopeH-1);
    sctx.font = "600 8px " + MONO;
    sctx.textAlign = "right"; sctx.textBaseline = "top";
    sctx.fillStyle = "rgba(255,214,208," + (.55 + pulse).toFixed(3) + ")";
    sctx.fillText("FEEDBACK ON", scopeW - 5, 4);
    sctx.textAlign = "left";   // leave the context as the rest of draw() expects
  }

  /* --- plate --- */
  pctx.clearRect(0,0,plateW,plateH);
  pctx.fillStyle = SKIN.field; pctx.fillRect(0,0,plateW,plateH);
  pctx.strokeStyle = SKIN.grid; pctx.lineWidth = 1;
  for (let i=1;i<8;i++){
    const x = plateW*i/8; pctx.beginPath();
    pctx.moveTo(x+.5,0); pctx.lineTo(x+.5,plateH); pctx.stroke();
  }
  for (let i=1;i<5;i++){
    const y = plateH*i/5; pctx.beginPath();
    pctx.moveTo(0,y+.5); pctx.lineTo(plateW,y+.5); pctx.stroke();
  }

  const cx = P.pitch*plateW, cy = (1-P.rate)*plateH;
  const glow = playing ? (.55 + .45*Math.abs(v)) : .25;

  if (playing){
    const g = pctx.createRadialGradient(cx,cy,0,cx,cy,88*glow);
    g.addColorStop(0,"rgba(" + SKIN.traceRgb + ",.42)");
    g.addColorStop(1,"rgba(" + SKIN.traceRgb + ",0)");
    pctx.fillStyle = g; pctx.fillRect(0,0,plateW,plateH);
  }
  pctx.strokeStyle = playing ? "rgba(" + SKIN.traceRgb + ",.55)" : SKIN.traceIdle;
  pctx.lineWidth = 1;
  pctx.beginPath();
  pctx.moveTo(0,cy+.5); pctx.lineTo(plateW,cy+.5);
  pctx.moveTo(cx+.5,0); pctx.lineTo(cx+.5,plateH); pctx.stroke();

  pctx.beginPath(); pctx.arc(cx,cy,playing ? 9+6*Math.abs(v) : 8,0,7);
  pctx.fillStyle = playing ? SKIN.trace : SKIN.traceIdle; pctx.fill();
}
resize();
requestAnimationFrame(draw);

/* ---------------- layout modes ---------------- */
// Runs after the canvases exist, since switching layout resizes them.
const LAY_KEY = "dubsiren-layout-v1";
const layBtns = [...el("layouts").children];
const tabBtns = [...el("tabs").children];
const panes = [...document.querySelectorAll(".pane")];

function setLayout(n){
  document.body.dataset.layout = n;
  layBtns.forEach(b => b.setAttribute("aria-pressed", b.dataset.layout === n));
  try { localStorage.setItem(LAY_KEY, n); } catch(e){}
  resize();   // the plate and scope changed size, re-fit the canvases
}
function setTab(name){
  panes.forEach(p => p.classList.toggle("active", p.dataset.pane === name));
  tabBtns.forEach(b => b.setAttribute("aria-pressed", b.dataset.tab === name));
}
el("layouts").addEventListener("click", e => {
  const b = e.target.closest(".lay-btn"); if (b) setLayout(b.dataset.layout);
});
el("tabs").addEventListener("click", e => {
  const b = e.target.closest(".tab"); if (b) setTab(b.dataset.tab);
});

let savedLayout = "1";
try { savedLayout = localStorage.getItem(LAY_KEY) || "1"; } catch(e){}
if (!["1","2","3"].includes(savedLayout)) savedLayout = "1";
setTab("siren");
setLayout(savedLayout);

/* ---------------- power-on and test tone ---------------- */
el("powerBtn").addEventListener("click", () => {
  ensure();
  el("power").classList.add("hide");
  resize();
});

el("test").addEventListener("click", () => {
  ensure();
  if (!ready) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = "sine"; o.frequency.value = 440; g.gain.value = 0;
  o.connect(g).connect(ctx.destination);
  o.start(t);
  g.gain.setTargetAtTime(.28, t, .01);
  g.gain.setTargetAtTime(0, t + .45, .05);
  o.stop(t + 1.2);
});

/* ---------------- theme toggle ---------------- */
// Resolve what's actually on screen before flipping, so the first press from
// "follow the system" goes to the opposite of what you're looking at.
el("themeBtn").addEventListener("click", () => {
  const dark = themeMode ? themeMode === "dark" : systemDark();
  themeMode = dark ? "light" : "dark";
  applyTheme();
  try { localStorage.setItem(THEME_KEY, themeMode); } catch(e){}
});

/* ---------------- feedback popover ---------------- */
const feedbackBtn = el("feedbackBtn"), feedbackMenu = el("feedbackMenu");
function closeFeedback(){
  feedbackMenu.hidden = true;
  feedbackBtn.setAttribute("aria-expanded", "false");
}
feedbackBtn.addEventListener("click", e => {
  e.stopPropagation();
  const opening = feedbackMenu.hidden;
  feedbackMenu.hidden = !opening;
  feedbackBtn.setAttribute("aria-expanded", String(opening));
});
feedbackMenu.addEventListener("click", e => { if (e.target.closest("a")) closeFeedback(); });
document.addEventListener("click", e => { if (!e.target.closest(".fb-wrap")) closeFeedback(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeFeedback(); });

/* ---------------- leaving / returning to the app ---------------- */
// Applies everywhere — native app, installed PWA and plain browser tab alike.
// Switching apps, locking the screen or closing the tab silences the siren and
// the echo tail with it.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) hardStop(); else wake();
});
window.addEventListener("pagehide", hardStop);

document.addEventListener("gesturestart", e => e.preventDefault());

/* ---------------- native app integration (Capacitor: iOS + Android) ---------------- */
if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()){
  const CapApp = window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (CapApp && CapApp.addListener){
    // More reliable than visibilitychange on iOS (incoming call, Control Centre, home).
    CapApp.addListener("appStateChange", ({ isActive }) => { isActive ? wake() : hardStop(); });

    if (window.Capacitor.getPlatform && window.Capacitor.getPlatform() === "android"){
      // Android's hardware/gesture back button: there's no in-app navigation, so exit.
      CapApp.addListener("backButton", () => { hardStop(); CapApp.exitApp(); });
    }
  }
}

/* ---------------- PWA: register the service worker for offline use ---------------- */
if ("serviceWorker" in navigator && !(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())){
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
})();
