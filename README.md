# Viewtrap Studio

A personal YouTube creator research dashboard with video search, channel search and analysis, and Gemini-assisted insights.

## Use your own API keys

Open **API 설정** in the app and add your own keys:

- YouTube Data API v3
- Gemini API

Keys are stored in browser storage scoped to the signed-in Site user. They are not committed to this repository or saved as shared server secrets. The app sends them to its server only when processing requests, and the server uses them for Google API calls without storing them. Use an account and browser profile you control, and remove keys from API settings when you no longer use this browser.

## Project layout

- `index.html`, `client.js`: browser interface
- `worker/index.js`: API worker source
- `dist/server/index.js`: generated server bundle
- `scripts/`: build and artifact validation scripts
