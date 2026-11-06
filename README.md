# Songless Unlimited

Guess a song from the "Guess that Tune." Spotify playlist after hearing 0.1 s, 0.2 s, 0.5 s, 1 s, 2 s, 4 s, 8 s, then 16 s of it.

## Setup

1. In the Spotify developer dashboard, open the app (client ID `2eb6f769c3bd4297a445fc13a4311b33`), choose Edit settings, and add the redirect URI `http://127.0.0.1:8888/`. Spotify does not accept `localhost`.
2. Under "Which API/SDKs are you planning to use", tick Web API and Web Playback SDK.
3. Run the server:

       python3 -m http.server 8888 --bind 127.0.0.1 --directory songless

4. Open http://127.0.0.1:8888/ in Chrome, Edge or Firefox and log in. Playing songs needs Spotify Premium.

## Notes

- `playlist.json` is a saved copy of the default playlist. You can load any other playlist from the link box under the game.
- Spotify blocks the audio-analysis endpoint for this app, so the game can't detect leading silence. If a clip is silent, use "Move the start 0.25 s later". The game remembers that offset for the song.
- Clip length is approximate, probably within a few tens of milliseconds, because the Spotify player starts and stops with some delay.
