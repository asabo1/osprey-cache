# crude-signal-data

The public data pipeline for [crudesignal.io](https://crudesignal.io) — the real-time
wire for oil and the geopolitics that move it.

Everything here is fetched from public sources (exchange quote APIs, government
data, public RSS) on a schedule and committed as JSON. The site pulls this repo
at build time. Open datasets (crisis-score history, graded forecasting record,
sourced event log) live under `public/data/open/` — CC BY 4.0, cite
https://crudesignal.io/data.

This repo is public so the pipeline runs on GitHub's free public-repo Actions.
The code is not a supported library; interfaces change without notice.

Note: `src/data/track-record.json` is synced from the editorial repo on issue
weeks (Mondays); it is an input to the open-data build here, not authored here.
