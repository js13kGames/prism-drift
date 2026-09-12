// Regression harness for flight feel: movement responsiveness, frame-rate
// independence, slow-mo steering and camera geometry in index.html.
//
// Like _music_test.js, it extracts the ACTUAL shipped functions (step / rn /
// cen / Wn / the math helpers) out of index.html and runs them inside a Node
// vm sandbox, so the tests exercise the real production code path (not a
// re-implemented copy of the formulas). Render / input / audio / crash / notes
// seams are stubbed so step() runs headless without a GL context.
//
// SKY_HTML lets the same suite be pointed at an alternate build (used to prove
// the frame-independence / slow-mo assertions are red on the old Euler physics).

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const HTML = process.env.SKY_HTML || path.join(__dirname, 'index.html');
const html = fs.readFileSync(HTML, 'utf8');
const src = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));

let fails = 0, passes = 0;
function ok(cond, msg) { if (cond) { passes++; } else { fails++; console.error('  FAIL:', msg); } }
function near(a, b, e, msg) { ok(Math.abs(a - b) <= (e || 1e-9), msg + ' (got ' + a + ', want ' + b + ')'); }

// Extract a top-level `function name(...) {...}` by brace matching the source.
function grab(name) {
  const key = 'function ' + name + '(';
  const i = src.indexOf(key);
  if (i < 0) throw new Error('cannot find ' + name + ' in index.html');
  let depth = 0, j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(i, j);
}

// A fresh headless world holding the real step()/camera code. Input is fed
// through the real rn() seam via IX/IY (stubbed rn returns [IX,IY]).
function make() {
  const ctx = {
    M: Math, TAU: 6.2831853, STEP: 3.2, BACK: 6,
    Ce: 1, Ue: false, Be: 100, qe: 1, He: 0,
    score: 0, pz: 0, px: 0, py: 0, De: 0, Pe: 0, Ke: 0,
    Ne: false, ze: false,
    Xe: [0, 0, 1], Qe: [0, -0.3, 1], Ge: [0, 3.2, -9.5], Ye: [0, -0.2, 14],
    Ze: -1, ge: 0, ae: 0,
    notes: [], lyr: [], LON: [0, 0, 0, 0, 0, 0], nnz: 60,
    Sp: 0, tp: [], tA: 0,
    IX: 0, IY: 0,
    d: {}, g: { innerHTML: '' }, p: { style: {} }, y: [], m: [],
  };
  vm.createContext(ctx);
  // the shipped code aliases the hot Math helpers (byte budget); mirror them so
  // the extracted functions resolve ms/mc/mr/mf/mh exactly as in the browser.
  vm.runInContext('var ms=M.sin,mc=M.cos,mr=M.random,mf=M.floor,mh=M.hypot;', ctx);
  vm.runInContext(
    'function draw(){}function Vn(){return false}function die(){}function je(){}' +
    'function rn(){return[IX,IY]}function w(){}function aPk(){}' +
    'function nSpawn(){}function nLayers(){}function nSweep(){}function nReset(){}', ctx);
  ['smooth', 'cen', 'rad', 'N', 'z', 'H', 'V', 'W', 'O', 'Wn', 'Xn', 'step', 'reset']
    .forEach(n => vm.runInContext(grab(n), ctx));
  vm.runInContext('Qn=O(1.24,1,.3,140);', ctx);
  return ctx;
}

// Drive the real step() for `secs` seconds at a fixed rate with constant input.
function drive(ctx, hz, secs, ix, iy, slow) {
  ctx.IX = ix; ctx.IY = iy; ctx.Ue = !!slow; ctx.Ce = 1;
  const e = 1 / hz, steps = Math.round(secs * hz);
  for (let i = 0; i < steps; i++) vm.runInContext('step(' + e + ')', ctx);
}

const rel = (a, b) => Math.abs(a - b) / (Math.abs(b) || 1);

console.log('flight harness on', path.basename(HTML));

// ---------- A. frame-rate independence: equal-time position & velocity ----------
// Same real time + same input at 30/60/144 Hz must land at (nearly) the same
// lateral position AND velocity. Exact exponential integration => ~0% spread;
// the old semi-implicit Euler drifts several % in velocity.
{
  const runs = [30, 60, 144].map(hz => { const c = make(); drive(c, hz, 0.5, 1, 0, false); return c; });
  const base = runs[1]; // 60 Hz reference
  let maxP = 0, maxV = 0;
  for (const c of runs) { maxP = Math.max(maxP, rel(c.px, base.px)); maxV = Math.max(maxV, rel(c.De, base.De)); }
  console.log('  A: px spread', (maxP * 100).toFixed(3) + '%  De spread', (maxV * 100).toFixed(3) + '%');
  ok(maxP < 0.03, 'A: lateral position within 3% across 30/60/144 Hz (got ' + (maxP * 100).toFixed(2) + '%)');
  ok(maxV < 0.03, 'A: lateral velocity within 3% across 30/60/144 Hz (got ' + (maxV * 100).toFixed(2) + '%)');
}

// ---------- B. frame-rate independence under jittered timesteps ----------
{
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ref = make(); drive(ref, 1000, 0.5, 1, 0, false); // ~fine fixed step reference
  let maxP = 0, maxV = 0;
  for (let trial = 0; trial < 40; trial++) {
    const c = make(); c.IX = 1; c.IY = 0; c.Ce = 1; let t = 0;
    while (t < 0.5) { let e = 0.004 + rnd() * 0.029; if (t + e > 0.5) e = 0.5 - t; t += e; vm.runInContext('step(' + e + ')', c); }
    maxP = Math.max(maxP, rel(c.px, ref.px)); maxV = Math.max(maxV, rel(c.De, ref.De));
  }
  console.log('  B: jitter px spread', (maxP * 100).toFixed(3) + '%  De spread', (maxV * 100).toFixed(3) + '%');
  ok(maxP < 0.03 && maxV < 0.03, 'B: jittered-timestep position & velocity within 3% of fine-step reference');
}

// ---------- C. responsive acceleration: hold 0.3 s ----------
// Velocity should climb quickly and monotonically to a healthy share of terminal.
const TERM = 23;      // calmed terminal lateral speed at full stick (was 36.9 -> subtler)
const PRIOR_TERM = 36.9; // the previous, jarring terminal we are intentionally softening
{
  const c = make();
  let prev = -1, mono = true;
  c.IX = 1; c.IY = 0; c.Ce = 1;
  for (let i = 0; i < 18; i++) { vm.runInContext('step(' + (1 / 60) + ')', c); if (c.De < prev - 1e-9) mono = false; prev = c.De; }
  console.log('  C: De after 0.3s hold', c.De.toFixed(3), '(' + (c.De / TERM * 100).toFixed(1) + '% of terminal)');
  ok(mono, 'C: velocity rises monotonically while holding a direction');
  ok(c.De >= 0.6 * TERM, 'C: reaches >=60% of terminal speed within 0.3s (responsive, not floaty)');
  ok(c.De < TERM + 1e-6, 'C: never overshoots terminal speed (stable integrator)');
}

// ---------- D. responsive braking: release for 0.4 s ----------
{
  const c = make();
  drive(c, 60, 0.3, 1, 0, false); const held = c.De;
  drive(c, 60, 0.4, 0, 0, false); // release
  console.log('  D: De', held.toFixed(3), '-> after 0.4s release', c.De.toFixed(3), '(' + (c.De / held * 100).toFixed(1) + '%)');
  ok(c.De <= 0.25 * held, 'D: coasts down to <=25% of held speed within 0.4s of release (responsive braking)');
  ok(c.De >= 0, 'D: braking never drives velocity negative without input');
}

// ---------- E. direction reversal ----------
{
  const c = make();
  drive(c, 60, 0.3, 1, 0, false); ok(c.De > 0, 'E: moving right after holding right');
  drive(c, 60, 0.3, -1, 0, false);
  console.log('  E: De after 0.3s reverse', c.De.toFixed(3));
  ok(c.De < 0, 'E: velocity reverses sign within 0.3s of flipping the stick');
}

// ---------- F. slow-mo keeps steering responsive while slowing the world ----------
// Over the SAME 0.5 s of real time, slow-mo steering velocity must stay a large
// share of the normal response (>=60%), and lateral travel must retain far more
// agility than the 35% world-time slowdown, WHILE forward/world motion is still
// slowed to ~35%.
{
  const n = make(); drive(n, 60, 0.5, 1, 0, false);
  const s = make(); drive(s, 60, 0.5, 1, 0, true);
  const vRatio = s.De / n.De, pRatio = s.px / n.px, zRatio = s.pz / n.pz;
  console.log('  F: slow-mo De', (vRatio * 100).toFixed(1) + '%  lateral', (pRatio * 100).toFixed(1) + '%  forward', (zRatio * 100).toFixed(1) + '%');
  ok(vRatio >= 0.6, 'F: slow-mo steering velocity >=60% of normal over 0.5s (got ' + (vRatio * 100).toFixed(1) + '%)');
  ok(pRatio > 0.45, 'F: slow-mo retains lateral agility well above the world slowdown');
  ok(zRatio > 0.3 && zRatio < 0.4, 'F: forward/world motion is still slowed to ~35% (got ' + (zRatio * 100).toFixed(1) + '%)');
}

// ---------- G. combined touch + keyboard input is clamped to [-1,1] ----------
// Exercises the real rn() seam (keyboard Je + touch en/nn), which must clamp the
// combined axes so holding a key AND dragging can't double the steering command.
{
  const rc = { M: Math, Je: {}, en: 0, nn: 0 };
  vm.createContext(rc);
  ['Xn', 'rn'].forEach(n => vm.runInContext(grab(n), rc));
  const rn = v => vm.runInContext('rn()', rc);
  rc.Je = { ArrowRight: 1 }; rc.en = 1; rc.nn = 0; // key +1 and drag +1 => 2, must clamp to 1
  let r = rn();
  near(r[0], 1, 1e-9, 'G: key-right + full right drag clamps combined X to 1 (not 2)');
  rc.Je = { ArrowLeft: 1, ArrowDown: 1 }; rc.en = -1; rc.nn = -1;
  r = rn();
  near(r[0], -1, 1e-9, 'G: key-left + full left drag clamps combined X to -1');
  near(r[1], -1, 1e-9, 'G: key-down + full down drag clamps combined Y to -1');
  rc.Je = {}; rc.en = 0.5; rc.nn = -0.25; // in range -> passes through untouched
  r = rn();
  near(r[0], 0.5, 1e-9, 'G: in-range partial drag passes through unclamped (X)');
  near(r[1], -0.25, 1e-9, 'G: in-range partial drag passes through unclamped (Y)');
}

// ---------- H. camera follow is frame-consistent ----------
// The forward/geometry axis is a rigid chase (exact at any rate); the lateral &
// vertical axes are intentionally smoothed for feel, so mid-maneuver they lag by
// a framerate-dependent hair. The rigorous invariant: after an identical
// maneuver + coast, the camera SETTLES to the same pose regardless of framerate
// (steady-state exponential smoothing converges to the exact target). Run the
// same steer-then-straighten profile at 30 vs 144 Hz and compare the settled pose.
{
  const prof = (c) => { drive(c, c._hz, 0.5, 1, 0, false); drive(c, c._hz, 3.5, 0, 0, false); };
  const a = make(); a._hz = 30; prof(a);
  const b = make(); b._hz = 144; prof(b);
  let maxG = 0, maxY = 0;
  for (let k = 0; k < 3; k++) { maxG = Math.max(maxG, Math.abs(a.Ge[k] - b.Ge[k])); maxY = Math.max(maxY, Math.abs(a.Ye[k] - b.Ye[k])); }
  console.log('  H: settled camera pos diff', maxG.toExponential(2), ' look diff', maxY.toExponential(2));
  ok(maxG < 1e-4 && maxY < 1e-4, 'H: camera settles to an identical pose across 30/144 Hz');
}

// ---------- I. straight-flight geometry (chase cam sits behind/above, looks ahead) ----------
{
  const c = make();
  drive(c, 60, 2.0, 0, 0, false); // fly straight, let the camera settle
  console.log('  I: ship pz', c.pz.toFixed(2), 'cam', c.Ge.map(v => v.toFixed(2)), 'look', c.Ye.map(v => v.toFixed(2)));
  ok(Math.abs(c.Ge[0] - c.px) < 1e-6, 'I: straight flight keeps the camera laterally centred on the ship');
  ok(c.Ge[2] < c.pz, 'I: camera sits BEHIND the ship');
  ok(c.Ge[1] > c.py, 'I: camera sits ABOVE the ship');
  ok(c.Ye[2] > c.pz, 'I: camera looks AHEAD of the ship');
  near(c.pz - c.Ge[2], 9.5, 0.02, 'I: chase distance settles at the reframed 9.5 behind-offset (further back)');
  near(c.Ye[2] - c.pz, 14, 0.02, 'I: look target settles at the 14 lookahead');
  near(c.Ge[1] - c.py, 3.2, 0.05, 'I: camera height settles near the lowered 3.2 offset');
  // less downward bias: the look target sits only slightly below the ship now (-0.2, was -0.8),
  // opening up more of the tunnel ahead. The camera-to-look pitch is correspondingly flatter.
  near(c.Ye[1] - c.py, -0.2, 0.02, 'I: look target vertical bias is the softened -0.2 (was -0.8), more visibility ahead');
  const pitch = Math.atan2(c.Ge[1] - c.Ye[1], c.Ye[2] - c.Ge[2]);
  console.log('  I: settled downward pitch', (pitch * 180 / Math.PI).toFixed(2) + ' deg');
  ok(pitch < 8.5 * Math.PI / 180, 'I: settled downward pitch is gentler than the prior framing (<8.5 deg, was ~11)');
}

// ---------- J. no first-frame camera jump ----------
// Init camera pose equals the desired straight-flight pose, so the very first
// frame only tracks forward motion rigidly — no vertical/lateral snap, and the
// forward component follows the ship exactly (rigid chase, no lag/jump).
{
  const c = make();
  const g0 = c.Ge.slice();
  drive(c, 60, 1 / 60, 0, 0, false); // exactly one frame, straight
  console.log('  J: dGe', c.Ge.map((v, i) => (v - g0[i]).toFixed(3)));
  ok(Math.abs(c.Ge[0] - g0[0]) < 1e-9, 'J: no lateral camera jump on frame 1');
  ok(Math.abs(c.Ge[1] - g0[1]) < 1e-9, 'J: no vertical camera jump on frame 1');
  near(c.Ge[2] - g0[2], c.pz, 1e-9, 'J: forward axis tracks the ship exactly (no lag, no snap)');
}

// ---------- K. SUBTLER feel: gentler ABSOLUTE displacement + bank than the prior build ----------
// Not just ratios: the raw terminal speed, the raw lateral travel over a fixed real
// second of full stick, and the settled bank angle must all be materially lower than
// the previous, jarring tuning -- while still reaching a calm steady state.
{
  const c = make(); drive(c, 240, 3, 1, 0, false);      // long full-stick hold -> steady state
  console.log('  K: settled |De|', c.De.toFixed(3), ' settled |Ke|', Math.abs(c.Ke).toFixed(3));
  near(c.De, TERM, 0.3, 'K: terminal speed settles at the calmer ~23 (not the old 36.9)');
  ok(c.De <= 0.65 * PRIOR_TERM, 'K: terminal speed is >=35% gentler than the prior 36.9 build');
  // absolute lateral travel over exactly 1 real second from rest, full stick
  const d1 = make(); drive(d1, 120, 1, 1, 0, false);
  const p60 = make(); drive(p60, 60, 1, 1, 0, false);
  console.log('  K: lateral travel in 1s', d1.px.toFixed(2), 'units (rate-consistent', p60.px.toFixed(2) + ')');
  ok(d1.px < 22, 'K: covers < 22 units of lateral travel in a full-stick second (calm, not twitchy)');
  ok(Math.abs(d1.px - p60.px) / d1.px < 0.03, 'K: that absolute travel is frame-rate independent');
  // bank target softened from -.5*u to -.2*u -> |Ke| settles near 0.2 at full stick
  ok(Math.abs(c.Ke) <= 0.22, 'K: bank settles at the softened ~0.2 lean (was ~0.5)');
  ok(Math.abs(c.Ke) < 0.5 - 1e-3, 'K: bank magnitude is clearly below the prior -.5 target');
}

// ---------- L. rainbow wake history: emission, bounded, frame-independent, reset, pause ----------
// The wake is emitted from the REAL step() into the shipped `tp` world-space buffer.
{
  const c = make(); drive(c, 60, 1, 0, 0, false);        // 1s straight flight
  console.log('  L: wake points after 1s', c.tp.length / 3);
  ok(c.tp.length > 0 && c.tp.length % 3 === 0, 'L: wake accumulates flat xyz world-space points while flying');
  // frame-rate independent emission count (fixed 0.04s sim-time cadence)
  const a30 = make(); drive(a30, 30, 1, 0, 0, false);
  const a144 = make(); drive(a144, 144, 1, 0, 0, false);
  const n30 = a30.tp.length / 3, n144 = a144.tp.length / 3;
  console.log('  L: emitted 30Hz', n30, ' 144Hz', n144);
  ok(Math.abs(n30 - n144) <= 1, 'L: wake emission is frame-independent (time-based, not per-frame)');
  // bounded history (GPU/memory safe) even after a long run
  const big = make(); drive(big, 60, 20, 0, 0, false);
  console.log('  L: wake points after 20s', big.tp.length / 3, '(bounded)');
  ok(big.tp.length <= 180, 'L: history is bounded to <=60 points regardless of run length');
  // emitted BEHIND the ship along the path, never on the camera, never ahead
  let behind = true, ahead = 0;
  for (let i = 2; i < c.tp.length; i += 3) { if (c.tp[i] > c.pz + 1e-6) ahead++; }
  ok(ahead === 0, 'L: every wake point trails at/behind the ship (a wake, not a leading spray)');
  ok(c.tp[c.tp.length - 1] > c.tp[2], 'L: points march forward along the flight path (a continuous ribbon)');
  ok(Math.abs(c.tp[0] - c.Ge[0]) > 1e-6 || Math.abs(c.tp[2] - c.Ge[2]) > 1e-6, 'L: wake lives in world space, not glued to the camera');
  // reset clears the wake so a restart never streaks a line across the teleport
  vm.runInContext('reset()', c);
  ok(c.tp.length === 0, 'L: reset() clears the wake (no cross-restart streak)');
  // pause freezes emission (step early-outs when not actively playing)
  const pc = make(); drive(pc, 60, 0.5, 0, 0, false); const held = pc.tp.length;
  pc.Ce = 2; for (let i = 0; i < 60; i++) vm.runInContext('step(' + (1 / 60) + ')', pc);
  ok(pc.tp.length === held, 'L: a paused game emits no new wake points (frozen)');
}

// ---------- M. the horn spins about its +z longitudinal axis, isolated from collision/camera ----------
// The spiral "horn" (the Wn(1.03) mesh) now rolls about the ship's forward (z) axis
// like a thrown football. Wn() gained an OPTIONAL roll arg (Ke+(spin||0)); the spin
// phase Sp is fed ONLY to the horn draw, so the ship body, the collision probe
// Vn(Wn(1)) and the camera basis (Xe/Qe) are provably untouched by it.
{
  // --- source: the spin is wired to the horn only, via the optional Wn roll arg ---
  ok(/function Wn\(e,sp\)\{[^}]*k=Ke\+\(sp\|\|0\)/.test(src), 'M: Wn() takes an optional roll arg using Ke+(spin||0) about the forward axis');
  ok(/Gn\(j,Wn\(1\.03,Sp\)\)/.test(src), 'M: the horn (Wn(1.03) spiral mesh) is drawn with the live spin phase Sp');
  ok(/Vn\(Wn\(1\)\)/.test(src), 'M: collision still probes the un-spun ship hull Wn(1)');
  ok(!/Wn\(1\.2,Sp\)/.test(src) && !/Wn\(1,Sp\)/.test(src), 'M: the ship cone body is NOT spun (spin is horn-only, never banking)');
  ok(/Sp\+=5\*r/.test(src), 'M: the spin phase advances on world-slowed time (r = e*qe), not raw frame time');

  // --- behaviour: passing a roll actually rotates the x/y basis about the fixed z (forward) axis ---
  const w = make();
  const base = vm.runInContext('Wn(1.03,0)', w);
  const spun = vm.runInContext('Wn(1.03,1)', w);
  const changed = [0, 1, 4, 5].some(i => Math.abs(base[i] - spun[i]) > 1e-6);
  ok(changed, 'M: a non-zero roll visibly rotates the horn (its lateral basis columns change)');
  // the forward (z) basis column and translation are the roll axis => must be invariant
  const zAxisSame = [8, 9, 10, 12, 13, 14].every(i => Math.abs(base[i] - spun[i]) < 1e-9);
  ok(zAxisSame, 'M: the spin is purely longitudinal - the +z forward axis and origin are unchanged');

  // --- isolation: the collision/ship transform Wn(1) never sees the spin phase ---
  const c = make(); drive(c, 60, 2, 0.6, 0, false);
  ok(c.Sp > 0, 'M: Sp accumulates while actively flying (the horn is really spinning)');
  const m1 = vm.runInContext('Wn(1)', c).join(',');
  c.Sp += 12.34;                                   // jam an arbitrary spin phase
  const m2 = vm.runInContext('Wn(1)', c).join(',');
  ok(m1 === m2, 'M: Wn(1) (collision + body) is identical regardless of the spin phase Sp');

  // --- Sp is world-slowed: slow-mo (qe=0.35) advances the spin ~0.35x of normal ---
  const norm = make(); drive(norm, 60, 1, 0, 0, false);
  const slow = make(); drive(slow, 60, 1, 0, 0, true);
  ok(slow.Sp < norm.Sp * 0.5, 'M: slow-mo slows the horn spin too (phase scales with world time)');

  // --- a paused game freezes the spin; reset() zeros it (no carry-over) ---
  const pc = make(); drive(pc, 60, 0.5, 0, 0, false); const heldSp = pc.Sp;
  pc.Ce = 2; for (let i = 0; i < 30; i++) vm.runInContext('step(' + (1 / 60) + ')', pc);
  ok(pc.Sp === heldSp, 'M: a paused game freezes the horn spin');
  vm.runInContext('reset()', pc);
  ok(pc.Sp === 0, 'M: reset() zeroes the spin phase (fresh run starts unspun)');
}

// ---------- N. crisper steering: quicker to speed AND quicker to stop than the prior rate ----------
// The velocity smoother was tightened (time-constant rate 4.2 -> 5): steering both spins up
// and brakes/recentres faster, WITHOUT overshoot (still exact exponential integration) and
// while keeping the same calm ~23 terminal so it never becomes twitchy.
{
  ok(/kd=1-M\.exp\(-5\*st\)/.test(src), 'N: velocity smoother uses the tightened rate 5 (was 4.2)');
  ok(/px\+=ix\*st-dx\/5/.test(src) && /py\+=iy\*st-dy\/5/.test(src), 'N: analytic position integral divides by the SAME rate 5 (stays frame-independent)');
  const c = make();
  c.IX = 1; c.IY = 0; c.Ce = 1;
  for (let i = 0; i < 18; i++) vm.runInContext('step(' + (1 / 60) + ')', c); // 0.3s hold
  console.log('  N: De after 0.3s hold', c.De.toFixed(3), '(' + (c.De / TERM * 100).toFixed(1) + '% of terminal)');
  ok(c.De >= 0.75 * TERM, 'N: reaches >=75% of terminal within 0.3s (crisper than the old ~72%)');
  ok(c.De < TERM + 1e-6, 'N: still never overshoots terminal (no twitch)');
  const held = c.De;
  drive(c, 60, 0.4, 0, 0, false); // release
  console.log('  N: brakes to', c.De.toFixed(3), '(' + (c.De / held * 100).toFixed(1) + '%) in 0.4s');
  ok(c.De <= 0.15 * held, 'N: brakes/recentres to <=15% within 0.4s of release (quicker than the old ~19%)');
}

// ---------- O. independent, gentler look smoothing -> a stable horizon during maneuvers ----------
// The camera POSITION chases on rate 12 while the LOOK target rides its OWN, independent
// exponential smoother on the gentler rate 6 (coefficient 1-exp(-6e)). Crucially this is a
// self-contained analytic factor, NOT the body's per-frame lerp coefficient scaled by 0.6:
// scaling the body coefficient (the old *T*.6) is frame-rate dependent, whereas an
// independent exponential composes correctly, so the same fixed target over the same wall
// time lands identically at any frame length. A single base q=exp(-6e) supplies both:
// position uses 1-q*q (== 1-exp(-12e), rate 12 unchanged) and the aim uses 1-q (rate 6).
// During a steer the gentler aim trails the body -> stable ship/horizon composition instead
// of a whip-pan, yet both are convergent exponentials -> no permanent lag.
{
  ok(/Ge\[ge\]\+=\(h\[ge\]-Ge\[ge\]\)\*T,/.test(src), 'O: camera position chases at the full smoothing factor T (rate 12)');
  ok(/Ye\[ge\]\+=\(A\[ge\]-Ye\[ge\]\)\*\(1-q\)/.test(src), 'O: look target uses its OWN independent exponential 1-q (not the body coefficient scaled)');
  ok(!/\*T\*\.6/.test(src), 'O: the old frame-dependent *T*.6 aim (scaled body lerp coefficient) is gone');
  ok(/q=M\.exp\(-6\*e\),T=1-q\*q/.test(src), 'O: position rate stays 12 via 1-q*q while the aim base q=exp(-6e) drives the gentler rate 6');

  // Per-frame closure: position closes by exactly its analytic T; the aim closes by exactly
  // its OWN analytic 1-exp(-6e). This is a sampled, moving-target body chase (the body target
  // is re-derived from the ship each frame), so we assert the smoothing COEFFICIENTS the code
  // applies, not an exact settled pose.
  const c = make(); drive(c, 60, 2.0, 0, 0, false);   // settle straight
  const gx0 = c.Ge[0], yx0 = c.Ye[0];
  c.IX = 1; c.IY = 0; c.Ce = 1;
  vm.runInContext('step(' + (1 / 60) + ')', c);        // one steering frame
  const hT = c.px - 9.5 * c.Xe[0];                     // this frame's camera-pos lateral target
  const aT = c.px + 14 * c.Xe[0];                      // this frame's look lateral target
  const gMoved = (c.Ge[0] - gx0) / (hT - gx0);         // fraction the body closed toward its target
  const yMoved = (c.Ye[0] - yx0) / (aT - yx0);         // fraction the aim closed toward its target
  const T = 1 - Math.exp(-12 / 60);
  const aimK = 1 - Math.exp(-6 / 60);                  // the aim's own, independent coefficient
  console.log('  O: pos closed', (gMoved * 100).toFixed(1) + '%  look closed', (yMoved * 100).toFixed(1) + '% of target this frame');
  near(gMoved, T, 1e-6, 'O: camera position closes by exactly T = 1-exp(-12e) toward its target');
  near(yMoved, aimK, 1e-6, 'O: look target closes by exactly its own 1-exp(-6e) (independent, gentler)');
  ok(yMoved < gMoved, 'O: the aim lags the body mid-maneuver -> a steadier horizon, not a whip-pan');

  // Frame-independence regression (the actual review fix): for a FIXED look target held over a
  // FIXED wall-clock time, an independent exponential must leave the SAME residual gap no matter
  // how finely we subdivide the time. We settle straight (target frozen at py+14*Xe[1]-.2 with
  // px,py,Xe stationary under zero input), inject a known gap, coast the same 0.5s at several
  // frame lengths, and require an identical residual == exp(-6*0.5) of that gap. The old *T*.6
  // aim would drift apart across these rates; the independent exponential does not.
  const HOLD = 0.5, WANT = Math.exp(-6 * HOLD);
  function aimResidual(dt) {
    const s = make(); drive(s, 60, 2.0, 0, 0, false); // freeze the look target
    const A1 = s.py + 14 * s.Xe[1] - 0.2;             // the now-fixed vertical look target
    s.Ye[1] = A1 + 1;                                 // inject a unit gap to measure decay of
    const n = Math.round(HOLD / dt);
    for (let i = 0; i < n; i++) vm.runInContext('step(' + dt + ')', s);
    return s.Ye[1] - (s.py + 14 * s.Xe[1] - 0.2);     // remaining gap (target stayed fixed)
  }
  const rates = [20, 30, 60, 144, 300];
  const residuals = rates.map(hz => aimResidual(1 / hz));
  console.log('  O: fixed-target aim residual over ' + HOLD + 's @ ' + rates.join('/') + 'Hz =',
    residuals.map(r => r.toFixed(6)).join(', '), '(want ' + WANT.toFixed(6) + ')');
  residuals.forEach((r, i) => near(r, WANT, 1e-6,
    'O: aim residual at ' + rates[i] + 'Hz matches exp(-6*t) exactly (frame-independent damping)'));
  near(Math.max(...residuals) - Math.min(...residuals), 0, 1e-9,
    'O: the fixed-target aim residual is identical across all frame lengths (independent exponential, not scaled lerp)');

  // convergence: after a maneuver + long coast the aim still fully settles (no permanent lag)
  const s = make(); drive(s, 60, 0.5, 1, 0, false); drive(s, 60, 4, 0, 0, false);
  near(s.Ye[1] - s.py, -0.2, 1e-3, 'O: the independently-smoothed aim fully converges after coasting (no residual lag)');
}

console.log('\nflight tests: ' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
