// Songless Unlimited: guess a song from the first 0.1 s, 0.7 s, 2 s, ... of it.
// Audio comes from the Spotify Web Playback SDK (Premium only). Login uses PKCE,
// so the client secret is never needed in the browser.

const CLIENT_ID = '2eb6f769c3bd4297a445fc13a4311b33';
const REDIRECT_URI = location.origin + location.pathname;
const SCOPES = 'streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state';
const DEFAULT_PLAYLIST = '6QAKnenuZoowNqxRzZbeRg'; // "Guess that Tune." by Ben
const STEPS = [100, 700, 2000, 4000, 8000, 16000]; // ms of song unlocked per attempt
// The first level is labelled 0.1 s but plays 0.2 s: most songs are at full volume within 0.05 s,
// but 0.1-0.15 s of sound is too short to hear a note.
const playMs = step => (step === 0 ? 200 : STEPS[step]);
const NUDGE_MS = 250;

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mmss = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const fmt = ms => (ms < 1000 ? (ms / 1000).toFixed(1) : String(ms / 1000)) + 's';

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// ---------- auth (Authorization Code + PKCE) ----------

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function login() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  store.set('pkce_verifier', verifier);
  location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, scope: SCOPES, redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256', code_challenge: challenge,
  });
}

async function tokenRequest(params) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Spotify login failed: ' + (d.error_description || d.error || r.status));
  const auth = { access: d.access_token, refresh: d.refresh_token || store.get('auth')?.refresh, expires: Date.now() + (d.expires_in - 60) * 1000 };
  store.set('auth', auth);
  return auth;
}

async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return;
  history.replaceState(null, '', REDIRECT_URI);
  if (q.has('error')) throw new Error('Spotify login was cancelled or refused: ' + q.get('error'));
  await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: REDIRECT_URI, code_verifier: store.get('pkce_verifier') });
  store.del('pkce_verifier');
}

let refreshing = null;
async function getToken() {
  const auth = store.get('auth');
  if (!auth) throw new Error('Not logged in');
  if (Date.now() < auth.expires) return auth.access;
  refreshing ||= tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refresh }).finally(() => { refreshing = null; });
  return (await refreshing).access;
}

// ---------- debug log ----------

const debugLines = [];
const debugT0 = performance.now();

function dbg(...parts) {
  const line = `${((performance.now() - debugT0) / 1000).toFixed(2)}s ` + parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
  console.log('[songless]', line);
  debugLines.push(line);
  if (debugLines.length > 300) debugLines.shift();
  const el = $('debug-log');
  if (el) el.textContent = debugLines.join('\n');
}

const describeState = s => s ? {
  paused: s.paused, loading: s.loading, position: s.position,
  track: s.track_window?.current_track && `${s.track_window.current_track.name} [${s.track_window.current_track.id}]`,
} : null;

async function api(path, opts = {}, attempt = 0) {
  const r = await fetch(path.startsWith('http') ? path : 'https://api.spotify.com/v1' + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + await getToken(), 'Content-Type': 'application/json' },
  });
  const text = await r.text();
  dbg(`api ${opts.method || 'GET'} ${path.split('?')[0]} -> ${r.status}`, text.slice(0, 200));
  // Rate limited: wait as long as Spotify asks, then retry.
  if (r.status === 429 && attempt < 5) {
    const wait = (Number(r.headers.get('Retry-After')) || 5) * 1000;
    setStatus(`Spotify asked us to slow down. Waiting ${Math.round(wait / 1000)} s…`);
    await sleep(wait);
    return api(path, opts, attempt + 1);
  }
  let d = null;
  try { d = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) {
    const e = new Error(d?.error?.message || `Spotify API error ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return d;
}

// ---------- player ----------

let player = null, deviceId = null, lastState = null;
const stateWaiters = new Set();

function initPlayer() {
  return new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => {
      player = new Spotify.Player({
        name: 'Songless Unlimited',
        getOAuthToken: cb => getToken().then(cb, e => showError(e.message)),
        volume: 0,
      });
      player.addListener('ready', ({ device_id }) => { dbg('sdk ready', device_id); deviceId = device_id; resolve(); });
      player.addListener('not_ready', ({ device_id }) => { dbg('sdk not_ready', device_id); deviceId = null; });
      player.addListener('player_state_changed', s => { dbg('sdk state', describeState(s)); lastState = s; stateWaiters.forEach(w => w(s)); });
      player.addListener('initialization_error', ({ message }) => { dbg('sdk initialization_error', message); reject(new Error(`This browser can't play Spotify (${message}). Use Chrome, Edge or Firefox.`)); });
      player.addListener('authentication_error', ({ message }) => { dbg('sdk authentication_error', message); store.del('auth'); reject(new Error('Spotify rejected the login: ' + message)); });
      player.addListener('account_error', ({ message }) => { dbg('sdk account_error', message); reject(new Error('Spotify Premium is required to play songs in the browser.')); });
      player.addListener('playback_error', ({ message }) => dbg('sdk playback_error', message));
      // Fired when the browser refuses to start audio without a click.
      player.addListener('autoplay_failed', () => {
        dbg('sdk autoplay_failed');
        ui.autoplayBlocked = true;
        setStatus('Your browser blocked the audio. Click the button again to allow it.');
        render();
      });
      dbg('sdk connect', navigator.userAgent);
      player.connect().then(ok => dbg('sdk connect ->', ok));
    };
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.onerror = () => reject(new Error("Couldn't load the Spotify player script."));
    document.head.appendChild(s);
  });
}

// SDK commands can hang forever (e.g. pause() before anything has played on the device),
// so each one gets a deadline. On timeout it resolves to undefined and logs a warning.
function cmd(name, ...args) {
  let settled = false;
  return Promise.race([
    Promise.resolve().then(() => player[name](...args)).then(
      v => { settled = true; return v; },
      e => { settled = true; dbg(`player.${name} failed`, String(e)); }),
    sleep(1500).then(() => { if (!settled) dbg(`player.${name} timed out`); }),
  ]);
}

// measure.js turns this off to keep Web API calls (and rate limiting) down.
let useServerState = true;

// What Spotify's servers think this device is playing, shaped like an SDK state.
// Used when the in-page player gives no state.
async function serverState() {
  const d = await api('/me/player').catch(() => null);
  if (!d?.item || d.device?.id !== deviceId) return null;
  return {
    fromServer: true, paused: !d.is_playing, position: d.progress_ms,
    track_window: { current_track: { id: d.item.id, uri: d.item.uri, name: d.item.name, linked_from: d.item.linked_from } },
  };
}

// Resolves on a matching player_state_changed event. Also polls getCurrentState,
// and every ~1.2 s the Web API, in case the SDK never reports anything.
function waitForState(pred, what, timeout = 8000) {
  return new Promise((resolve, reject) => {
    if (pred(lastState)) return resolve(lastState);
    let finished = false;
    const done = () => { finished = true; clearTimeout(t); stateWaiters.delete(w); };
    const w = s => { if (!finished && pred(s)) { dbg(`saw: ${what}`, describeState(s), s.fromServer ? '(from Web API)' : '(from SDK)'); done(); resolve(s); } };
    const t = setTimeout(() => {
      done();
      dbg(`timed out waiting: ${what}; last SDK state`, describeState(lastState));
      reject(new Error(`Spotify never reported that ${what}.`));
    }, timeout);
    stateWaiters.add(w);
    (async () => {
      for (let polls = 1; !finished; polls++) {
        await sleep(300);
        const s = await cmd('getCurrentState');
        if (s) { lastState = s; w(s); }
        if (!finished && polls % 4 === 0 && useServerState) {
          dbg('poll: SDK state', describeState(s));
          const ss = await serverState();
          if (ss) w(ss);
        }
      }
    })();
  });
}

// Spotify may swap in a relinked copy of the track (different id, sometimes a
// slightly different title), so match loosely.
const isTrack = (s, t) => {
  const c = s?.track_window?.current_track;
  return !!c && (c.id === t.id || c.linked_from?.id === t.id || c.uri === 'spotify:track:' + t.id || norm(c.name) === norm(t.name));
};

const volume = () => store.get('volume', 0.7);

let deviceActive = false;

// Make this tab the active Spotify device. Playing on a device that was never
// activated often fails with "Device not found".
async function activateDevice() {
  if (deviceActive) return;
  setStatus('Making this tab your Spotify player…');
  await api('/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [deviceId], play: false }) });
  deviceActive = true;
  await sleep(500);
}

// Load the track muted and leave it paused at the start, ready for the first clip.
async function cueTrack(t) {
  await activateDevice();
  await cmd('setVolume', 0);
  setStatus('Asking Spotify to load the song…');
  await api(`/me/player/play?device_id=${deviceId}`, { method: 'PUT', body: JSON.stringify({ uris: ['spotify:track:' + t.id] }) });
  setStatus('Waiting for the song to start…');
  // pause() is ignored while the track is still loading, so wait until audio is moving.
  const started = s => isTrack(s, t) && !s.paused && !s.loading && s.position > 0;
  try {
    await waitForState(started, 'the song started', 4000);
  } catch {
    // The track is often loaded but held paused (e.g. the browser blocked autoplay).
    dbg('song did not start; trying resume()');
    player.activateElement();
    await cmd('resume');
    await waitForState(started, 'the song started after resume()', 6000);
  }
  setStatus('Pausing the song…');
  await cmd('pause');
  try {
    await waitForState(s => isTrack(s, t) && s.paused, 'the song paused', 2500);
  } catch {
    dbg('SDK pause did not take; pausing through the Web API');
    await api(`/me/player/pause?device_id=${deviceId}`, { method: 'PUT' });
    await waitForState(s => isTrack(s, t) && s.paused, 'the song paused via the Web API', 5000);
  }
  setStatus('');
}

let clipId = 0;

async function stopClip() {
  clipId++;
  if (player && lastState) await cmd('pause');
  renderProgress(null);
}

// Measured by capturing this tab's audio in Chrome (Nov 2026):
// - audio starts a steady ~130 ms after resume(), and
// - keeps playing a steady ~125 ms after pause().
// The two cancel out, so sending pause() durMs after resume() gives durMs of sound
// (a 0.1 s clip comes out 80-100 ms). The SDK's reported position is NOT used for
// timing: on about 1 play in 3 it is off by 70-200 ms.
const AUDIO_DELAY_MS = 130;

// The clip being played. skip() raises its durMs to keep it going into the next section.
// baseMs is how much of the level was already heard before startMs (when continuing).
// full is the whole song after the round, shown on the seek bar instead of the timeline.
let clip = null;
// Where the last clip of 0.5 s or more stopped by itself, so a quick Skip can carry on from there.
let lastClipEnd = null;
const CONTINUE_MIN_MS = 500;
const CONTINUE_WINDOW_MS = 3000;

async function playClip(startMs, durMs, baseMs = 0) {
  const id = ++clipId;
  const c = clip = { durMs, baseMs, full: durMs === Infinity };
  lastClipEnd = null;
  await cmd('pause');
  await cmd('seek', startMs);
  // Wait for the seek to land.
  for (let i = 0; i < 100; i++) {
    const s = await cmd('getCurrentState');
    if (id !== clipId) return;
    if (s && Math.abs(s.position - startMs) < 60) break;
    await sleep(10);
  }
  await cmd('setVolume', volume());
  const t0 = performance.now();
  await cmd('resume');
  let lastCheck = t0;
  for (;;) {
    if (id !== clipId) return;
    const now = performance.now();
    if (now - t0 >= c.durMs) break;
    const heard = Math.max(0, now - t0 - AUDIO_DELAY_MS);
    if (c.full) {
      ui.listenMs = Math.min(startMs + heard, ui.track.ms);
      renderSeek();
      if (ui.listenMs >= ui.track.ms) { ui.listenMs = 0; break; }
    } else renderProgress(c.baseMs + heard);
    // On long plays, notice the song ending or being paused from elsewhere.
    if (now - lastCheck > 1000) {
      lastCheck = now;
      const s = await cmd('getCurrentState');
      if (id !== clipId) return;
      if (s?.paused) break;
    }
    await sleep(Math.min(16, c.durMs - (now - t0)));
  }
  await cmd('pause');
  dbg('clip', { startMs, durMs: c.durMs });
  const levelMs = c.baseMs + c.durMs;
  if (!ui.done && id === clipId && levelMs >= CONTINUE_MIN_MS) {
    lastClipEnd = { at: performance.now(), trackId: ui.track.id, step: ui.step, songMs: startMs + c.durMs, levelMs };
  }
  renderProgress(null);
  ui.playing = false;
  render();
}

// ---------- playlist ----------

async function loadDefaultPlaylist() {
  const r = await fetch('playlist.json');
  return r.json();
}

async function fetchPlaylist(id) {
  const meta = await api(`/playlists/${id}?fields=name`);
  const tracks = [], seen = new Set();
  let url = `/playlists/${id}/tracks?limit=100&market=from_token&fields=next,items(track(id,type,name,is_local,is_playable,duration_ms,artists(name),album(name,release_date,images)))`;
  while (url) {
    $('loading-text').textContent = `Loading ${meta.name}… ${tracks.length} songs`;
    const d = await api(url);
    for (const { track: t } of d.items) {
      // Playlists can also hold podcast episodes, which have no artists.
      if (!t || t.type !== 'track' || t.is_local || !t.id || !t.name || t.is_playable === false || seen.has(t.id)) continue;
      seen.add(t.id);
      const imgs = t.album?.images || [];
      tracks.push({
        id: t.id, name: t.name, artists: (t.artists || []).map(a => a.name).filter(Boolean), album: t.album?.name || '',
        year: (t.album?.release_date || '').slice(0, 4), img: (imgs[1] || imgs[0])?.url || '', ms: t.duration_ms,
      });
    }
    url = d.next;
  }
  if (!tracks.length) throw new Error('That playlist has no playable songs.');
  return { id, name: meta.name, tracks };
}

const parsePlaylistId = s => (s.match(/playlist[/:]([A-Za-z0-9]{22})/) || s.trim().match(/^([A-Za-z0-9]{22})$/) || [])[1];

// ---------- matching ----------

const norm = s => s.toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\s*[([].*?[)\]]/g, '')   // (feat. X), [Remastered]
  .replace(/\s+-\s+.*$/, '')          // " - 2011 Remaster", " - Radio Edit"
  .replace(/&/g, 'and')
  .replace(/[^\p{L}\p{N} ]/gu, '')   // keep letters in any language (Hebrew too); drops punctuation and vowel marks
  .replace(/\s+/g, ' ').trim();

const songKey = t => norm(t.name) + '|' + norm(t.artists[0] || '');

function judge(guess, answer) {
  if (guess.id === answer.id || songKey(guess) === songKey(answer)) return 'right';
  const artists = new Set(answer.artists.map(norm));
  if (guess.artists.some(a => artists.has(norm(a)))) return 'close';
  return 'wrong';
}

let searchIndex = [];

function buildSearchIndex(tracks) {
  const byKey = new Map();
  // Title and artists are cleaned up separately: norm() drops everything after " - " in a title.
  for (const t of tracks) if (!byKey.has(songKey(t))) byKey.set(songKey(t), { t, hay: [t.name, ...t.artists].map(norm).join(' '), name: norm(t.name) });
  searchIndex = [...byKey.values()];
}

function search(q) {
  const words = norm(q).split(' ').filter(Boolean);
  if (!words.length) return [];
  const qn = words.join(' ');
  return searchIndex
    .filter(e => words.every(w => e.hay.includes(w)))
    .sort((a, b) => (b.name.startsWith(qn) - a.name.startsWith(qn)) || a.name.length - b.name.length)
    .map(e => e.t);
}

// ---------- game ----------

const ui = { playlist: null, track: null, step: 0, attempts: [], done: false, won: false, playing: false, cueing: false, suggestions: [], active: -1, listenMs: 0 };

const nudges = () => store.get('nudges', {});
// Where the sound starts in each song, measured by measure.html (see build_starts.py),
// plus any manual "move the start later" nudges.
let measuredStarts = {};
const startMs = () => (measuredStarts[ui.track?.id] || 0) + (nudges()[ui.track?.id] || 0);
// Songs Spotify refused to play during measuring. They are never picked, but can still be guessed.
let unplayable = new Set();

function pickTrack() {
  const key = 'seen:' + ui.playlist.id;
  let seen = new Set(store.get(key, []));
  const playable = ui.playlist.tracks.filter(t => !unplayable.has(t.id) && t.id !== ui.track?.id);
  let pool = playable.filter(t => !seen.has(t.id));
  if (!pool.length) { seen = new Set(); pool = playable; }
  const t = pool[Math.floor(Math.random() * pool.length)];
  seen.add(t.id);
  store.set(key, [...seen]);
  return t;
}

async function newRound() {
  await stopClip();
  Object.assign(ui, { step: 0, attempts: [], done: false, won: false, playing: false, cueing: true, listenMs: 0 });
  $('guess-input').value = '';
  closeSuggestions();
  render();
  let lastErr;
  for (let tries = 0; tries < 3; tries++) {
    ui.track = pickTrack();
    try {
      await cueTrack(ui.track);
      ui.cueing = false;
      render();
      return;
    } catch (e) {
      lastErr = e;
      dbg('cue failed', ui.track.name, String(e.message));
      if (e.status === 401) return showError('Your Spotify session expired. Log in again.', true);
      if (e.status === 404) deviceActive = false;
      setStatus(`"${ui.track.name}" wouldn't play (${e.message}). Trying another song…`);
    }
  }
  showError(`Spotify wouldn't play 3 songs in a row. Last error: ${lastErr.message}`);
}

async function play() {
  if (ui.autoplayBlocked) {
    // This click counts as the user gesture the browser wanted.
    ui.autoplayBlocked = false;
    dbg('retrying after autoplay_failed');
    player.activateElement();
    cmd('resume');
    render();
    return;
  }
  if (ui.cueing) return;
  // Browsers block audio until the page gets a click, so the first song is cued on the Start click.
  if (!ui.track) { player.activateElement(); return newRound(); }
  if (ui.playing) { ui.playing = false; await stopClip(); render(); return; }
  ui.playing = true;
  render();
  // After the round, play the whole song from the seek bar's position.
  try { await (ui.done ? playClip(ui.listenMs, Infinity) : playClip(startMs(), playMs(ui.step))); } catch (e) { ui.playing = false; render(); showToast(e.message); }
}

function advance(attempt) {
  ui.attempts.push(attempt);
  if (attempt.result === 'right') return finish(true);
  if (ui.step === STEPS.length - 1) return finish(false);
  ui.step++;
  render();
}

function skip() {
  if (ui.done || ui.cueing || !ui.track) return;
  const playing = ui.playing;
  const last = lastClipEnd;
  const quick = last && last.trackId === ui.track.id && last.step === ui.step &&
    performance.now() - last.at < CONTINUE_WINDOW_MS;
  advance({ result: 'skip' });
  if (ui.done) return; // finish() stops the clip and plays the whole song
  // Mid-clip, keep playing through the newly unlocked section instead of stopping.
  if (playing) { clip.durMs = STEPS[ui.step] - clip.baseMs; return; }
  // Right after a long clip ended, carry on from where it stopped.
  if (quick) {
    ui.playing = true;
    render();
    playClip(last.songMs, STEPS[ui.step] - last.levelMs, last.levelMs)
      .catch(e => { ui.playing = false; render(); showToast(e.message); });
    return;
  }
  stopClip().then(() => { ui.playing = false; });
}

// During a round, a click on an unlocked part of the timeline plays from that point to the end of the unlocked part.
// After the round, a click on a section plays the song from its start up to the end of that section.
function playFrom(e) {
  const cell = e.target.closest('.cell');
  if (ui.cueing || !ui.track || !cell?.classList.contains('open')) return;
  const i = [...$('timeline').querySelectorAll('.cell')].indexOf(cell);
  const fail = err => { ui.playing = false; render(); showToast(err.message); };
  if (ui.done) {
    ui.playing = true;
    render();
    return playClip(startMs(), playMs(i)).catch(fail);
  }
  const r = cell.getBoundingClientRect();
  const lo = i ? STEPS[i - 1] : 0;
  const end = playMs(ui.step);
  // Leave at least 0.1 s to hear.
  const at = Math.max(0, Math.min(lo + (e.clientX - r.left) / r.width * (STEPS[i] - lo), end - 100));
  ui.playing = true;
  render();
  playClip(startMs() + at, end - at, at).catch(fail);
}

function submitGuess(t) {
  if (ui.done || ui.cueing || !ui.track || !t) return;
  $('guess-input').value = '';
  closeSuggestions();
  advance({ result: judge(t, ui.track), guess: t });
}

function finish(won) {
  ui.done = true;
  ui.won = won;
  ui.playing = false;
  const s = store.get('stats', { played: 0, won: 0, streak: 0, best: 0, dist: Array(STEPS.length).fill(0) });
  s.played++;
  if (won) { s.won++; s.streak++; s.best = Math.max(s.best, s.streak); s.dist[ui.step]++; } else s.streak = 0;
  store.set('stats', s);
  render();
  // Play the whole song right away (the button then stops it), unless the next round already started.
  const t = ui.track;
  stopClip().then(() => { if (ui.done && ui.track === t && !ui.playing) play(); });
}

function nudge() {
  if (!ui.track || ui.done) return;
  const n = nudges();
  n[ui.track.id] = (n[ui.track.id] || 0) + NUDGE_MS;
  store.set('nudges', n);
  ui.playing = false;
  play();
}

// ---------- rendering ----------

function show(id) {
  for (const s of ['login', 'loading', 'error', 'game']) $(s).classList.toggle('hidden', s !== id);
  $('settings').classList.toggle('hidden', id !== 'game');
}

function showError(msg, relogin = false) {
  dbg('error shown', msg);
  $('error-text').textContent = msg;
  $('error-retry').textContent = relogin ? 'Log in again' : 'Try again';
  $('error-retry').onclick = relogin ? () => { store.del('auth'); location.reload(); } : () => location.reload();
  show('error');
}

function showToast(msg) {
  console.warn(msg);
  $('toast').textContent = msg;
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => { $('toast').textContent = ''; }, 5000);
}

// A status line that stays until replaced, for the steps of loading a song.
function setStatus(msg) {
  clearTimeout(showToast.t);
  $('toast').textContent = msg;
}

function renderStats() {
  const s = store.get('stats', null);
  $('stats').innerHTML = s ? `Streak <b>${s.streak}</b> · Best <b>${s.best}</b> · Won <b>${s.won}</b>/${s.played}` : '';
}

function renderProgress(elapsed) {
  const cells = $('timeline').querySelectorAll('.cell');
  cells.forEach((c, i) => {
    const lo = i ? STEPS[i - 1] : 0, hi = STEPS[i];
    const f = elapsed == null ? 0 : Math.min(1, Math.max(0, (elapsed - lo) / (hi - lo)));
    c.firstChild.style.width = f * 100 + '%';
  });
}

function render() {
  renderStats();
  const p = ui.playlist;
  $('playlist-name').textContent = p.name;
  $('playlist-count').textContent = p.tracks.length.toLocaleString();

  $('attempts').innerHTML = STEPS.map((ms, i) => {
    const a = ui.attempts[i];
    const cls = a ? a.result : (i === ui.step && !ui.done ? 'current' : '');
    let what = '';
    if (a?.result === 'skip') what = 'Skipped';
    else if (a) what = esc(`${a.guess.name} — ${a.guess.artists.join(', ')}`) + (a.result === 'close' ? '<span class="note">right artist</span>' : '');
    return `<li class="${cls}"><span class="what">${what}</span><span class="len">${fmt(ms)}</span></li>`;
  }).join('');

  const open = ui.done ? STEPS.length : ui.step + 1;
  if (!$('timeline').children.length) {
    $('timeline').innerHTML = STEPS.map(() => '<div class="cell"><div class="fill"></div></div>').join('') +
      STEPS.map(ms => `<div class="label">${fmt(ms)}</div>`).join('');
  }
  $('timeline').querySelectorAll('.cell').forEach((c, i) => c.classList.toggle('open', i < open));
  $('timeline').classList.toggle('seekable', !!ui.track && !ui.cueing);

  const dur = STEPS[ui.step];
  const idle = ui.cueing || !ui.track;
  $('play-btn').disabled = ui.cueing && !ui.autoplayBlocked;
  $('play-btn').textContent = ui.autoplayBlocked ? '🔊 Allow audio' : ui.cueing ? 'Loading song…' : !ui.track ? '▶ Start' : ui.playing ? '■ Stop' : `▶ Play ${fmt(dur)}`;
  $('skip-btn').disabled = ui.done || idle;
  $('skip-btn').textContent = ui.step < STEPS.length - 1 ? `Skip (+${fmt(STEPS[ui.step + 1] - STEPS[ui.step])})` : 'Give up';
  $('nudge-btn').classList.toggle('hidden', ui.done || idle);
  $('guess-form').classList.toggle('hidden', ui.done || idle);

  $('reveal').classList.toggle('hidden', !ui.done);
  $('play-btn').parentElement.classList.toggle('hidden', ui.done);
  if (ui.done) {
    const t = ui.track;
    $('reveal-result').textContent = ui.won ? `Got it in ${fmt(STEPS[ui.step])}` : 'Out of guesses';
    $('reveal-result').className = 'reveal-result ' + (ui.won ? 'won' : 'lost');
    $('reveal-name').textContent = t.name;
    $('reveal-artist').textContent = t.artists.join(', ') + (t.year ? ` · ${t.year}` : '');
    $('reveal-img').src = t.img;
    $('reveal-link').href = 'https://open.spotify.com/track/' + t.id;
    $('listen-btn').textContent = ui.playing ? '❚❚ Pause' : ui.listenMs ? '▶ Resume' : '▶ Play full song';
    renderSeek();
  }
}

// The seek bar under the revealed song. Left alone while it is being dragged.
let seekDragging = false;
function renderSeek() {
  if (seekDragging || !ui.track) return;
  $('seek').max = ui.track.ms;
  $('seek').value = ui.listenMs;
  $('seek-pos').textContent = mmss(ui.listenMs);
  $('seek-len').textContent = mmss(ui.track.ms);
}

function seekTo(ms) {
  seekDragging = false;
  ui.listenMs = ms;
  render();
  if (ui.playing) playClip(ms, Infinity).catch(e => { ui.playing = false; render(); showToast(e.message); });
}

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- autocomplete ----------

function renderSuggestions() {
  const list = $('suggestions');
  list.classList.toggle('hidden', !ui.suggestions.length);
  list.innerHTML = ui.suggestions.map((t, i) =>
    `<li data-i="${i}" class="${i === ui.active ? 'active' : ''}">${esc(t.name)} <span class="artist">— ${esc(t.artists.slice(0, 2).join(', ') + (t.artists.length > 2 ? ', …' : ''))}</span></li>`).join('');
  // The list scrolls; keep the arrow-key choice in view.
  list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function closeSuggestions() {
  ui.suggestions = [];
  ui.active = -1;
  renderSuggestions();
}

// ---------- wiring ----------

function wire() {
  $('login-btn').onclick = login;
  $('copy-debug').onclick = async () => {
    await navigator.clipboard.writeText(debugLines.join('\n'));
    $('copy-debug').textContent = 'Copied';
  };
  $('play-btn').onclick = play;
  $('listen-btn').onclick = play;
  $('seek').oninput = () => { seekDragging = true; $('seek-pos').textContent = mmss(+$('seek').value); };
  $('seek').onchange = () => seekTo(+$('seek').value);
  $('timeline').onclick = playFrom;
  $('skip-btn').onclick = skip;
  $('nudge-btn').onclick = nudge;
  $('next-btn').onclick = newRound;
  $('logout-btn').onclick = () => { store.del('auth'); player?.disconnect(); location.reload(); };

  const vol = $('volume');
  vol.value = volume();
  vol.oninput = () => { store.set('volume', +vol.value); if (ui.playing) player.setVolume(+vol.value); };

  const input = $('guess-input');
  input.oninput = () => { ui.suggestions = search(input.value); ui.active = ui.suggestions.length ? 0 : -1; renderSuggestions(); };
  input.onkeydown = e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!ui.suggestions.length) return;
      ui.active = (ui.active + (e.key === 'ArrowDown' ? 1 : -1) + ui.suggestions.length) % ui.suggestions.length;
      renderSuggestions();
    } else if (e.key === 'Escape') closeSuggestions();
  };
  input.onblur = () => setTimeout(closeSuggestions, 150);
  $('suggestions').onmousedown = e => {
    const li = e.target.closest('li');
    if (li) { e.preventDefault(); submitGuess(ui.suggestions[+li.dataset.i]); }
  };
  $('guess-form').onsubmit = e => {
    e.preventDefault();
    const t = ui.suggestions[ui.active];
    if (t) return submitGuess(t);
    $('guess-form').classList.remove('shake');
    void $('guess-form').offsetWidth;
    $('guess-form').classList.add('shake');
  };

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || $('game').classList.contains('hidden')) return;
    if (e.key === ' ') { e.preventDefault(); play(); }
    else if (e.key === 'Enter' && ui.done) { e.preventDefault(); newRound(); }
  });

  $('playlist-form').onsubmit = async e => {
    e.preventDefault();
    const id = parsePlaylistId($('playlist-input').value);
    if (!id) return showToast("That doesn't look like a playlist link.");
    store.set('playlist', id);
    location.reload();
  };
  $('default-playlist-btn').onclick = () => { store.del('playlist'); location.reload(); };
}

async function main() {
  wire();
  $('redirect-uri').textContent = REDIRECT_URI;
  try {
    await handleRedirect();
    if (!store.get('auth')) return show('login');

    show('loading');
    $('loading-text').textContent = 'Connecting to Spotify…';
    const playlistId = store.get('playlist', DEFAULT_PLAYLIST);
    const [playlist] = await Promise.all([
      playlistId === DEFAULT_PLAYLIST ? loadDefaultPlaylist() : fetchPlaylist(playlistId),
      initPlayer(),
    ]);
    ui.playlist = playlist;
    buildSearchIndex(playlist.tracks);
    measuredStarts = await fetch('starts.json').then(r => (r.ok ? r.json() : {}), () => ({}));
    unplayable = new Set(await fetch('unplayable.json').then(r => (r.ok ? r.json() : []), () => []));
    dbg(`${Object.keys(measuredStarts).length} songs have a measured start; ${unplayable.size} unplayable songs skipped`);
    show('game');
    render();
  } catch (e) {
    console.error(e);
    showError(e.message, e.status === 401 || /login/i.test(e.message));
  }
}

// measure.html reuses this file's Spotify code without starting the game.
if (!window.SONGLESS_TOOL) main();
