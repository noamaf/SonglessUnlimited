// Measures where the sound starts in every song of the playlist. The page captures
// its own tab's audio (getDisplayMedia), plays each song from 0:00 and records when
// the captured level first crosses each threshold. Results are saved through
// server.py into measurements.json; build_starts.py turns them into starts.json.
// Uses the Spotify helpers from app.js.

const THRESHOLDS_DB = [-60, -50, -40, -30];
const MAX_LISTEN_MS = 15000;
const SAVE_EVERY = 10;
// The audio delay drifts slowly (133 ms vs 150 ms half an hour apart), so recalibrate.
const RECALIBRATE_EVERY = 100;

// Starting songs quickly makes Spotify's player fail with "Playback error" in waves
// (it seems to throttle fetching new songs). Keep a gap between song starts, widen
// it after an error, and narrow it again after a clean stretch.
const pace = { gapMs: 4000, lastStart: 0, clean: 0 };

async function waitForPace() {
  const wait = pace.lastStart + pace.gapMs - performance.now();
  if (wait > 0) await sleep(wait);
  pace.lastStart = performance.now();
}

async function backOff(why) {
  pace.gapMs = Math.min(10000, pace.gapMs + 1000);
  pace.clean = 0;
  dbg(`backing off 20 s, gap now ${pace.gapMs} ms, because`, why);
  setStatus(`Spotify is struggling (${why}). Pausing 20 s, then going slower.`);
  await sleep(20000);
  setStatus('');
}

function paceSuccess() {
  if (++pace.clean >= 50 && pace.gapMs > 3000) {
    pace.gapMs -= 500;
    pace.clean = 0;
    dbg(`50 clean songs, gap now ${pace.gapMs} ms`);
  }
}

let ctx = null;
let listen = null; // the song being measured: { crossings: {db: perfTime}, maxDb }
let stopRequested = false;

const RMS_WORKLET = `
registerProcessor('rms', class extends AudioWorkletProcessor {
  process(inputs) {
    const chans = inputs[0];
    if (chans && chans.length) {
      let max = 0;
      for (const ch of chans) {
        let sum = 0;
        for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
        max = Math.max(max, Math.sqrt(sum / ch.length));
      }
      this.port.postMessage([currentTime, max]);
    }
    return true;
  }
});`;

async function startCapture() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: { suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
  });
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('No audio was shared. Start again and tick "Also share tab audio".');
  dbg('capture settings', track.getSettings());
  ctx = new AudioContext();
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([RMS_WORKLET], { type: 'application/javascript' })));
  const node = new AudioWorkletNode(ctx, 'rms');
  // Connected to the output only so the graph runs; the worklet writes silence.
  ctx.createMediaStreamSource(new MediaStream([track])).connect(node).connect(ctx.destination);
  node.port.onmessage = e => onLevel(e.data[0], e.data[1]);
}

function onLevel(contextTime, rms) {
  if (!listen) return;
  const ts = ctx.getOutputTimestamp();
  const perf = ts.performanceTime + (contextTime - ts.contextTime) * 1000;
  const db = rms > 0 ? 20 * Math.log10(rms) : -200;
  listen.maxDb = Math.max(listen.maxDb, db);
  for (const thr of THRESHOLDS_DB) if (!(thr in listen.crossings) && db >= thr) listen.crossings[thr] = perf;
}

// Timing (measured by capturing this tab, see AUDIO_DELAY_MS in app.js): audio starts a
// steady delay after resume(), while the SDK's reported position is off by 70-200 ms
// on about 1 play in 3. So a song position is "capture time - resume time - delay",
// with the delay calibrated at the start of each run on a song that starts at once.
const CALIBRATION_TRACK_ID = '6naxalmIoLFWR0siv8dnQQ'; // Oops!...I Did It Again: loud from 0:00
let audioDelayMs = null;

// When Spotify refuses a command it reports "The operation is not allowed" and
// sometimes starts playing on its own, which would spoil a measurement.
let lastPlaybackErrorAt = 0;

async function seekToStart() {
  await cmd('pause');
  // A seek right after a pause can be refused ("The operation is not allowed").
  await sleep(300);
  await cmd('seek', 0);
  for (let i = 0; i < 100; i++) {
    const s = await cmd('getCurrentState');
    if (s?.paused && s.position < 60) return;
    await sleep(10);
  }
  throw new Error('Seeking to 0:00 did not work.');
}

// Plays the loaded song from 0:00 at full volume (captured, not heard) and returns
// when each threshold was first crossed, in ms after resume().
async function listenFromStart(maxMs) {
  const startedAt = performance.now();
  await seekToStart();
  listen = { crossings: {}, maxDb: -200 };
  await cmd('setVolume', 1);
  const t0 = performance.now();
  await cmd('resume');
  while (performance.now() - t0 < maxMs && listen.crossings[-30] == null) await sleep(20);
  await sleep(50);
  const l = listen;
  listen = null;
  await cmd('setVolume', 0);
  await cmd('pause');
  if (lastPlaybackErrorAt > startedAt) throw new Error('Spotify reported a playback error during the measurement.');
  const crossings = {};
  for (const thr of THRESHOLDS_DB) if (l.crossings[thr] != null) crossings[thr] = Math.round(l.crossings[thr] - t0);
  return { crossings, maxDb: Math.round(l.maxDb) };
}

// The delay depends on how the song was loaded (a seeked song starts later than a
// freshly loaded one: ~125 vs 88 ms), so calibrate exactly the way songs are measured:
// load the song, then seekToStart.
async function calibrate() {
  setStatus('Calibrating the audio delay…');
  const t = { id: CALIBRATION_TRACK_ID, name: 'Oops!...I Did It Again' };
  const delays = [];
  for (let i = 0; i < 5; i++) {
    try { await loadTrack(t); } catch (e) {
      if (e.status !== 404) throw e;
      await reconnect();
      await loadTrack(t);
    }
    const { crossings } = await listenFromStart(1500);
    if (crossings[-50] != null) delays.push(crossings[-50]);
  }
  delays.sort((a, b) => a - b);
  if (delays.length < 3 || delays[delays.length - 1] - delays[0] > 40) {
    throw new Error(`Calibration was not steady: ${delays.join(', ')} ms. Try again.`);
  }
  audioDelayMs = delays[Math.floor(delays.length / 2)];
  dbg('calibrated audio delay', { delays, audioDelayMs });
}

// Measures the loaded song: for each threshold, the song position (ms) where the
// captured level first crossed it.
async function measureLoaded(t) {
  const { crossings, maxDb } = await listenFromStart(MAX_LISTEN_MS);
  const result = { name: t.name, artist: t.artists[0], audioDelayMs, maxDb, crossingsMs: {} };
  for (const [thr, ms] of Object.entries(crossings)) result.crossingsMs[thr] = ms - audioDelayMs;
  if (result.crossingsMs[-60] < -60) throw new Error(`Sound came ${-result.crossingsMs[-60]} ms before 0:00; discarding.`);
  return result;
}

// Spotify rate-limits "play this song" requests (about 15 per 30 s), so the playlist
// is started once and then stepped through with the SDK's nextTrack(), which makes
// no Web API calls.
const currentTrack = () => lastState?.track_window?.current_track;

// Wait until the newly loaded song is playing (muted), then pause it.
// Pausing a song in its first few ms often made Spotify resume it by itself and then
// fail with "Playback error". So let it play (muted) for half a second first;
// seekToStart then takes it back to 0:00.
async function settle(isNew) {
  await waitForState(s => isNew(s?.track_window?.current_track) && !s.paused && !s.loading && s.position > 500, 'the song started');
  await cmd('pause');
  await waitForState(s => s?.paused, 'the song paused', 4000);
}

// Start the playlist at song t: one Web API call. Also how the loop recovers
// when the player gets stuck.
let modesSetFor = null;

// Load one song by itself (the calibration song): one Web API call.
async function loadTrack(t) {
  await activateDevice();
  await cmd('setVolume', 0);
  await api(`/me/player/play?device_id=${deviceId}`, { method: 'PUT', body: JSON.stringify({ uris: ['spotify:track:' + t.id] }) });
  await settle(c => !!c && isTrack({ track_window: { current_track: c } }, t));
}

async function loadAt(t) {
  await waitForPace();
  await activateDevice();
  // Shuffle and repeat stick to the device, so set them once per device.
  if (modesSetFor !== deviceId) {
    await api(`/me/player/shuffle?state=false&device_id=${deviceId}`, { method: 'PUT' });
    await api(`/me/player/repeat?state=off&device_id=${deviceId}`, { method: 'PUT' });
    modesSetFor = deviceId;
  }
  await cmd('setVolume', 0);
  await api(`/me/player/play?device_id=${deviceId}`, {
    method: 'PUT',
    body: JSON.stringify({ context_uri: 'spotify:playlist:' + DEFAULT_PLAYLIST, offset: { uri: 'spotify:track:' + t.id } }),
  });
  await settle(c => !!c && isTrack({ track_window: { current_track: c } }, t));
}

async function loadNext() {
  await waitForPace();
  const prevUri = currentTrack()?.uri;
  await cmd('setVolume', 0);
  await cmd('nextTrack');
  await settle(c => !!c && c.uri !== prevUri);
}

// Each page's player plays 20-35 songs cleanly, then fails more and more with
// "Playback error"; reconnecting doesn't help but a page reload does. A reload would
// end the tab-audio sharing, so instead throw away the SDK's iframe and make a new
// player every FRESH_PLAYER_EVERY songs and whenever the run recovers.
const FRESH_PLAYER_EVERY = 20;

async function freshPlayer() {
  dbg('replacing the Spotify player');
  try { player.disconnect(); } catch {}
  // The SDK makes its iframe once, when its script loads, so load the script again.
  document.querySelectorAll('iframe[src*="sdk.scdn.co"], script[src*="sdk.scdn.co"]').forEach(el => el.remove());
  delete window.Spotify;
  const loaded = await new Promise(resolve => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve(true);
    const el = document.createElement('script');
    el.src = 'https://sdk.scdn.co/spotify-player.js?fresh=' + Date.now();
    el.onerror = () => resolve(false);
    document.head.appendChild(el);
    setTimeout(() => resolve(false), 15000);
  });
  if (!loaded) throw new Error("Couldn't reload the Spotify player script.");
  deviceId = null;
  lastState = null;
  deviceActive = false;
  modesSetFor = null;
  player = new Spotify.Player({ name: 'Songless Unlimited', getOAuthToken: cb => getToken().then(cb), volume: 0 });
  player.addListener('ready', ({ device_id }) => { dbg('sdk ready', device_id); deviceId = device_id; });
  player.addListener('not_ready', () => { dbg('sdk not_ready'); deviceId = null; });
  player.addListener('player_state_changed', st => { dbg('sdk state', describeState(st)); lastState = st; stateWaiters.forEach(w => w(st)); });
  player.addListener('playback_error', ({ message }) => { dbg('sdk playback_error', message); lastPlaybackErrorAt = performance.now(); });
  await Promise.race([player.connect(), sleep(10000)]);
  for (let i = 0; i < 60 && !deviceId; i++) await sleep(250);
  if (!deviceId) throw new Error('The new Spotify player did not become ready.');
  player.activateElement();
  await activateDevice();
}

// Spotify sometimes drops the player from its device list ("Device not found").
async function reconnect() {
  dbg('reconnecting the player');
  player.disconnect();
  await sleep(1500);
  deviceId = null;
  await player.connect();
  for (let i = 0; i < 40 && !deviceId; i++) await sleep(250);
  if (!deviceId) throw new Error('The Spotify player did not come back after reconnecting.');
  deviceActive = false;
  await activateDevice();
}

async function save(batch) {
  if (!Object.keys(batch).length) return;
  const r = await fetch('/api/measurements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) });
  if (!r.ok) throw new Error('Saving measurements failed: HTTP ' + r.status);
}

async function run() {
  let batch = {};
  $('start-btn').disabled = true;
  stopRequested = false;
  useServerState = false;
  try {
    if (!store.get('auth')) throw new Error('Log in on the game page first.');
    if (!ctx) await startCapture();
    if (!player) {
      setStatus('Connecting to Spotify…');
      await initPlayer();
      player.addListener('playback_error', () => { lastPlaybackErrorAt = performance.now(); });
    }
    player.activateElement();
    const { tracks } = await loadDefaultPlaylist();
    const byId = new Map(tracks.map(t => [t.id, t]));
    const byName = new Map(tracks.map(t => [norm(t.name) + '|' + norm(t.artists[0]), t]));
    const lookup = c => c && (byId.get(c.id) || byId.get(c.linked_from?.id) || byName.get(norm(c.name || '') + '|' + norm(c.artists?.[0]?.name || '')));

    const done = await fetch('measurements.json').then(r => (r.ok ? r.json() : {}), () => ({}));
    const todo = new Set(tracks.filter(t => !done[t.id] || (done[t.id].error && !done[t.id].unplayable)).map(t => t.id));
    const total = todo.size;
    dbg(`${tracks.length} songs, ${tracks.length - total} already measured, ${total} to go`);
    if (!total) return setStatus('All songs are already measured.');
    $('stop-btn').disabled = false;

    // The next unmeasured song after `after` (default: the current song), in playlist order.
    const nextTodo = (after = lookup(currentTrack())) => {
      const from = after ? tracks.indexOf(after) + 1 : 0;
      return [...tracks.slice(from), ...tracks.slice(0, from)].find(t => todo.has(t.id));
    };
    // Start the playlist at t. Spotify refuses songs it won't play here
    // ("Restriction violated"); record those as unplayable and try the next one.
    const startAt = async t => {
      for (let i = 0; i < 10 && t; i++) {
        try { return await loadAt(t); } catch (e) {
          if (e.status !== 403) throw e;
          dbg('unplayable, skipping', t.name, e.message);
          batch[t.id] = { name: t.name, artist: t.artists[0], error: e.message, unplayable: true };
          todo.delete(t.id);
          t = nextTodo(t);
        }
      }
      throw new Error('Spotify refused 10 songs in a row.');
    };
    let recoveriesInARow = 0;
    // Set to the song before a failed one, so a recovery retries the failed song.
    let retryFrom;
    const recover = async why => {
      if (++recoveriesInARow > 10) throw new Error('The player got stuck 10 times in a row. Last problem: ' + why);
      const t = nextTodo(retryFrom);
      retryFrom = undefined;
      dbg('recovering: reconnecting and restarting the playlist at', t.name, 'because', why);
      await sleep(2000 * recoveriesInARow);
      await freshPlayer();
      await startAt(t);
    };

    // Spotify drops the player from its device list now and then, so always re-check.
    deviceActive = false;
    try { await activateDevice(); } catch { await reconnect(); }
    for (let i = 1; ; i++) {
      try { await calibrate(); break; } catch (e) {
        // The delay has stayed within 113-123 ms all night, so a failed calibration
        // can reuse the last one. Spotify sometimes leaves this one song "loading".
        if (i >= 3 && audioDelayMs != null) { dbg('calibration failed; keeping', audioDelayMs, 'ms'); break; }
        if (i >= 3) throw e;
        await backOff('calibration failed: ' + e.message);
        await reconnect();
      }
    }
    setStatus('Starting the playlist…');
    await startAt(byId.get(todo.values().next().value));
    setStatus('');
    let measured = 0, silentInARow = 0;
    const startedAt = performance.now();
    // Errors come in bursts (the player's connection goes bad for a while) rather than
    // from particular songs, so a failed song stays queued and is retried later, and
    // two failures in a row trigger a reconnect. A song is given up after 3 failures.
    const attempts = {};
    let failsInARow = 0;
    while (!stopRequested && todo.size) {
      const c = currentTrack();
      if (!c) {
        await recover('the player lost its state');
        continue;
      }
      const t = lookup(c);
      if (!t || !todo.has(t.id)) {
        dbg('skipping', `${c.name} (${t ? 'already measured' : 'not in playlist.json'})`);
      } else {
        const perSong = measured ? (performance.now() - startedAt) / measured : 0;
        $('progress').textContent = `${measured + 1} / ${total}: ${t.name} — ${t.artists[0]}` +
          (measured ? ` · about ${Math.round(perSong * todo.size / 60000)} min left` : '');
        let r = null;
        try {
          r = await measureLoaded(t);
        } catch (e) {
          attempts[t.id] = (attempts[t.id] || 0) + 1;
          dbg(`failed (attempt ${attempts[t.id]})`, t.name, String(e.message));
          await backOff(e.message);
          if (attempts[t.id] >= 3) {
            batch[t.id] = { name: t.name, artist: t.artists[0], error: String(e.message) };
            todo.delete(t.id);
          }
          if (++failsInARow >= 2) {
            failsInARow = 0;
            retryFrom = tracks[tracks.indexOf(t) - 1] || null;
            await recover('2 songs in a row failed');
            continue;
          }
        }
        if (r) {
          todo.delete(t.id);
          batch[t.id] = r;
          dbg('measured', r);
          measured++;
          paceSuccess();
          failsInARow = 0;
          recoveriesInARow = 0;
          silentInARow = r.crossingsMs[-60] == null ? silentInARow + 1 : 0;
          if (silentInARow >= 3) throw new Error('The captured audio is silent for 3 songs in a row, so the capture is not working.');
        }
        if (Object.keys(batch).length >= SAVE_EVERY) { await save(batch); batch = {}; }
        if (r && measured % FRESH_PLAYER_EVERY === 0 && measured % RECALIBRATE_EVERY !== 0 && todo.size) {
          const resumeAt = nextTodo();
          await freshPlayer();
          await startAt(resumeAt);
          continue;
        }
        if (r && measured % RECALIBRATE_EVERY === 0 && todo.size) {
          const resumeAt = nextTodo();
          await freshPlayer();
          try { await calibrate(); } catch (e) {
            dbg('recalibration failed; keeping', audioDelayMs, 'ms:', e.message);
            await freshPlayer();
          }
          await startAt(resumeAt);
          continue;
        }
      }
      if (!todo.size) break;
      // At the end of the playlist, wrap around to the songs still queued (failed ones).
      if (!lastState?.track_window?.next_tracks?.length) {
        dbg('end of the playlist; going back for', todo.size, 'queued songs');
        await startAt(nextTodo(null));
        continue;
      }
      try {
        await loadNext();
      } catch (e) {
        dbg('moving to the next song failed', String(e.message));
        await recover(e.message);
      }
    }
    setStatus(stopRequested ? 'Stopped. Start again to continue where it left off.'
      : todo.size ? `Reached the end of the playlist with ${todo.size} songs not measured. Start again to retry them.` : 'Done.');
  } catch (e) {
    dbg('stopped with error', String(e.message));
    setStatus(e.message);
  } finally {
    await save(batch).catch(e => dbg('final save failed', String(e.message)));
    $('start-btn').disabled = false;
    $('stop-btn').disabled = true;
  }
}

// Unattended mode (e.g. overnight): wait for Spotify to calm down, then measure slowly.
// After a run fails, cool down, load a fresh player and continue. Stops when no
// songs are left, when 3 runs in a row measure nothing, or when Stop is pressed.
let autopilotStopped = false;

async function autopilot({ startDelayMin = 45, gapMs = 8000, coolDownMin = 15 } = {}) {
  autopilotStopped = false;
  const until = Date.now() + startDelayMin * 60000;
  while (Date.now() < until && !autopilotStopped) {
    setStatus(`Autopilot: starting in ${Math.ceil((until - Date.now()) / 60000)} min…`);
    await sleep(30000);
  }
  const countDone = async () => Object.values(await fetch('measurements.json').then(r => (r.ok ? r.json() : {}), () => ({}))).filter(m => !m.error).length;
  let idleRuns = 0;
  for (let round = 1; !autopilotStopped && idleRuns < 3; round++) {
    const before = await countDone();
    dbg(`autopilot round ${round}: ${before} songs measured so far`);
    try { await freshPlayer(); } catch (e) { dbg('autopilot: fresh player failed', String(e.message)); }
    pace.gapMs = gapMs;
    await run();
    const after = await countDone();
    if (/^(Done|All songs)/.test($('toast').textContent)) break;
    idleRuns = after > before ? 0 : idleRuns + 1;
    if (autopilotStopped) break;
    dbg(`autopilot: run ended (${$('toast').textContent}); cooling down ${coolDownMin} min`);
    const resumeAt = Date.now() + coolDownMin * 60000;
    while (Date.now() < resumeAt && !autopilotStopped) {
      setStatus(`Autopilot: cooling down, resuming in ${Math.ceil((resumeAt - Date.now()) / 60000)} min…`);
      await sleep(30000);
    }
  }
  dbg('autopilot finished', { idleRuns, stopped: autopilotStopped });
}

$('start-btn').onclick = run;
$('stop-btn').onclick = () => { stopRequested = true; autopilotStopped = true; setStatus('Stopping after this song…'); };
$('copy-debug').onclick = () => navigator.clipboard.writeText(debugLines.join('\n'));
