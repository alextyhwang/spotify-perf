# spotify-perf

A [Spicetify](https://spicetify.app) extension that makes the Spotify desktop client lighter on CPU, GPU and battery. It is one JavaScript file with no build step. Every fix has a switch in the profile menu under **spotify-perf**.

## What it fixes

Spotify measured on macOS (Apple silicon), client 1.2.71, playing music with Spotify in the background.

| Fix | Problem it removes |
|---|---|
| **Lightweight player bar** | The progress bar restarts a 1-second CSS transition every second, so the renderer and GPU repaint nonstop, even in the background. Each tick also made Chromium re-lay out the whole app (~5,700 layout objects, ~18 ms) to move one bar. The fix removes the transition (the bar steps a few pixels per second, which you won't notice) and makes the playback bar its own layout boundary with CSS containment. |
| **Pause animations in background** | Spotify keeps running UI animations while another app has focus. They are paused while Spotify is hidden or unfocused, and resume when you come back. Audio, timers and `requestAnimationFrame` are untouched. It also re-checks focus every 5 s, because a blur during startup is never delivered and used to leave Spotify in foreground mode. |
| **Idle Spicy Lyrics sync** | [Spicy Lyrics](https://github.com/Spikerko/spicy-lyrics) asks Spotify's main process for the playback position every frame (60 times a second), forever, even with no lyrics on screen. While no lyrics are visible, that one timer is stretched to once per second. It returns to per-frame polling as soon as lyrics show (the lyrics page with Spotify focused, or popup lyrics). It does nothing if Spicy Lyrics isn't installed. |

### Measurements

CPU per Spotify process, same machine and track, Spotify in the background:

| Process | Stock | With spotify-perf |
|---|---|---|
| Renderer (UI) | 22–100% | 0.2–1.2% |
| GPU helper | 14–20% | ~0.3% |
| Main | 3–4% | ~2% |

Canvas videos were not the cause of the renderer load in these tests. You can still turn them off in Spotify's Settings → Display.

## Install

```sh
curl -fsSL -o ~/.config/spicetify/Extensions/spotify-perf.js \
  https://raw.githubusercontent.com/alextyhwang/spotify-perf/main/spotify-perf.js
spicetify config extensions spotify-perf.js
spicetify apply
```

Or install it from the Spicetify Marketplace (search "spotify-perf").

The Spicy Lyrics performance fork's companion (`spotify-background-performance.js`) does the same background-animation pausing. Use one or the other. If both are installed, whichever loads first runs and the other steps aside.

## How it works

- **Player bar:** two CSS rules: `transition: none` on the progress fill, and `contain: strict` on `.playback-bar`.
- **Background animations:** wraps `Element.prototype.animate` and pauses running Web Animations while unfocused. CSS keyframes are paused with `animation-play-state` under an `html.spotify-performance-background` class. Animations inside Spicy Lyrics' views are left to Spicy Lyrics.
- **Lyrics sync:** wraps `window.setTimeout`. Only calls whose delay is exactly one frame (1000/60 ms) and whose call stack comes from a `spicy-lyrics` script are changed, and only while no lyrics are visible. Every other timer passes through untouched.

`window.SpotifyPerf.status()` in DevTools shows what each feature is doing.

## Compatibility

It relies on Spotify's class names and test ids (`.playback-bar`, `[data-testid=playback-progressbar]`). A Spotify update can rename these. If that happens the affected fix stops applying and Spotify just behaves as stock; nothing breaks.

Tested with Spotify 1.2.71 and Spicetify 2.45.

## Development

```sh
bun test
```

## License

MIT
