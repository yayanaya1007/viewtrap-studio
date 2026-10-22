# Viewtrap Studio

A personal YouTube creator research dashboard with video search, channel search and analysis, and Gemini-assisted insights.

## API configuration

The server expects these environment variables:

- `YOUTUBE_API_KEY` for YouTube Data API v3
- `GEMINI_API_KEY` for Gemini

Set them in your hosting provider's secret or environment-variable settings. Do not commit API keys to the repository.

## Project layout

- `index.html`, `client.js`: browser interface
- `worker/index.js`: API worker source
- `dist/server/index.js`: generated server bundle
- `scripts/`: build and artifact validation scripts
