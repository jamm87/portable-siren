(() => {
"use strict";

/* ---------------- parameters and mappings ---------------- */
const el = id => document.getElementById(id);
const clamp = (v,a,b) => Math.min(b,Math.max(a,v));
const logMap= (t,a,b) => a*Math.pow(b/a,t);          // t 0..1 -> a..b logarithmic
const unlog = (v,a,b) => Math.log(v/a)/Math.log(b/a);

const P = {                       // normalized 0..1 values
  pitch:.42, rate:.33, depth:.48, spread:.09,
  dtime:.42, fback:.62, tone:.52, send:.70, vol:.70,
  wave:"sine", shape:"sine"
};
const toHz  = n => logMap(n, 45, 1800);
const toRate= n => logMap(n, .15, 28);
const CENTS = () => P.depth * 4200;
const SPREAD= () => P.spread * 900;
const DTIME = () => logMap(P.dtime, .035, 1.1);
const FB    = () => P.fback * .92;
const TONE  = () => logMap(P.tone, 260, 9000);

const MAXV = 6;                   // simultaneous voices
const LEVEL = .34;                // level per voice

/* ---------------- shared audio ---------------- */
let ctx, master, comp, dry, sendG, delay, fbGain, fbFilt, hp, sat, echoOut;
let ready = false, latch = false, blast = false;
const voices = [];
let primary = null, vid = 0;

/* --- status shown in the panel --- */
function status(m){ const e = el("stat"); if (e) e.textContent = m; }
function statusAuto(){
  if (!ctx) { status("standby"); return; }
  status(ctx.state + " · " + Math.round(ctx.sampleRate/100)/10 + " kHz");
}
window.addEventListener("error", e => status("error: " + (e.message || "?")));

/* --- iOS: force a playback session to bypass silent mode --- */
let keepAlive = null;
function silentWavURL(){
  const sr = 8000, n = sr*2, b = new ArrayBuffer(44 + n*2), v = new DataView(b);
  const w = (o,s) => { for (let i=0;i<s.length;i++) v.setUint8(o+i, s.charCodeAt(i)); };
  w(0,"RIFF"); v.setUint32(4, 36+n*2, true); w(8,"WAVE"); w(12,"fmt ");
  v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
  v.setUint32(24,sr,true); v.setUint32(28,sr*2,true); v.setUint16(32,2,true);
  v.setUint16(34,16,true); w(36,"data"); v.setUint32(40, n*2, true);
  for (let i=0;i<n;i++) v.setInt16(44+i*2, i%2 ? 1 : -1, true);  // ~-90 dBFS: inaudible
  return URL.createObjectURL(new Blob([b], {type:"audio/wav"}));
}
function playbackSession(){
  try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch(e){}
  try {
    if (!keepAlive){
      keepAlive = new Audio(silentWavURL());
      keepAlive.loop = true; keepAlive.playsInline = true;
      keepAlive.setAttribute("playsinline","");
    }
    const p = keepAlive.play();
    if (p && p.catch) p.catch(err => status("iOS silent mode: " + (err.name || err)));
  } catch(e){ status("session: " + e.message); }
}

function shaperCurve(){
  const n = 1024, c = new Float32Array(n);
  for (let i=0;i<n;i++){ const x = i*2/n - 1; c[i] = Math.tanh(x*1.8)*.92; }
  return c;
}

function build(){
  if (ready) return;
  playbackSession();
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC){ status("no Web Audio"); return; }
  ctx = new AC();
  ctx.onstatechange = statusAuto;

  master = ctx.createGain(); master.gain.value = P.vol;
  comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -8; comp.knee.value = 6;
  comp.ratio.value = 14; comp.attack.value = .003; comp.release.value = .18;
  master.connect(comp).connect(ctx.destination);

  // buses: dry and echo send, shared by all voices
  dry = ctx.createGain(); dry.gain.value = 1;
  sendG = ctx.createGain(); sendG.gain.value = P.send;

  delay = ctx.createDelay(1.5); delay.delayTime.value = DTIME();
  fbGain = ctx.createGain(); fbGain.gain.value = FB();
  fbFilt = ctx.createBiquadFilter(); fbFilt.type = "lowpass";
  fbFilt.frequency.value = TONE(); fbFilt.Q.value = .7;
  hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 170;
  sat = ctx.createWaveShaper(); sat.curve = shaperCurve(); sat.oversample = "2x";
  echoOut = ctx.createGain(); echoOut.gain.value = .95;

  dry.connect(master);
  sendG.connect(delay);
  delay.connect(fbFilt).connect(hp).connect(sat).connect(fbGain).connect(delay);
  delay.connect(echoOut).connect(master);

  ready = true;
  statusAuto();
}

function ensure(){
  build();
  if (ready && ctx.state !== "running"){
    playbackSession();
    ctx.resume().then(statusAuto, statusAuto);
  }
}

/* ---------------- voices (one per finger) ---------------- */
function makeVoice(pn, rn){
  if (!ready) return null;
  if (voices.length >= MAXV) killVoice(voices[0]);
  const t = ctx.currentTime;
  const v = {
    id: ++vid, pn, rn, pointer: null, held: false,
    t0: performance.now()/1000, randVal: 0, randLast: 0,
    trace: new Array(160).fill(toHz(pn)), tapKill: false, px:0, py:0, pt:0
  };
  v.g = ctx.createGain(); v.g.gain.value = 0;
  v.mixg = ctx.createGain(); v.mixg.gain.value = .5;
  v.o1 = ctx.createOscillator(); v.o2 = ctx.createOscillator();
  v.o1.type = v.o2.type = P.wave;
  v.o1.frequency.value = v.o2.frequency.value = toHz(pn);
  v.o2.detune.value = SPREAD();
  v.o1.connect(v.mixg); v.o2.connect(v.mixg); v.mixg.connect(v.g);

  v.amt = ctx.createGain(); v.amt.gain.value = CENTS();
  v.lfo = ctx.createOscillator();
  v.lfo.type = (P.shape === "random") ? "sine" : P.shape;
  v.lfo.frequency.value = toRate(rn);
  try { v.rand = ctx.createConstantSource(); v.rand.offset.value = 0; }
  catch(e){ v.rand = null; }
  v.amt.connect(v.o1.detune); v.amt.connect(v.o2.detune);
  if (P.shape === "random" && v.rand) v.rand.connect(v.amt); else v.lfo.connect(v.amt);

  v.g.connect(dry); v.g.connect(sendG);
  v.o1.start(); v.o2.start(); v.lfo.start(); if (v.rand) v.rand.start();
  v.g.gain.setTargetAtTime(LEVEL, t, .006);

  voices.push(v); primary = v;
  return v;
}

function killVoice(v){
  const i = voices.indexOf(v); if (i < 0) return;
  voices.splice(i,1);
  if (primary === v) primary = voices[voices.length-1] || null;
  const t = ctx.currentTime;
  v.g.gain.cancelScheduledValues(t);
  v.g.gain.setTargetAtTime(0, t, .015);
  const stop = t + .3;
  try { v.o1.stop(stop); v.o2.stop(stop); v.lfo.stop(stop); if (v.rand) v.rand.stop(stop); } catch(e){}
  setTimeout(() => { try { v.g.disconnect(); v.amt.disconnect(); v.mixg.disconnect(); } catch(e){} }, 500);
}

function moveVoice(v, pn, rn){
  v.pn = pn; v.rn = rn;
  const t = ctx.currentTime;
  v.o1.frequency.setTargetAtTime(toHz(pn), t, .012);
  v.o2.frequency.setTargetAtTime(toHz(pn), t, .012);
  v.lfo.frequency.setTargetAtTime(toRate(rn), t, .02);
}

function apply(){
  if (!ready) return;
  const t = ctx.currentTime;
  voices.forEach(v => {
    v.o2.detune.setTargetAtTime(SPREAD(), t, .02);
    v.amt.gain.setTargetAtTime(CENTS(), t, .02);
  });
  delay.delayTime.setTargetAtTime(DTIME(), t, .09);   // tape-style glide
  fbGain.gain.setTargetAtTime(blast ? .99 : FB(), t, .03);
  fbFilt.frequency.setTargetAtTime(TONE(), t, .03);
  sendG.gain.setTargetAtTime(P.send, t, .03);
  master.gain.setTargetAtTime(P.vol, t, .03);
}

function setWave(w){
  P.wave = w;
  voices.forEach(v => { v.o1.type = w; v.o2.type = w; });
}
function setShape(s){
  P.shape = s;
  voices.forEach(v => {
    try { v.lfo.disconnect(v.amt); } catch(e){}
    if (v.rand) { try { v.rand.disconnect(v.amt); } catch(e){} }
    if (s === "random" && v.rand) v.rand.connect(v.amt);
    else { v.lfo.type = (s === "random") ? "sine" : s; v.lfo.connect(v.amt); }
  });
}

/* ---------------- sliders ---------------- */
const fmt = {
  pitch: () => Math.round(toHz(P.pitch)) + " Hz",
  rate:  () => { const r = toRate(P.rate); return r.toFixed(r < 10 ? 2 : 1) + " Hz"; },
  depth: () => Math.round(P.depth*100) + " %",
  spread:() => Math.round(SPREAD()) + " ct",
  dtime: () => Math.round(DTIME()*1000) + " ms",
  fback: () => Math.round(P.fback*100) + " %",
  tone:  () => (TONE() >= 1000 ? (TONE()/1000).toFixed(1)+" k" : Math.round(TONE())+" Hz"),
  send:  () => Math.round(P.send*100) + " %",
  vol:   () => Math.round(P.vol*100) + " %"
};
const keys = Object.keys(fmt);
keys.forEach(k => {
  const s = el(k), o = el(k+"V");
  s.value = P[k]*1000;
  s.addEventListener("input", () => {
    P[k] = s.value/1000;
    o.textContent = fmt[k]();
    if ((k === "pitch" || k === "rate") && primary) moveVoice(primary, P.pitch, P.rate);
    apply();
  });
  o.textContent = fmt[k]();
});
function refresh(){
  keys.forEach(k => { el(k).value = P[k]*1000; el(k+"V").textContent = fmt[k](); });
  apply();
}
function syncXY(){
  el("pitch").value = P.pitch*1000; el("pitchV").textContent = fmt.pitch();
  el("rate").value  = P.rate*1000;  el("rateV").textContent  = fmt.rate();
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
latchBtn.addEventListener("click", () => {
  latch = !latch;
  latchBtn.setAttribute("aria-pressed", latch);
  if (latch){
    ensure();
    voices.forEach(v => { if (v.pointer === null) v.held = true; });
    if (!voices.length){ const v = makeVoice(P.pitch, P.rate); if (v) v.held = true; }
  } else {
    voices.filter(v => v.pointer === null).slice().forEach(killVoice);
  }
});

const blastBtn = el("blast");
blastBtn.addEventListener("pointerdown", e => { e.preventDefault(); ensure(); blast = true; apply(); });
["pointerup","pointercancel","pointerleave"].forEach(ev =>
  blastBtn.addEventListener(ev, e => { e.preventDefault(); blast = false; apply(); }));

/* ---------------- presets ---------------- */
const PRESETS = {
  airraid:{pitch:.46,rate:.10,depth:.62,spread:.12,dtime:.55,fback:.66,tone:.55,send:.72,wave:"sawtooth",shape:"triangle"},
  police: {pitch:.58,rate:.36,depth:.40,spread:.05,dtime:.40,fback:.58,tone:.62,send:.66,wave:"sine",shape:"square"},
  laser:  {pitch:.72,rate:.74,depth:.55,spread:.28,dtime:.22,fback:.74,tone:.78,send:.85,wave:"square",shape:"sawtooth"},
  ufo:    {pitch:.50,rate:.52,depth:.22,spread:.42,dtime:.62,fback:.70,tone:.45,send:.80,wave:"triangle",shape:"sine"},
  whoop:  {pitch:.30,rate:.44,depth:.78,spread:.08,dtime:.48,fback:.62,tone:.50,send:.75,wave:"sine",shape:"sawtooth"},
  steppa: {pitch:.38,rate:.60,depth:.35,spread:.18,dtime:.33,fback:.80,tone:.40,send:.88,wave:"square",shape:"random"}
};
el("presets").addEventListener("click", e => {
  const b = e.target.closest(".preset"); if (!b) return;
  const p = PRESETS[b.dataset.p]; if (!p) return;
  Object.assign(P, p);
  ensure(); setWave(P.wave); setShape(P.shape); syncChips(); refresh();
  if (primary) moveVoice(primary, P.pitch, P.rate);
});

/* ---------------- multitouch touch plate ---------------- */
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

const byPointer = new Map();
function posOf(e){
  const r = plate.getBoundingClientRect();
  return [ clamp((e.clientX - r.left)/r.width, 0, 1),
           clamp(1 - (e.clientY - r.top)/r.height, 0, 1) ];
}
function nearestHeld(pn, rn){
  let best = null, bd = 1e9;
  voices.forEach(v => {
    if (!v.held || v.pointer !== null) return;
    const dx = (v.pn - pn)*plateW, dy = (v.rn - rn)*plateH;
    const d = Math.hypot(dx, dy);
    if (d < bd){ bd = d; best = v; }
  });
  return bd <= 46 ? best : null;
}

plate.addEventListener("pointerdown", e => {
  plate.setPointerCapture(e.pointerId);
  ensure();
  const [pn, rn] = posOf(e);
  let v = null, adopted = false;
  if (latch){ v = nearestHeld(pn, rn); if (v){ v.held = false; adopted = true; } }
  if (!v) v = makeVoice(pn, rn); else moveVoice(v, pn, rn);
  if (!v) return;
  v.pointer = e.pointerId; v.tapKill = adopted;
  v.px = e.clientX; v.py = e.clientY; v.pt = performance.now();
  primary = v; byPointer.set(e.pointerId, v);
  P.pitch = v.pn; P.rate = v.rn; syncXY();
});

plate.addEventListener("pointermove", e => {
  const v = byPointer.get(e.pointerId); if (!v) return;
  e.preventDefault();
  const [pn, rn] = posOf(e);
  moveVoice(v, pn, rn);
  if (Math.hypot(e.clientX - v.px, e.clientY - v.py) > 9) v.tapKill = false;
  if (v === primary){ P.pitch = pn; P.rate = rn; syncXY(); }
});

function release(e){
  const v = byPointer.get(e.pointerId); if (!v) return;
  byPointer.delete(e.pointerId);
  v.pointer = null;
  if (!latch){ killVoice(v); return; }
  if (v.tapKill && performance.now() - v.pt < 320) killVoice(v);
  else v.held = true;
}
plate.addEventListener("pointerup", release);
plate.addEventListener("pointercancel", release);

/* ---------------- drawing ---------------- */
const led = el("led");
const shapeFn = {
  sine:    p => Math.sin(2*Math.PI*p),
  triangle:p => 2*Math.abs(2*(p%1)-1)-1,
  sawtooth:p => 2*(p%1)-1,
  square:  p => ((p%1) < .5 ? 1 : -1),
  random:  (p,v) => v.randVal
};

function draw(now){
  requestAnimationFrame(draw);
  const t = now/1000;
  const fn = shapeFn[P.shape] || shapeFn.sine;

  voices.forEach(v => {
    const r = toRate(v.rn);
    if (t - v.randLast >= 1/r){
      v.randLast = t; v.randVal = Math.random()*2 - 1;
      if (ready && v.rand) v.rand.offset.setTargetAtTime(v.randVal, ctx.currentTime, .004);
    }
    v.phase = ((t - v.t0)*r) % 1;
    v.val = fn(v.phase, v);
    v.freq = toHz(v.pn) * Math.pow(2, v.val*CENTS()/1200);
    v.trace.push(v.freq); if (v.trace.length > 160) v.trace.shift();
  });

  const live = voices.length > 0;
  led.classList.toggle("on", live && primary && primary.phase < .5);

  /* --- scope: one trace per voice --- */
  sctx.clearRect(0,0,scopeW,scopeH);
  sctx.fillStyle = "#060A07"; sctx.fillRect(0,0,scopeW,scopeH);
  sctx.strokeStyle = "rgba(201,162,39,.10)"; sctx.lineWidth = 1;
  for (let i=1;i<4;i++){
    const y = scopeH*i/4;
    sctx.beginPath(); sctx.moveTo(0,y+.5); sctx.lineTo(scopeW,y+.5); sctx.stroke();
  }
  if (!live){
    sctx.strokeStyle = "#2E3F30"; sctx.lineWidth = 1.6;
    sctx.beginPath(); sctx.moveTo(0,scopeH/2+.5); sctx.lineTo(scopeW,scopeH/2+.5); sctx.stroke();
  }
  voices.forEach(v => {
    sctx.beginPath();
    for (let i=0;i<v.trace.length;i++){
      const x = i/(v.trace.length-1)*scopeW;
      const y = scopeH - clamp(unlog(clamp(v.trace[i],40,9000),40,9000),0,1)*(scopeH-8) - 4;
      i ? sctx.lineTo(x,y) : sctx.moveTo(x,y);
    }
    const lead = (v === primary);
    sctx.strokeStyle = lead ? "#C9A227" : "rgba(201,162,39,.42)";
    sctx.lineWidth = lead ? 1.6 : 1.1; sctx.lineJoin = "round";
    if (lead){ sctx.shadowColor = "rgba(201,162,39,.85)"; sctx.shadowBlur = 7; }
    sctx.stroke(); sctx.shadowBlur = 0;
  });

  /* --- plate --- */
  pctx.clearRect(0,0,plateW,plateH);
  pctx.fillStyle = "#0A130D"; pctx.fillRect(0,0,plateW,plateH);
  pctx.strokeStyle = "rgba(232,226,206,.055)"; pctx.lineWidth = 1;
  for (let i=1;i<8;i++){
    const x = plateW*i/8;
    pctx.beginPath(); pctx.moveTo(x+.5,0); pctx.lineTo(x+.5,plateH); pctx.stroke();
  }
  for (let i=1;i<5;i++){
    const y = plateH*i/5;
    pctx.beginPath(); pctx.moveTo(0,y+.5); pctx.lineTo(plateW,y+.5); pctx.stroke();
  }

  if (!live){
    const cx = P.pitch*plateW, cy = (1-P.rate)*plateH;
    pctx.strokeStyle = "rgba(232,226,206,.20)"; pctx.lineWidth = 1;
    pctx.beginPath();
    pctx.moveTo(0,cy+.5); pctx.lineTo(plateW,cy+.5);
    pctx.moveTo(cx+.5,0); pctx.lineTo(cx+.5,plateH); pctx.stroke();
    pctx.beginPath(); pctx.arc(cx,cy,8,0,7);
    pctx.fillStyle = "#3C4E41"; pctx.fill();
  }

  voices.forEach(v => {
    const cx = v.pn*plateW, cy = (1-v.rn)*plateH, a = Math.abs(v.val);
    const g = pctx.createRadialGradient(cx,cy,0,cx,cy,64 + 34*a);
    g.addColorStop(0, v === primary ? "rgba(201,162,39,.40)" : "rgba(201,162,39,.24)");
    g.addColorStop(1, "rgba(201,162,39,0)");
    pctx.fillStyle = g; pctx.fillRect(0,0,plateW,plateH);

    pctx.strokeStyle = v === primary ? "rgba(201,162,39,.55)" : "rgba(201,162,39,.30)";
    pctx.lineWidth = 1;
    pctx.beginPath();
    pctx.moveTo(0,cy+.5); pctx.lineTo(plateW,cy+.5);
    pctx.moveTo(cx+.5,0); pctx.lineTo(cx+.5,plateH); pctx.stroke();

    pctx.beginPath(); pctx.arc(cx,cy, 9 + 6*a, 0, 7);
    pctx.fillStyle = "#E5CE7E"; pctx.fill();

    if (v.held){                       // ring = voice held by Latch
      pctx.beginPath(); pctx.arc(cx,cy, 19, 0, 7);
      pctx.strokeStyle = "rgba(232,226,206,.75)"; pctx.lineWidth = 1.5; pctx.stroke();
    }
  });

  if (live){                            // voice counter
    pctx.font = "10px ui-monospace, Menlo, monospace";
    pctx.fillStyle = "rgba(201,162,39,.85)"; pctx.textAlign = "right";
    pctx.fillText(voices.length + (voices.length === 1 ? " VOICE" : " VOICES"), plateW - 9, 17);
  }
}
resize();
requestAnimationFrame(draw);

/* ---------------- power-on, test, and resume ---------------- */
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

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && ctx && ctx.state !== "running"){
    playbackSession(); ctx.resume().then(statusAuto, statusAuto);
  }
});

document.addEventListener("gesturestart", e => e.preventDefault());

/* ---------------- native app integration (Capacitor: iOS + Android) ---------------- */
if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()){
  const stopForBackground = () => {
    latch = false;
    latchBtn.setAttribute("aria-pressed","false");
    voices.slice().forEach(killVoice);
    if (ctx && ctx.state === "running") ctx.suspend();
  };

  const CapApp = window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (CapApp && CapApp.addListener){
    // Mute and suspend audio when going to the background (incoming call, Control Center, home, etc).
    CapApp.addListener("appStateChange", ({ isActive }) => { if (!isActive) stopForBackground(); });

    if (window.Capacitor.getPlatform && window.Capacitor.getPlatform() === "android"){
      // Android's hardware/gesture back button: there's no in-app navigation, so exit.
      CapApp.addListener("backButton", () => CapApp.exitApp());
    }
  } else {
    document.addEventListener("visibilitychange", () => { if (document.hidden) stopForBackground(); });
  }
}

/* ---------------- PWA: register the service worker for offline use ---------------- */
if ("serviceWorker" in navigator && !(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())){
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
})();
