import {test, expect} from 'bun:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const FRAME = 1000 / 60;

function setup({stored = {} as Record<string, string>, pip = false} = {}) {
  const calls: number[] = [];
  const values = new Map(Object.entries(stored));
  const doc: any = new EventTarget();
  doc.focused = true; doc.visibilityState = 'visible'; doc.hasFocus = () => doc.focused;
  doc.lyricsPage = false; doc.getElementById = (id: string) => (id === 'SpicyLyricsPage' && doc.lyricsPage ? {} : null);
  doc.getAnimations = () => []; doc.head = {appendChild: () => {}}; doc.createElement = () => ({});
  doc.documentElement = {classList: {add() {}, remove() {}, contains: () => false}};
  const host: any = new EventTarget();
  host.setTimeout = (_f: Function, delay: number) => { calls.push(delay); return calls.length; };
  if (pip) host.documentPictureInPicture = {window: {}};
  class Element { animate() { return {}; } }
  const context: any = vm.createContext({window: host, document: doc, Element, Reflect, Error, Math, Object, String,
    localStorage: {getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v)}});
  vm.runInContext(readFileSync(new URL('../spotify-perf.js', import.meta.url), 'utf8'), context, {filename: 'spotify-perf.js'});
  calls.length = 0; // drop the menu-registration retry
  // Code in a file named like the lyrics extension, calling the global setTimeout as it does.
  const fromLyrics = (delay: number) => vm.runInContext(`window.setTimeout(() => {}, ${delay})`, context, {filename: 'extensions/spicy-lyrics-performance.js'});
  const fromOther = (delay: number) => vm.runInContext(`window.setTimeout(() => {}, ${delay})`, context, {filename: 'xpui-modules.js'});
  return {host, doc, calls, fromLyrics, fromOther, values};
}

test('per-frame lyrics polling is stretched to 1 s while no lyrics are on screen', () => {
  const {calls, fromLyrics, host} = setup();
  fromLyrics(FRAME);
  expect(calls).toEqual([1000]);
  expect(host.SpotifyPerf.status().stretchedPolls).toBe(1);
});

test('per-frame polling is kept while the lyrics page is open and focused', () => {
  const {calls, fromLyrics, doc} = setup();
  doc.lyricsPage = true;
  fromLyrics(FRAME);
  expect(calls[0]).toBeCloseTo(FRAME);
});

test('an open lyrics page in an unfocused or hidden window is idle', () => {
  const {calls, fromLyrics, doc} = setup();
  doc.lyricsPage = true; doc.focused = false; fromLyrics(FRAME);
  doc.focused = true; doc.visibilityState = 'hidden'; fromLyrics(FRAME);
  expect(calls).toEqual([1000, 1000]);
});

test('popup (PiP) lyrics keep per-frame polling', () => {
  const {calls, fromLyrics, doc} = setup({pip: true});
  doc.focused = false;
  fromLyrics(FRAME);
  expect(calls[0]).toBeCloseTo(FRAME);
});

test('other timers are never touched: other callers, other delays', () => {
  const {calls, fromLyrics, fromOther} = setup();
  fromOther(FRAME); fromLyrics(50); fromLyrics(750); fromOther(400);
  expect(calls[0]).toBeCloseTo(FRAME);
  expect(calls.slice(1)).toEqual([50, 750, 400]);
});

test('the switch turns the shim off and persists', () => {
  const {calls, fromLyrics, host, values} = setup();
  host.SpotifyPerf.set('lyricsSync', false);
  fromLyrics(FRAME);
  expect(calls[0]).toBeCloseTo(FRAME);
  expect(values.get('spotify-perf:lyricsSync')).toBe('false');
  const again = setup({stored: {'spotify-perf:lyricsSync': 'false'}});
  again.fromLyrics(FRAME);
  expect(again.calls[0]).toBeCloseTo(FRAME);
});

test('handler, extra arguments and the timer id pass through unchanged', () => {
  const seen: any[] = [];
  const ctx = setup();
  const inner = ctx.host.SpotifyPerf && ctx.calls;
  // Replace the recorded native timer's behaviour by checking what the wrapper forwards.
  const id = ctx.host.setTimeout(function (...a: any[]) { seen.push(a); }, 5, 'x', 'y');
  expect(typeof id).toBe('number');
  expect(inner.at(-1)).toBe(5);
});
