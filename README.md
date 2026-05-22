# dbalarm

Static AO Labs microphone alarm for `https://dbalarm.aolabs.io/`.

The app runs in the browser, requests microphone access after a user gesture, computes a relative dB level from the microphone waveform, and sounds a synthesized alarm when the level stays above the configured threshold.

## Run Locally

```bash
npm start
```

Open `http://localhost:3035`.

## Deploy

This app is intended for GitHub Pages from the `main` branch root with `CNAME=dbalarm.aolabs.io`.

DNS needs one record:

| Type | Host | Answer |
| --- | --- | --- |
| CNAME | dbalarm | nalalalan.github.io |
