(() => {
"use strict";

/* ---------------- parámetros y mapeos ---------------- */
const el = id => document.getElementById(id);
const clamp = (v,a,b) => Math.min(b,Math.max(a,v));
const lerp  = (a,b,t) => a+(b-a)*t;
const logMap= (t,a,b) => a*Math.pow(b/a,t);          // t 0..1 -> a..b logarítmico
const unlog = (v,a,b) => Math.log(v/a)/Math.log(b/a);

const P = {                       // valores normalizados 0..1
  pitch:.42, rate:.33, depth:.48, spread:.09,
  dtime:.42, fback:.62, tone:.52, send:.70, vol:.70,
  wave:"sine", shape:"sine"
};
const HZ    = () => logMap(P.pitch, 45, 1800);
const RATE  = () => logMap(P.rate, .15, 28);
const CENTS = () => P.depth * 4200;
const SPREAD= () => P.spread * 900;
const DTIME = () => logMap(P.dtime, .035, 1.1);
const FB    = () => P.fback * .92;
const TONE  = () => logMap(P.tone, 260, 9000);

/* ---------------- audio ---------------- */
let ctx, master, comp, dry, osc1, osc2, mix, voice,
    lfo, lfoRand, lfoAmt, send, delay, fbGain, fbFilt, hp, sat, echoOut;
let ready = false, playing = false, latch = false, blast = false;
let randVal = 0, randLast = 0;

function shaperCurve(){
  const n = 1024, c = new Float32Array(n);
  for (let i=0;i<n;i++){ const x = i*2/n - 1; c[i] = Math.tanh(x*1.8)*.92; }
  return c;
}

function build(){
  if (ready) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC();

  master = ctx.createGain();  master.gain.value = P.vol;
  comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -8; comp.knee.value = 6;
  comp.ratio.value = 14; comp.attack.value = .003; comp.release.value = .18;
  master.connect(comp).connect(ctx.destination);

  // voz
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
  lfoRand = ctx.createConstantSource(); lfoRand.offset.value = 0;
  lfoAmt.connect(osc1.detune); lfoAmt.connect(osc2.detune);

  // eco
  dry = ctx.createGain(); dry.gain.value = 1;
  send = ctx.createGain(); send.gain.value = P.send;
  delay = ctx.createDelay(1.5); delay.delayTime.value = DTIME();
  fbGain = ctx.createGain(); fbGain.gain.value = FB();
  fbFilt = ctx.createBiquadFilter(); fbFilt.type = "lowpass";
  fbFilt.frequency.value = TONE(); fbFilt.Q.value = .7;
  hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 170;
  sat = ctx.createWaveShaper(); sat.curve = shaperCurve(); sat.oversample = "2x";
  echoOut = ctx.createGain(); echoOut.gain.value = .95;

  voice.connect(dry).connect(master);
  voice.connect(send).connect(delay);
  delay.connect(fbFilt).connect(hp).connect(sat).connect(fbGain).connect(delay);
  delay.connect(echoOut).connect(master);

  osc1.start(); osc2.start(); lfo.start(); lfoRand.start();
  ready = true;
  setShape(P.shape);
}

function on(){
  build();
  if (ctx.state === "suspended") ctx.resume();
  const t = ctx.currentTime;
  voice.gain.cancelScheduledValues(t);
  voice.gain.setTargetAtTime(.5, t, .006);
  playing = true;
}
function off(){
  if (!ready) return;
  const t = ctx.currentTime;
  voice.gain.cancelScheduledValues(t);
  voice.gain.setTargetAtTime(0, t, .015);
  playing = false;
}

function apply(){
  if (!ready) return;
  const t = ctx.currentTime;
  osc1.frequency.setTargetAtTime(HZ(), t, .012);
  osc2.frequency.setTargetAtTime(HZ(), t, .012);
  osc2.detune.setTargetAtTime(SPREAD(), t, .02);
  lfo.frequency.setTargetAtTime(RATE(), t, .02);
  lfoAmt.gain.setTargetAtTime(CENTS(), t, .02);
  delay.delayTime.setTargetAtTime(DTIME(), t, .09);   // glide tipo cinta
  fbGain.gain.setTargetAtTime(blast ? .99 : FB(), t, .03);
  fbFilt.frequency.setTargetAtTime(TONE(), t, .03);
  send.gain.setTargetAtTime(P.send, t, .03);
  master.gain.setTargetAtTime(P.vol, t, .03);
}

function setWave(w){
  P.wave = w;
  if (ready){ osc1.type = w; osc2.type = w; }
}
function setShape(s){
  P.shape = s;
  if (!ready) return;
  try{ lfo.disconnect(lfoAmt); }catch(e){}
  try{ lfoRand.disconnect(lfoAmt); }catch(e){}
  if (s === "random"){ lfoRand.connect(lfoAmt); }
  else { lfo.type = s; lfo.connect(lfoAmt); }
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
const keys = Object.keys(fmt);
keys.forEach(k => {
  const s = el(k), o = el(k+"V");
  s.value = P[k]*1000;
  const upd = () => { P[k] = s.value/1000; o.textContent = fmt[k](); apply(); };
  s.addEventListener("input", upd);
  o.textContent = fmt[k]();
});
function refresh(){
  keys.forEach(k => { el(k).value = P[k]*1000; el(k+"V").textContent = fmt[k](); });
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

/* ---------------- botones ---------------- */
const latchBtn = el("latch");
latchBtn.addEventListener("click", () => {
  latch = !latch;
  latchBtn.setAttribute("aria-pressed", latch);
  if (latch) on(); else off();
});

const blastBtn = el("blast");
const blastOn  = e => { e.preventDefault(); blast = true; build(); apply(); };
const blastOff = e => { e.preventDefault(); blast = false; apply(); };
blastBtn.addEventListener("pointerdown", blastOn);
blastBtn.addEventListener("pointerup", blastOff);
blastBtn.addEventListener("pointercancel", blastOff);
blastBtn.addEventListener("pointerleave", blastOff);

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
  build(); setWave(P.wave); setShape(P.shape); syncChips(); refresh();
});

/* ---------------- placa táctil ---------------- */
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

/* ---------------- dibujo ---------------- */
const led = el("led");
const shapeFn = {
  sine:   p => Math.sin(2*Math.PI*p),
  triangle:p => 2*Math.abs(2*(p%1)-1)-1,
  sawtooth:p => 2*(p%1)-1,
  square: p => ((p%1) < .5 ? 1 : -1),
  random: () => randVal
};
const trace = new Array(180).fill(0);

function draw(now){
  requestAnimationFrame(draw);
  const t = now/1000;

  // S&H para el barrido aleatorio
  const r = RATE();
  if (t - randLast >= 1/r){
    randLast = t; randVal = Math.random()*2 - 1;
    if (ready) lfoRand.offset.setTargetAtTime(randVal, ctx.currentTime, .004);
  }

  const phase = (t*r) % 1;
  const v = (shapeFn[P.shape] || shapeFn.sine)(phase);
  const cents = v * CENTS();
  const f = HZ() * Math.pow(2, cents/1200);

  led.classList.toggle("on", playing && phase < .5);

  /* --- scope: traza de tono en vivo --- */
  trace.push(f); if (trace.length > 180) trace.shift();
  sctx.clearRect(0,0,scopeW,scopeH);
  sctx.fillStyle = "#060A07"; sctx.fillRect(0,0,scopeW,scopeH);
  sctx.strokeStyle = "rgba(201,162,39,.10)"; sctx.lineWidth = 1;
  for (let i=1;i<4;i++){
    const y = scopeH*i/4; sctx.beginPath();
    sctx.moveTo(0,y+.5); sctx.lineTo(scopeW,y+.5); sctx.stroke();
  }
  sctx.beginPath();
  for (let i=0;i<trace.length;i++){
    const x = i/(trace.length-1)*scopeW;
    const y = scopeH - clamp(unlog(clamp(trace[i],40,9000),40,9000),0,1)*(scopeH-8) - 4;
    i ? sctx.lineTo(x,y) : sctx.moveTo(x,y);
  }
  sctx.strokeStyle = playing ? "#C9A227" : "#2E3F30";
  sctx.lineWidth = 1.6; sctx.lineJoin = "round";
  if (playing){ sctx.shadowColor = "rgba(201,162,39,.85)"; sctx.shadowBlur = 7; }
  sctx.stroke(); sctx.shadowBlur = 0;

  /* --- placa --- */
  pctx.clearRect(0,0,plateW,plateH);
  pctx.fillStyle = "#0A130D"; pctx.fillRect(0,0,plateW,plateH);
  pctx.strokeStyle = "rgba(232,226,206,.055)"; pctx.lineWidth = 1;
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
    g.addColorStop(0,"rgba(201,162,39,.42)");
    g.addColorStop(1,"rgba(201,162,39,0)");
    pctx.fillStyle = g; pctx.fillRect(0,0,plateW,plateH);
  }
  pctx.strokeStyle = playing ? "rgba(201,162,39,.55)" : "rgba(232,226,206,.22)";
  pctx.lineWidth = 1;
  pctx.beginPath();
  pctx.moveTo(0,cy+.5); pctx.lineTo(plateW,cy+.5);
  pctx.moveTo(cx+.5,0); pctx.lineTo(cx+.5,plateH); pctx.stroke();

  pctx.beginPath(); pctx.arc(cx,cy,playing ? 9+6*Math.abs(v) : 8,0,7);
  pctx.fillStyle = playing ? "#E5CE7E" : "#3C4E41"; pctx.fill();
}
resize();
requestAnimationFrame(draw);

/* desbloqueo de audio al primer toque en cualquier sitio */
document.addEventListener("pointerdown", function once(){
  build();
  if (ctx && ctx.state === "suspended") ctx.resume();
  document.removeEventListener("pointerdown", once);
}, {passive:true});

document.addEventListener("gesturestart", e => e.preventDefault());

/* ---------------- integración con la app nativa iOS (Capacitor) ---------------- */
if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()){
  const stopForBackground = () => {
    latch = false;
    latchBtn.setAttribute("aria-pressed","false");
    off();
    if (ctx && ctx.state === "running") ctx.suspend();
  };

  const CapApp = window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (CapApp && CapApp.addListener){
    // Silencia y suspende el audio al pasar a segundo plano (llamada entrante, Centro de Control, home, etc).
    CapApp.addListener("appStateChange", ({ isActive }) => { if (!isActive) stopForBackground(); });
  } else {
    document.addEventListener("visibilitychange", () => { if (document.hidden) stopForBackground(); });
  }
}
})();
