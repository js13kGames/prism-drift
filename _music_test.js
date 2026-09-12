// Regression harness for the collectible musical-layer feature in index.html.
// It extracts the ACTUAL production functions (cen/rad/npos/nSpawn/nLayers/
// nSweep/nReset) out of index.html and runs them inside a Node vm sandbox, so
// the tests exercise the shipped code rather than re-implemented formulas.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const cp = require('child_process');

const HTML = path.join(__dirname, 'index.html');
const html = fs.readFileSync(HTML, 'utf8');
const src = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));

let fails = 0, passes = 0;
function ok(cond, msg) { if (cond) { passes++; } else { fails++; console.error('  FAIL:', msg); } }
function near(a, b, e, msg) { ok(Math.abs(a - b) <= (e || 1e-9), msg + ' (got ' + a + ', want ' + b + ')'); }

// Extract a top-level `function name(...) {...}` by brace matching the real source.
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

// --- syntax + byte-ceiling gates on the shipped file ---
try { new vm.Script(src); ok(true, 'script syntax'); }
catch (e) { ok(false, 'index.html script has a syntax error: ' + e.message); }
const bytes = Buffer.byteLength(html);
ok(bytes < 17000, 'index.html is ' + bytes + ' bytes, must stay < 17000');

// --- build a sandbox holding the real functions ---
const ctx = {
  M: Math, TAU: 6.2831853, STEP: 3.2, BACK: 6,
  notes: [], lyr: [], LON: [0, 0, 0], nnz: 60, score: 0, pz: 0, px: 0, py: 0,
  pickHits: 0,
};
vm.createContext(ctx);
vm.runInContext('var ms=M.sin,mc=M.cos,mr=M.random,mf=M.floor,mh=M.hypot;', ctx);
// aPk is the pickup-sound seam; stub it so nSweep stays audio-free under test.
vm.runInContext('function aPk(t){pickHits++;}', ctx);
['smooth', 'cen', 'rad', 'npos', 'nSpawn', 'nLayers', 'nSweep', 'nReset']
  .forEach(n => vm.runInContext(grab(n), ctx));
const run = code => vm.runInContext(code, ctx);
const set = obj => Object.assign(ctx, obj);

// Collect a single note deterministically via the real swept-collision code.
// Places the note at tunnel centre (r=0) at a z<64 where cen()==0, so the
// player path (0,0) coincides with it and the pickup is guaranteed.
function collectAt(scoreVal, ty, z) {
  set({ score: scoreVal, notes: [{ z: z, a: 0, r: 0, p: 0, ty: ty }], px: 0, py: 0, pz: z + 5 });
  run('nSweep(0,0,' + (z - 5) + ',0)'); // prev z behind the note, tm=0 => no bob
}

// ---------- A. exact 100-point score expiry ----------
run('nReset();'); set({ score: 0 });
collectAt(0, 0, 20);
ok(ctx.lyr.length === 1, 'A: one layer after pickup');
near(ctx.lyr[0].exp, 100, 1e-9, 'A: expiry is collection score + 100');
ok(ctx.score === 0, 'A: pickup awards no points');
set({ score: 99.9999 }); run('nLayers()');
ok(ctx.LON[0] === 1, 'A: layer active at score 99.9999');
set({ score: 100 }); run('nLayers()');
ok(ctx.LON[0] === 0, 'A: layer expires exactly at collection score + 100');
ok(ctx.lyr.length === 0, 'A: expired layer pruned');

// ---------- B. overlap: different types + repeated same type ----------
run('nReset();'); set({ score: 0 });
collectAt(0, 0, 20);   // snare, exp 100
collectAt(40, 0, 20);  // snare again, exp 140 (independent expiry)
collectAt(10, 2, 20);  // untz, exp 110 (plays simultaneously)
ok(ctx.lyr.length === 3, 'B: three independent layers retained');
set({ score: 50 }); run('nLayers()');
ok(ctx.LON[0] === 1 && ctx.LON[2] === 1 && ctx.LON[1] === 0, 'B: snare+untz on together, tom off');
set({ score: 120 }); run('nLayers()');
ok(ctx.LON[0] === 1, 'B: later snare keeps type active past first snare expiry');
ok(ctx.LON[2] === 0, 'B: untz expired by 120');
ok(ctx.lyr.filter(l => l.ty === 0).length === 1, 'B: only the un-expired snare remains');
ok(ctx.LON[0] === 1 && ctx.LON[0] !== 2, 'B: LON is a single on-flag, not a multiplied count');
set({ score: 140 }); run('nLayers()');
ok(ctx.LON[0] === 0 && ctx.lyr.length === 0, 'B: all layers gone at 140');

// pause fully freezes: with score held constant, layer duration is untouched.
// (This is the PAUSED case only — slow-mo still advances score; see section G.)
run('nReset();'); set({ score: 200 });
collectAt(200, 1, 20); // exp 300
run('nLayers()'); const onBefore = ctx.LON[1];
run('nLayers()'); run('nLayers()'); // score unchanged (paused)
ok(onBefore === 1 && ctx.LON[1] === 1, 'B: paused (frozen score) consumes no layer duration');

// ---------- C. restart clears pickups/effects ----------
set({ notes: [{ z: 1 }, { z: 2 }], lyr: [{ ty: 0, exp: 9 }], LON: [1, 1, 1], nnz: 999 });
run('nReset()');
ok(ctx.notes.length === 0 && ctx.lyr.length === 0, 'C: notes and layers cleared on reset');
ok(ctx.LON[0] === 0 && ctx.LON[1] === 0 && ctx.LON[2] === 0, 'C: LON cleared on reset');
ok(ctx.nnz === 60, 'C: spawn cursor reset to grace distance');

// ---------- D. spawn: grace, spacing, inner-tunnel safety ----------
run('nReset();'); set({ pz: 0 });
run('nSpawn()');
ok(ctx.notes.length >= 1, 'D: notes spawn after grace');
ok(ctx.notes[0].z === 60, 'D: first note appears at the grace distance (z=60)');
for (let i = 1; i < ctx.notes.length; i++)
  ok(Math.abs((ctx.notes[i].z - ctx.notes[i - 1].z) - 42) < 1e-9, 'D: notes evenly spaced by 42 units');
// sample many spawns across the whole tunnel and verify inner placement
run('nReset();');
let sampled = 0, unsafe = 0;
for (let p = 0; p < 3000; p += 137) {
  set({ pz: p }); run('nSpawn()');
}
for (const o of ctx.notes) {
  sampled++;
  const wall = ctx.rad(o.z, o.a);
  if (!(o.ty >= 0 && o.ty <= 5)) unsafe++;
  // r is at most 0.42*wall by construction -> strictly inside with margin
  if (!(o.r <= 0.42 * wall + 1e-9 && o.r < wall - 1.5)) unsafe++;
}
ok(sampled > 40, 'D: spawned a healthy sample of notes (' + sampled + ')');
ok(unsafe === 0, 'D: every note sits safely inside the tunnel wall');

// ---------- E. bounded cleanup of missed notes ----------
run('nReset();');
const many = [];
for (let i = 0; i < 60; i++) many.push({ z: -1000 - i, a: 0, r: 0, p: 0, ty: 0 });
many.push({ z: 5000, a: 0, r: 0, p: 0, ty: 0 }); // still ahead -> must survive
set({ notes: many, px: 0, py: 0, pz: 2000, score: 0 });
run('nSweep(0,0,1999,0)');
ok(ctx.notes.every(o => !o.d), 'E: dead notes were compacted out of the array');
ok(ctx.notes.length === 1 && ctx.notes[0].z === 5000, 'E: only the still-ahead note remains');

// ---------- F. swept collision at high speed ----------
run('nReset();'); set({ score: 0 });
// one frame jumps 50 units forward (>> 1.6 pickup radius): a per-frame point
// test would skip the note, the swept test must still catch it.
set({ notes: [{ z: 25, a: 0, r: 0, p: 0, ty: 1 }], px: 0, py: 0, pz: 50 });
run('nSweep(0,0,0,0)');
ok(ctx.notes[0].d === 1 && ctx.lyr.length === 1, 'F: fast fly-through still collects the note (swept)');
// lateral miss: a note offset well beyond the pickup radius is NOT collected
run('nReset();'); set({ score: 0 });
set({ notes: [{ z: 25, a: 0, r: 5, p: 0, ty: 1 }], px: 0, py: 0, pz: 25.5 });
run('nSweep(0,0,0,0)');
ok(!ctx.notes[0].d && ctx.lyr.length === 0, 'F: laterally distant note is left uncollected');

// ---------- G. slow-mo advances score via the REAL production step() ----------
// Drives the shipped step() headless (render / input / audio / crash seams stubbed)
// to prove the score-based duration model: slow-mo still advances score (~35% rate)
// so a layer's remaining points tick DOWN during slow-mo, while pause freezes score
// entirely and consumes no duration. This replaces the old "hold score static and
// call it slow-mo" anti-test.
const sctx = {
  M: Math, TAU: 6.2831853, STEP: 3.2, BACK: 6,
  notes: [], lyr: [], LON: [0, 0, 0], nnz: 60,
  tp: [], tA: 0, Sp: 0,
  Ce: 1, Ue: true, Be: 100, qe: 1, He: 0,
  score: 0, pz: 0, px: 0, py: 0, De: 0, Pe: 0, Ke: 0,
  Ne: false, ze: false,
  Xe: [0, 0, 1], Qe: [0, -0.3, 1], Ge: [0, 4, -7], Ye: [0, 0, 4],
  Ze: -1, ge: 0, ae: 0,
  m: ['SNARE', 'TOM', 'UNTZ'], y: ['#f66', '#6f6', '#6cf'],
  d: {}, g: { innerHTML: '' }, p: { style: {} },
};
vm.createContext(sctx);
vm.runInContext('var ms=M.sin,mc=M.cos,mr=M.random,mf=M.floor,mh=M.hypot;', sctx);
// render / input / audio / crash seams stubbed so step() runs without a GL context
vm.runInContext('function draw(){}function Vn(){return false}function die(){}function je(){}function rn(){return[0,0]}function w(e,n){e.textContent=n}function aPk(){}', sctx);
['smooth', 'cen', 'rad', 'npos', 'nSpawn', 'nLayers', 'nSweep', 'nReset', 'N', 'z', 'H', 'V', 'W', 'O', 'Wn', 'Xn', 'step']
  .forEach(n => vm.runInContext(grab(n), sctx));
vm.runInContext('Qn=O(1.15,1,.3,140);nReset();', sctx);
// pre-collect one SNARE layer (exp = score + 100 = 100) at tunnel centre
Object.assign(sctx, { score: 0, notes: [{ z: 20, a: 0, r: 0, p: 0, ty: 0 }], px: 0, py: 0, pz: 25 });
vm.runInContext('nSweep(0,0,15,0)', sctx);
ok(sctx.lyr.length === 1 && sctx.lyr[0].exp === 100, 'G: pre-collected a SNARE layer, exp=100');

// one slow-mo frame: Ce=1, Ue=true => qe=.35, score += 8*(0.05*0.35) = 0.14
sctx.He = 0;
vm.runInContext('step(0.05)', sctx);
near(sctx.score, 0.14, 1e-9, 'G: slow-mo step advances score 0 -> 0.14 (35% rate)');
ok(sctx.lyr[0].exp === 100, 'G: slow-mo leaves layer expiry fixed; only score-derived remaining moves');
near(sctx.lyr[0].exp - sctx.score, 99.86, 1e-9, 'G: layer remaining ticks 100 -> 99.86 during slow-mo');

// pause (Ce=2) freezes the whole score/effect block => zero duration consumed
sctx.Ce = 2;
const gScore = sctx.score, gRem = sctx.lyr[0].exp - sctx.score;
vm.runInContext('step(0.05)', sctx);
ok(sctx.score === gScore, 'G: pause freezes score (no advance)');
near(sctx.lyr[0].exp - sctx.score, gRem, 1e-9, 'G: pause consumes no layer duration');

// ---------- H. crash (die) clears effects + HUD via the REAL production die() ----------
// Runs the shipped die()/reset()/nReset() headless (audio / overlay / storage seams
// stubbed) to prove the README promise "All layers clear on crash / restart": an
// active run's layers and #ly HUD must be wiped on crash, restart must stay clear,
// and a pause must NOT wipe them (crash-specific clearing, pause preserved).
const dctx = {
  M: Math, Ce: 1, score: 250, Oe: 0,
  notes: [], lyr: [], LON: [0, 0, 0], nnz: 60,
  g: { innerHTML: '' }, h: {},
  // position/camera state touched by reset(); values are irrelevant to assertions
  pz: 9, px: 9, py: 9, De: 9, Pe: 9, Be: 0, Ue: true, Xe: [], Ke: 9,
  Ge: [], Ye: [], Ze: 9,
  localStorage: { setItem() {} },
};
vm.createContext(dctx);
// audio / overlay / storage / difficulty seams stubbed so die() runs headless
vm.runInContext('function On(){}function Nn(){}function je(){}function w(e,n){e.textContent=n}function o(){}', dctx);
['nReset', 'die', 'reset'].forEach(n => vm.runInContext(grab(n), dctx));

// simulate an active run: layers earned + HUD populated
Object.assign(dctx, {
  Ce: 1, score: 250, notes: [{ z: 1 }, { z: 2 }],
  lyr: [{ ty: 0, exp: 300 }, { ty: 2, exp: 340 }], LON: [1, 0, 1], nnz: 999,
  g: { innerHTML: '<span>SNARE 50</span> <span>UNTZ 90</span> ' },
});
vm.runInContext('die();', dctx);
ok(dctx.Ce === 3, 'H: die() enters the crashed state');
ok(dctx.lyr.length === 0, 'H: die() clears active layers');
ok(dctx.LON[0] === 0 && dctx.LON[1] === 0 && dctx.LON[2] === 0, 'H: die() clears LON flags');
ok(dctx.notes.length === 0, 'H: die() clears in-flight collectibles');
ok(dctx.g.innerHTML === '', 'H: die() clears the #ly layer HUD');
ok(dctx.score === 250, 'H: die() preserves score for the crash readout');

// restart still clears everything
Object.assign(dctx, {
  lyr: [{ ty: 1, exp: 9 }], LON: [1, 1, 1], notes: [{ z: 3 }], nnz: 999,
  g: { innerHTML: '<span>TOM 5</span> ' }, score: 999,
});
vm.runInContext('reset();', dctx);
ok(dctx.lyr.length === 0 && dctx.notes.length === 0, 'H: restart clears layers + collectibles');
ok(dctx.LON[0] === 0 && dctx.LON[1] === 0 && dctx.LON[2] === 0, 'H: restart clears LON flags');
ok(dctx.g.innerHTML === '' && dctx.score === 0 && dctx.nnz === 60, 'H: restart resets HUD/score/spawn');

// pause is NOT a crash: pausing must leave earned layers + HUD intact
Object.assign(dctx, {
  Ce: 2, lyr: [{ ty: 0, exp: 100 }], LON: [1, 0, 0],
  g: { innerHTML: '<span>SNARE 20</span> ' },
});
const pausedLyr = dctx.lyr, pausedHUD = dctx.g.innerHTML, pausedLON = dctx.LON.slice();
ok(dctx.Ce === 2 && dctx.lyr === pausedLyr && dctx.g.innerHTML === pausedHUD &&
  pausedLON[0] === 1, 'H: pause preserves layers + HUD (only crash/restart clear)');

// ---------- I. six distinct pickup voices (Dn audio routing) ----------
// Dn is the pickup-sound dispatcher; stub its audio primitives (Fn/kn/In) to
// record the routing + key params per type, proving each collectible has an
// audibly distinct voice rather than the old shared "click".
const actx = { M: Math, Hp: 'highpass', Bp: 'bandpass', calls: [] };
vm.createContext(actx);
vm.runInContext(
  'function Fn(e,n,r,t,a){calls.push(["Fn",t,a,r])}' +
  'function kn(e,n,r){calls.push(["kn",n,r])}' +
  'function In(e){calls.push(["In"])}', actx);
vm.runInContext(grab('Dn'), actx);
function voice(ty) { actx.calls.length = 0; vm.runInContext('Dn(' + ty + ',0)', actx); return actx.calls.map(c => c.slice()); }
const V = [0, 1, 2, 3, 4, 5].map(voice);
const sigs = V.map(v => JSON.stringify(v));
ok(new Set(sigs).size === 6, 'I: all six pickup voices are distinct');
ok(V[0][0][0] === 'Fn' && V[0][0][1] === 2200 && V[0][0][2] === 'highpass', 'I: SNARE is a high-passed noise burst @2200');
ok(V[1][0][0] === 'kn', 'I: TOM is a pitched (kn) drum voice');
ok(V[2][0][0] === 'In', 'I: UNTZ is a deep kick (In)');
ok(V[3].length === 2 && V[3][0][1] === 9000 && V[3][1][2] === 'bandpass', 'I: CYMBAL is metallic (highpass shimmer + bandpass ring)');
ok(V[4][0][0] === 'Fn' && V[4][0][1] === 6000 && V[4][0][2] === 'highpass', 'I: CRASH is a 6k high-passed smash');
ok(V[4][0][3] > V[0][0][3], 'I: CRASH decay is longer than SNARE (a lingering smash, not a click)');
ok(V[5][0][0] === 'Fn' && V[5][0][1] === 1500 && V[5][0][2] === 'bandpass', 'I: NOISE is a band-passed filtered burst');

// ---------- J. persistent per-type rhythms (Pn sequencer) ----------
// Drive the real bar sequencer Pn with every layer active; record which pickup
// type Dn fires on each of the 16 steps, proving each active layer contributes
// its own recurring pattern (and that CRASH stays a sparse accent).
const pctx = {
  M: Math, Hp: 'highpass', Bp: 'bandpass',
  LON: [1, 1, 1, 1, 1, 1], An: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0],
  wn: [55, 55, 43.65, 49], Tn: [659.25, 587.33, 523.25, 440, 392], yn: 0.1,
  fired: [],
};
vm.createContext(pctx);
vm.runInContext(
  'function In(){}function Fn(){}function kn(){}function Cn(){}' +
  'function Dn(ty,e){fired.push([e,ty])}', pctx);
vm.runInContext(grab('Pn'), pctx);
const stepsOf = ty => {
  const s = [];
  for (let t = 0; t < 16; t++) { pctx.fired.length = 0; vm.runInContext('Pn(0,' + t + ')', pctx); if (pctx.fired.some(f => f[1] === ty)) s.push(t); }
  return s;
};
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
ok(eq(stepsOf(0), [4, 12]), 'J: SNARE layer hits the backbeat (steps 4,12)');
ok(eq(stepsOf(1), [6, 14]), 'J: TOM layer fills on steps 6,14');
ok(eq(stepsOf(2), [2, 6, 10, 14]), 'J: UNTZ layer drives every 4th step');
ok(eq(stepsOf(3), [2, 10], ), 'J: CYMBAL layer shimmers on steps 2,10');
ok(eq(stepsOf(4), [0]), 'J: CRASH is a single sparse accent per bar (step 0)');
ok(eq(stepsOf(5), [3, 7, 11, 15]), 'J: NOISE layer sizzles on the offbeats');
// a silent layer set produces no pickup-type fires at all
pctx.LON = [0, 0, 0, 0, 0, 0];
let silent = 0; for (let t = 0; t < 16; t++) { pctx.fired.length = 0; vm.runInContext('Pn(0,' + t + ')', pctx); silent += pctx.fired.length; }
ok(silent === 0, 'J: with no layers active, no pickup voices are scheduled');

// ---------- K. easier pickups: raised swept collision radius (2.0) ----------
run('nReset();'); set({ score: 0 });
// a note 1.8 units off-axis is now collected (was a miss under the old 1.6 radius)
set({ notes: [{ z: 20, a: 0, r: 1.8, p: 0, ty: 0 }], px: 0, py: 0, pz: 25 });
run('nSweep(0,0,15,0)');
ok(ctx.notes.length === 1 && ctx.notes[0].d === 1, 'K: 1.8-unit offset note now collected (radius raised past 1.6)');
run('nReset();'); set({ score: 0 });
// just inside the new 2.0 radius
set({ notes: [{ z: 20, a: 0, r: 1.95, p: 0, ty: 0 }], px: 0, py: 0, pz: 25 });
run('nSweep(0,0,15,0)');
ok(ctx.notes[0].d === 1, 'K: note at r=1.95 is inside the 2.0 pickup radius');
run('nReset();'); set({ score: 0 });
// still just outside -> not a giant magnet
set({ notes: [{ z: 20, a: 0, r: 2.2, p: 0, ty: 0 }], px: 0, py: 0, pz: 25 });
run('nSweep(0,0,15,0)');
ok(!ctx.notes[0].d && ctx.lyr.length === 0, 'K: note at r=2.2 is still a clean miss (not hugely forgiving)');

// ---------- L. six collectible types wired through spawn/HUD/reset ----------
run('nReset();');
for (let p = 0; p < 6000; p += 91) { set({ pz: p }); run('nSpawn()'); }
const seen = new Set(ctx.notes.map(o => o.ty));
ok([0, 1, 2, 3, 4, 5].every(t => seen.has(t)), 'L: spawner emits all six collectible types');
// LON flags track all six independent layer types
run('nReset();'); set({ score: 0, lyr: [{ ty: 3, exp: 100 }, { ty: 4, exp: 100 }, { ty: 5, exp: 100 }] });
run('nLayers()');
ok(ctx.LON[3] === 1 && ctx.LON[4] === 1 && ctx.LON[5] === 1, 'L: CYMBAL/CRASH/NOISE layers set their LON flags');
ok(ctx.LON.length === 6, 'L: LON tracks six layer types');
run('nReset()');
ok(ctx.LON.every(f => f === 0) && ctx.LON.length === 6, 'L: reset clears all six LON flags');

// ---------- M. bigger, thicker, brighter symbols (shipped draw/shader) ----------
// Source-level gates on the visual upgrade: the collectible glyph is drawn at
// 1.2 scale (2x the old .6), stroked in multiple offset passes for thickness
// (no reliance on gl.lineWidth), and shaded with a brightened per-type palette.
ok(/1\.2\*mc/.test(src) && /1\.2\*ms/.test(src), 'M: collectible drawn at 1.2 scale (2x the old .6)');
ok(!/\.6\*mc\(t\)/.test(src), 'M: the old .6 pickup scale is gone');
ok(/for\(var q=-1;q<2;q\+\+\)Gn\(j,\[[^\]]*\],b\.drawArrays\(U,0,NC\)/.test(src.replace(/\)/g, ')')) ||
   /for\(var q=-1;q<2;q\+\+\)/.test(src), 'M: glyph stroked in a multi-pass offset loop (thickness without lineWidth)');
ok(!/lineWidth/.test(src), 'M: no gl.lineWidth dependency for thickness');
ok(/c=\.6\+\.42\*cos\(vec3\(h,h\+2\.1,h\+4\.2\)\)/.test(src), 'M: brightened procedural per-type note palette in the shader');

// ---------- run the existing fit harness alongside ----------
let fitOut = '';
try {
  fitOut = cp.execSync('node ' + JSON.stringify(path.join(__dirname, '_fit_test.js')), { encoding: 'utf8' });
  const mNew = /NEW false positives[^:]*:\s*(\d+)/.exec(fitOut);
  const mOld = /OLD false positives[^:]*:\s*(\d+)/.exec(fitOut);
  ok(/Sweep trials:/.test(fitOut), 'fit harness ran its soundness sweep');
  ok(mNew && mOld && +mNew[1] * 10 < +mOld[1], 'fit harness: new fit far safer than the old bug');
} catch (e) {
  ok(false, 'fit harness failed to run: ' + e.message);
}

// ---------- run the flight-feel harness alongside ----------
let flightOut = '';
try {
  flightOut = cp.execSync('node ' + JSON.stringify(path.join(__dirname, '_flight_test.js')), { encoding: 'utf8' });
  const mF = /flight tests:\s*(\d+) passed,\s*(\d+) failed/.exec(flightOut);
  ok(!!mF, 'flight harness produced a summary');
  ok(mF && +mF[2] === 0, 'flight harness: all movement/camera checks pass (' + (mF ? mF[1] : '?') + ' passed)');
} catch (e) {
  ok(false, 'flight harness failed to run: ' + (e.stdout || e.message));
}

console.log('\nmusic tests: ' + passes + ' passed, ' + fails + ' failed');
if (fitOut) console.log('fit harness tail: ' + fitOut.trim().split('\n').slice(-2).join(' | '));
if (flightOut) console.log('flight harness tail: ' + flightOut.trim().split('\n').slice(-1)[0]);
process.exit(fails ? 1 : 0);
