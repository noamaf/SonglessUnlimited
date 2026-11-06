"""Turns measurements.json (from measure.html) into starts.json: {track_id: start_ms},
and unplayable.json: the ids of songs Spotify refused to play.

A song's start is where the captured level first reaches ONSET_DB, minus MARGIN_MS
so the very first attack isn't cut. Repeated measurements agree within ~20 ms,
and onsets under MIN_SKIP_MS are treated as "starts right away" (0).
Checked Nov 2026: a 0.1 s clip from 0:00 was silent and one from the start was
audible on all 8 late-starting test songs.
"""
import json
import os

ONSET_DB = '-50'
MARGIN_MS = 30
MIN_SKIP_MS = 50

ROOT = os.path.dirname(os.path.abspath(__file__))

with open(os.path.join(ROOT, 'measurements.json')) as f:
    measurements = json.load(f)

starts, errors, never, unplayable = {}, 0, [], []
for track_id, m in measurements.items():
    if 'error' in m:
        errors += 1
        if m.get('unplayable'):
            unplayable.append(track_id)
        continue
    onset = m['crossingsMs'].get(ONSET_DB, m['crossingsMs'].get('-60'))
    if onset is None:
        never.append(m['name'])
        continue
    if onset >= MIN_SKIP_MS:
        starts[track_id] = int(onset - MARGIN_MS)

with open(os.path.join(ROOT, 'starts.json'), 'w') as f:
    json.dump(starts, f, separators=(',', ':'))
# Songs Spotify refuses to play here ("Restriction violated"); the game never picks them.
with open(os.path.join(ROOT, 'unplayable.json'), 'w') as f:
    json.dump(unplayable, f)

valid = len(measurements) - errors
skips = sorted(starts.values())
print(f'{len(measurements)} measured, {errors} errors ({len(unplayable)} unplayable), {valid} valid')
print(f'{len(starts)} songs get a start offset; {valid - len(starts) - len(never)} start right away')
if skips:
    print(f'offsets: median {skips[len(skips) // 2]} ms, max {skips[-1]} ms')
    for limit in (250, 500, 1000, 2000, 5000):
        print(f'  >= {limit} ms: {sum(s >= limit for s in skips)}')
if never:
    print(f'{len(never)} never reached {ONSET_DB} dB in 15 s:', ', '.join(never[:10]))
