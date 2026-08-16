# Webflow AnythingLLM Chat Widget

A small floating chat widget for Webflow. The browser sends text and a public workspace name to an Express gateway. The gateway validates the request, maps the public name to an internal AnythingLLM workspace slug, invokes AnythingLLM agent mode, and adds the private AnythingLLM API key server-side.

## Architecture

```text
Webflow page
  -> chat-widget.js
  -> Express gateway (/api/transcribe, /api/chat, /api/speech)
  -> OpenAI speech-to-text for microphone input
  -> OpenAI text-to-speech for optional spoken replies
  -> selected AnythingLLM workspace
```

Neither the AnythingLLM API key nor the OpenAI API key is sent to the browser. AnythingLLM should remain bound to localhost or a private Docker network.

## Local setup

Requires Node.js 18 or newer and an AnythingLLM instance at `http://localhost:3001`.

```sh
cd chatbot/server
npm install
npm start
```

On a new installation, copy `.env.example` to `.env` and add both the AnythingLLM Developer API key and an OpenAI API key before starting. Open `http://localhost:3000` for a blank widget-only preview. The gateway also serves the widget assets, readiness endpoint, chat API, and transcription API; Webflow provides the production page.

Confirm the gateway is running:

```sh
curl http://localhost:3000/health
```

Expected response:

```json
{"status":"ok"}
```

For a separate page or Webflow embed, use:

```html
<script
  src="http://localhost:3000/chat-widget.js"
  data-api-url="http://localhost:3000"
  data-workspace="augmenthink">
</script>
```

The script injects a Shadow DOM widget, derives the gateway URL from its own script URL, and loads its stylesheet from the same host. `data-api-url` can be omitted when both assets and API use the same hostname.

## Widget features

The embedded widget provides:

- An empty conversation area ready for the visitor's first question.
- Workspace switching for Creart Digital Media, Augmenthink, RaiseWisely, and Mirror XR.
- One chat interface for typed and microphone input, with every turn displayed as text.
- AnythingLLM agent mode for every message, including web search when the Web Browsing agent skill is enabled.
- Browser-persistent chat history for each workspace across visits.
- A microphone button with accurate transcription, silence detection, and automatic submission.
- A top-right speaker button that enables spoken assistant replies for microphone-origin messages, remembers the visitor's choice, and unlocks playback during a direct tap for mobile browsers.
- An inline Play voice reply fallback when a phone blocks automatic audio playback.
- A responsive full-screen mobile layout with safe-area spacing, touch-friendly controls, and keyboard-aware composer sizing.
- A background readiness check backed by `GET /api/readiness`.

## Environment variables

| Variable | Example | Purpose |
| --- | --- | --- |
| `ANYTHINGLLM_URL` | `http://localhost:3001` | Private base URL of AnythingLLM |
| `ANYTHINGLLM_API_KEY` | `...` | AnythingLLM Developer API key; server only |
| `OPENAI_API_KEY` | `...` | OpenAI API key for STT and TTS; server only |
| `OPENAI_STT_MODEL` | `gpt-transcribe` | Recorded-audio transcription model |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | Neural text-to-speech model |
| `OPENAI_TTS_VOICE` | `cedar` | High-quality OpenAI voice used to approximate the reference voice |
| `OPENAI_TTS_SPEED` | `1.2` | Speech speed multiplier; OpenAI accepts values from 0.25 to 4.0 |
| `OPENAI_TTS_INSTRUCTIONS` | `Speak in polished British English...` | Delivery instructions approximating en-GB, a male-presenting voice, and elevated pitch |
| `PORT` | `3000` | Express gateway port |
| `ALLOWED_ORIGIN` | `http://localhost:3000` | Exact browser origin allowed by CORS, without a path; use the Webflow origin in production |

Do not commit `server/.env`. If Webflow uses a custom production domain, set that exact origin. A Webflow staging domain and a custom domain are two different origins; this MVP accepts one configured origin.

## AnythingLLM setup

1. Configure OpenAI as the LLM provider inside AnythingLLM. Keep the OpenAI key there.
2. Create workspaces whose slugs match the server mappings: `creart-digital-media`, `my-workspace`, `raise-wisely`, and `mirrorxr`. Their public widget keys remain `clevart`, `augmenthink`, `raisewisely`, and `mirrorxr`.
3. Add the documents and system prompt appropriate to each workspace.
4. In AnythingLLM, open **Settings > Developer API**, create an API key, and put it only in `server/.env` as `ANYTHINGLLM_API_KEY`.
5. Keep AnythingLLM reachable privately at the value of `ANYTHINGLLM_URL`. Do not create a public tunnel to port 3001.

To use different internal slugs, edit `WORKSPACES` in `server/server.js`. The keys are the only values accepted from the browser; the values are the internal AnythingLLM slugs.

## Render deployment

Deploy this repository as a Node Web Service after deploying AnythingLLM in the same Render region. Use these settings:

| Render setting | Value |
| --- | --- |
| Root Directory | `chatbot` |
| Build Command | `cd server && npm ci` |
| Start Command | `cd server && npm start` |
| Health Check Path | `/health` |

Use `chatbot`, not `chatbot/server`, as the root directory because the server loads the sibling `widget` directory at runtime. Set `ANYTHINGLLM_URL` to the deployed AnythingLLM service's internal Render URL, then add the remaining values from the environment-variable table as Render secrets. Do not set `PORT`; Render supplies it.

Set `ALLOWED_ORIGIN` to the exact published Webflow origin, such as `https://example.webflow.io` or `https://www.example.com`. The current gateway permits one external Webflow origin at a time.

## Webflow embed

Add this exact shape in Webflow **Site settings > Custom code > Footer code**, or in an Embed element on the required page:

```html
<script
  src="https://YOUR-GATEWAY.onrender.com/chat-widget.js"
  data-api-url="https://YOUR-GATEWAY.onrender.com"
  data-workspace="augmenthink">
</script>
```

Replace both hostnames with the same Render gateway hostname. Add the script in **Site settings > Custom code > Footer code** to show it throughout the site, or in a page's **Before `</body>`** code to limit it to one page. Publish the Webflow site before testing; the Designer canvas is not the production origin.

The gateway marks the widget JavaScript, stylesheet, and logo as non-cacheable and gives dependent assets a fresh query key on every page load. Normal reloads therefore pick up UI changes without manually changing a version number or performing a hard reload.

Set `data-workspace` to one of the public keys `clevart`, `augmenthink`, `raisewisely`, or `mirrorxr`. Omit it to use `augmenthink`.

Visitors can type and send normally or tap the microphone button to record a bounded utterance. Microphone input stops after silence (or another tap), is transcribed with OpenAI, and is submitted automatically. The transcript and the assistant's response both appear as normal text messages in the same chat window. When the top-right speaker button is enabled, responses to microphone input are also played aloud; typed messages remain text-only.

## Microphone input architecture

The widget does not use `SpeechRecognition`, `webkitSpeechRecognition`, `speechSynthesis`, or `SpeechSynthesisUtterance`. It records compressed microphone audio with `MediaRecorder`, uses local volume analysis only to detect the end of an utterance, and sends the completed recording to the Express gateway. All OpenAI calls and credentials stay server-side.

```text
Browser MediaRecorder + silence detection
  -> POST /api/transcribe?workspace=...
  -> OpenAI gpt-transcribe
  -> AnythingLLM workspace chat
  -> text response in the chat window
  -> when spoken replies are enabled: short-lived speech ID
  -> GET /api/speech/:speechId?part=0, part=1, ...
  -> OpenAI text-to-speech
  -> audio playback in the browser
```

The display formatter removes Markdown artifacts while preserving the full answer, including plain-text code content. The UI includes microphone permission handling, automatic silence stop after a natural two-second pause, a three-minute recording ceiling, request timeouts, tap-to-stop controls, visible loading/playback states on the speaker button, mobile audio unlocking, and an explicit playback fallback when autoplay is restricted. Long spoken replies are split into API-safe audio parts and played sequentially as one complete response. Chat messages, session IDs, and the spoken-reply preference are stored in browser local storage.

## API behavior

`POST /api/chat` accepts:

```json
{
  "message": "Hello",
  "workspace": "augmenthink",
  "sessionId": "a-browser-generated-uuid",
  "voice": true
}
```

Successful responses are normalized to:

```json
{
  "success": true,
  "message": "Assistant response",
  "speechId": "short-lived-id-present-for-voice-turns",
  "speechPartCount": 1,
  "sources": [
    {
      "title": "Knowledge source",
      "excerpt": "Relevant supporting text",
      "url": "https://example.com/source"
    }
  ]
}
```

`GET /api/readiness` verifies that the AnythingLLM key works, confirms all four mapped workspaces are available, and reports whether the server-only OpenAI voice key is configured. It does not make a billable OpenAI request. It returns HTTP 200 when the complete chat-and-voice gateway is ready and HTTP 503 when configuration needs attention.

`POST /api/transcribe?workspace=augmenthink` accepts a raw `audio/webm`, `audio/mp4`, `audio/mpeg`, `audio/ogg`, or `audio/wav` body and returns `{ "success": true, "text": "..." }`. It sends the selected workspace name and portfolio vocabulary as transcription context. `GET /api/speech/:speechId?sessionId=...&part=0` streams one playable `audio/mpeg` part; the widget advances through every part reported by `speechPartCount`. Speech IDs are bound to the originating browser session and expire after 30 minutes of inactivity.

The gateway limits JSON bodies to 32 KB, recordings to 24 MB, messages to 8,000 characters, and each client IP to 60 chat requests or 40 voice requests per 15 minutes. AnythingLLM requests time out after 30 seconds and OpenAI audio requests after three minutes.

## Tests

```sh
cd chatbot/server
npm test
node --check server.js
node --check ../widget/chat-widget.js
```

The tests cover health, invalid input, arbitrary workspace rejection, CORS, workspace-to-upstream mapping, authorization forwarding, response normalization, malformed upstream data, voice/text response alignment, OpenAI transcription uploads, OpenAI TTS audio, and missing voice credentials.

## MVP limitations

- Visible chat history and AnythingLLM session IDs are retained per workspace until the visitor clears browser storage.
- `localStorage` sessions are browser- and origin-specific and can be cleared by the user.
- Transcription is file-based rather than token-streaming, so the transcript is sent and displayed after silence is detected or the user taps stop.
- File transcription starts after silence is detected; the OpenAI Realtime API would be the next step if live partial transcripts become a requirement.
- The rate limiter is in memory. Use a shared store such as Redis when running more than one gateway process.
- CORS is not authentication. For private or abuse-sensitive deployments, add user authentication, bot protection, and Cloudflare rate limiting.
- The server accepts one Webflow origin. Supporting production and staging simultaneously requires an explicit origin allowlist change.
