#!/usr/bin/env node
// Render the #demo tour frame by frame through headless Chrome (raw CDP over WebSocket) and encode it.
//   node scripts/record-demo.mjs [--url http://localhost:5209/] [--fps 30] [--render-fps 15] [--workers 4] [--port 9339]
// Each worker tab loads the app with ?demo&record, waits for "simulated in", then for every frame calls
// __demo.frame(t) and Page.captureScreenshot. ffmpeg (path in /tmp/claude-ship/ff/path.txt, or on PATH)
// encodes demo/2soon2026-demo-60s-raw.mp4 (the app, full bleed) and demo/2soon2026-demo-60s.mp4 (framed
// at 80% on a gradient with a soft shadow and a thin border).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const URL_BASE = arg('url', 'http://localhost:5209/');
const FPS = Number(arg('fps', 30)), RFPS = Number(arg('render-fps', 15)), WORKERS = Number(arg('workers', 4));
const PORT = Number(arg('port', 9339)), DUR = Number(arg('duration', 60));
const W = 1536, H = 864, OW = 1920, OH = 1080;
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = path.join(root, 'demo'), tmp = arg('tmp', '/tmp/2soon-demo-frames');
fs.mkdirSync(outDir, { recursive: true }); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ffmpegBin() {
  for (let i = 0; i < 60; i++) {
    try { const p = fs.readFileSync('/tmp/claude-ship/ff/path.txt', 'utf8').trim(); if (p && fs.existsSync(p)) return p; } catch { /* not yet */ }
    try { return execFileSync('which', ['ffmpeg']).toString().trim(); } catch { /* not yet */ }
    execFileSync('sleep', ['5']);
  }
  throw new Error('no ffmpeg');
}

async function launchChrome(angle) {
  const bin = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const flags = angle === 'metal' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const p = spawn(bin, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/2soon-demo-chrome-${angle}`, '--no-first-run', '--hide-scrollbars', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--window-size=${W},${H}`, ...flags, 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); return p; } catch { await sleep(200); } }
  throw new Error('chrome did not start');
}

async function tab() {
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') console.error('page exception:', m.params.exceptionDetails.exception?.description?.slice(0, 300));
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return { send, ev, close: () => fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`) };
}

async function openApp(t) {
  await t.send('Page.navigate', { url: `${URL_BASE}?demo&record#demo` });
  for (let i = 0; i < 600; i++) {
    await sleep(250);
    const ok = await t.ev(`!!(window.__demo && window.__demo.ready())`);
    if (ok) break;
  }
  return t.ev(`(()=>{const c=document.createElement('canvas').getContext('webgl2');return c?c.getParameter(c.RENDERER):'none'})()`);
}

const shot = async (t, file) => { const s = await t.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 }); fs.writeFileSync(file, Buffer.from(s.result.data, 'base64')); };

// ------------------------------------------------------------------ render
let chrome = await launchChrome('metal');
let probe = await tab();
let gl = await openApp(probe);
console.log('renderer:', gl);
if (!gl || gl === 'none') {
  await probe.close(); chrome.kill(); await sleep(500);
  chrome = await launchChrome('swiftshader'); probe = await tab(); gl = await openApp(probe); console.log('fallback renderer:', gl);
}
const N = Math.round(DUR * RFPS);
const per = Math.ceil(N / WORKERS);
const tabs = [probe];
for (let w = 1; w < WORKERS; w++) { const t = await tab(); await openApp(t); tabs.push(t); }
const t0 = Date.now(); let done = 0;
await Promise.all(tabs.map(async (t, w) => {
  const a = w * per, b = Math.min(N, a + per);
  // warm up into the range so continuous state (lastT, beat) is right
  if (a > 0) await t.ev(`__demo.frame(${((a - 1) / RFPS).toFixed(4)})`);
  for (let f = a; f < b; f++) {
    await t.ev(`__demo.frame(${(f / RFPS).toFixed(4)})`);
    await shot(t, path.join(tmp, `f${String(f).padStart(5, '0')}.jpg`));
    if (++done % 30 === 0) console.log(`${done}/${N} frames, ${((Date.now() - t0) / done).toFixed(0)} ms/frame`);
  }
}));
for (const t of tabs) await t.close();

// ------------------------------------------------------------------ the frame's backdrop: gradient, shadow, border (drawn by Chrome once)
const bg = await tab();
await bg.send('Emulation.setDeviceMetricsOverride', { width: OW, height: OH, deviceScaleFactor: 1, mobile: false });
const fw = W, fh = H, fx = (OW - fw) / 2, fy = (OH - fh) / 2;
const html = `<html><body style="margin:0;width:${OW}px;height:${OH}px;overflow:hidden;background:
  radial-gradient(1200px 800px at 15% 10%, rgba(76,52,170,0.55), transparent 60%),
  radial-gradient(1000px 700px at 90% 90%, rgba(20,150,160,0.45), transparent 60%),
  radial-gradient(900px 600px at 85% 15%, rgba(130,60,180,0.35), transparent 60%),
  linear-gradient(135deg,#17123a 0%,#10284a 50%,#231446 100%)">
  <div style="position:absolute;left:${fx - 1}px;top:${fy - 1}px;width:${fw + 2}px;height:${fh + 2}px;border-radius:14px;background:#000;
    box-shadow:0 40px 120px rgba(0,0,0,0.55),0 12px 40px rgba(0,0,0,0.45),0 0 0 1px rgba(255,255,255,0.16)"></div></body></html>`;
await bg.send('Page.navigate', { url: `data:text/html,${encodeURIComponent(html)}` });
await sleep(800);
const bgShot = await bg.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(tmp, 'bg.png'), Buffer.from(bgShot.result.data, 'base64'));
await bg.close();
chrome.kill();

// ------------------------------------------------------------------ encode
const ff = ffmpegBin();
const up = RFPS === FPS ? '' : `,minterpolate=fps=${FPS}:mi_mode=blend`;
const raw = path.join(outDir, '2soon2026-demo-60s-raw.mp4'), framed = path.join(outDir, '2soon2026-demo-60s.mp4');
const enc = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart'];
execFileSync(ff, ['-y', '-framerate', String(RFPS), '-i', path.join(tmp, 'f%05d.jpg'), '-vf', `format=yuv420p${up}`, '-t', String(DUR), ...enc, raw], { stdio: 'inherit' });
// rounded inner corners: a mask of the frame, so the app sits in the backdrop's rounded black card
execFileSync(ff, ['-y', '-loop', '1', '-i', path.join(tmp, 'bg.png'), '-i', raw, '-filter_complex',
  `[1:v]format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(gt(abs(X-W/2)-(W/2-13),0)*gt(abs(Y-H/2)-(H/2-13),0),if(lte(hypot(abs(X-W/2)-(W/2-13),abs(Y-H/2)-(H/2-13)),13),255,0),255)'[app];[0:v][app]overlay=${fx}:${fy}:shortest=1,format=yuv420p`,
  '-t', String(DUR), ...enc, framed], { stdio: 'inherit' });
for (const f of [raw, framed]) console.log(f, (fs.statSync(f).size / 1e6).toFixed(1), 'MB');
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(0);
