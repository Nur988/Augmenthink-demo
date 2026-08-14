# Webflow AnythingLLM Chat Widget

A small floating chat widget for Webflow. The browser sends text and a public workspace name to an Express gateway. The gateway validates the request, maps the public name to an internal AnythingLLM workspace slug, and adds the private AnythingLLM API key server-side.

## Architecture

```text
Webflow page
  -> chat-widget.js
  -> Express gateway (/api/transcribe, /api/chat, /api/speech)
  -> OpenAI speech-to-text
  -> selected AnythingLLM workspace
  -> OpenAI text-to-speech
```

Neither the AnythingLLM API key nor the OpenAI API key is sent to the browser. AnythingLLM should remain bound to localhost or a private Docker network.

## Local setup

Requires Node.js 18 or newer and an AnythingLLM instance at `http://localhost:3001`.

```sh
cd chatbot/server
npm install
npm start
```

On a new installation, copy `.env.example` to `.env` and add both the AnythingLLM Developer API key and an OpenAI API key before starting. Open `http://localhost:3000` for a blank widget-only preview. The gateway also serves the widget assets, readiness endpoint, chat API, and audio API; Webflow provides the production page.

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
- Workspace switching for MirrorXR, Augmenthink, and Clevart.
- A Chat/Voice mode switch with accurate transcription, natural spoken replies, silence detection, hands-free follow-up turns, and tap-to-interrupt controls.
- A live readiness indicator backed by `GET /api/readiness`.
- A clear-chat control that starts a fresh browser and AnythingLLM session.

## Environment variables

| Variable | Example | Purpose |
| --- | --- | --- |
| `ANYTHINGLLM_URL` | `http://localhost:3001` | Private base URL of AnythingLLM |
| `ANYTHINGLLM_API_KEY` | `...` | AnythingLLM Developer API key; server only |
| `OPENAI_API_KEY` | `...` | OpenAI API key for STT and TTS; server only |
| `OPENAI_STT_MODEL` | `gpt-transcribe` | Recorded-audio transcription model |
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | Neural text-to-speech model |
| `OPENAI_TTS_VOICE` | `marin` | OpenAI built-in voice |
| `OPENAI_TTS_INSTRUCTIONS` | `Speak warmly...` | Optional delivery, pacing, and accent direction |
| `PORT` | `3000` | Express gateway port |
| `ALLOWED_ORIGIN` | `http://localhost:3000` | Exact browser origin allowed by CORS, without a path; use the Webflow origin in production |

Do not commit `server/.env`. If Webflow uses a custom production domain, set that exact origin. A Webflow staging domain and a custom domain are two different origins; this MVP accepts one configured origin.

## AnythingLLM setup

1. Configure OpenAI as the LLM provider inside AnythingLLM. Keep the OpenAI key there.
2. Create workspaces whose slugs match the server mappings: `mirrorxr`, `augmenthink`, and `clevart`.
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
  src="https://YOUR-GATEWAY.onrender.com/chat-widget.js?v=1"
  data-api-url="https://YOUR-GATEWAY.onrender.com"
  data-workspace="augmenthink">
</script>
```

Replace both hostnames with the same Render gateway hostname. Add the script in **Site settings > Custom code > Footer code** to show it throughout the site, or in a page's **Before `</body>`** code to limit it to one page. Publish the Webflow site before testing; the Designer canvas is not the production origin.

Set `data-workspace` to one of the public keys `mirrorxr`, `augmenthink`, or `clevart`. Omit it to use `augmenthink`.

In **Chat** mode, the microphone records a bounded utterance and fills the text field with the OpenAI transcript without submitting automatically. To opt in to automatic submission there, add `data-submit-speech="true"`. In **Voice** mode, the first tap starts a hands-free loop: record, stop after silence, transcribe with OpenAI, query AnythingLLM, generate OpenAI speech, play it, then listen for the next turn. Tapping the voice orb while the assistant is speaking interrupts playback.

## Voice architecture

The widget does not use `SpeechRecognition`, `webkitSpeechRecognition`, `speechSynthesis`, or `SpeechSynthesisUtterance`. It records compressed microphone audio with `MediaRecorder`, uses local volume analysis only to detect the end of an utterance, and sends the completed recording to the Express gateway. All OpenAI calls and credentials stay server-side.

```text
Browser MediaRecorder + silence detection
  -> POST /api/transcribe?workspace=...
  -> OpenAI gpt-transcribe
  -> AnythingLLM workspace chat
  -> full display formatter + separate speech-only formatter
  -> short-lived, session-bound speech ID
  -> GET /api/speech/:speechId (chunked stream)
  -> OpenAI gpt-4o-mini-tts (marin)
  -> streaming MP3 playback in the browser
```

The display formatter removes Markdown artifacts while preserving the full answer, including plain-text code content. The separate speech formatter removes fenced and inline code, URLs, emoji, citations, HTML, and formatting; turns lists into natural spoken transitions; normalizes punctuation; and caps only the TTS input. The speech-only string stays server-side and is fetched through a short-lived ID, so the browser never reposts the full answer for TTS. The UI includes microphone permission handling, automatic silence stop, a 45-second recording ceiling, request timeouts, interruption, automatic follow-up turns, synchronized text reveal, and the required AI-voice disclosure.

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
  "sources": [
    {
      "title": "Knowledge source",
      "excerpt": "Relevant supporting text",
      "url": "https://example.com/source"
    }
  ]
}
```

`GET /api/readiness` verifies that the AnythingLLM key works, confirms all three mapped workspaces are available, and reports whether the server-only OpenAI voice key is configured. It does not make a billable OpenAI request. It returns HTTP 200 when the complete chat-and-voice gateway is ready and HTTP 503 when configuration needs attention.

`POST /api/transcribe?workspace=augmenthink` accepts a raw `audio/webm`, `audio/mp4`, `audio/mpeg`, `audio/ogg`, or `audio/wav` body and returns `{ "success": true, "text": "..." }`. It sends the selected workspace name and portfolio vocabulary as transcription context. `GET /api/speech/:speechId?sessionId=...` streams `audio/mpeg`; speech IDs expire after two minutes and are bound to the originating browser session.

The gateway limits JSON bodies to 16 KB, recordings to 10 MB, messages to 4,000 characters, and each client IP to 60 chat requests or 40 voice requests per 15 minutes. AnythingLLM requests time out after 30 seconds and OpenAI audio requests after 45 seconds.

## Tests

```sh
cd chatbot/server
npm test
node --check server.js
node --check ../widget/chat-widget.js
```

The tests cover health, invalid input, arbitrary workspace rejection, CORS, workspace-to-upstream mapping, authorization forwarding, response normalization, malformed upstream data, speech formatting, OpenAI transcription uploads, OpenAI TTS audio, and missing voice credentials.

## MVP limitations

- Chat history is retained by AnythingLLM using the stored browser session ID; this widget does not render older messages after a page reload.
- `localStorage` sessions are browser- and origin-specific and can be cleared by the user.
- Transcription is file-based rather than token-streaming, so the transcript appears after silence is detected or the user taps stop.
- File transcription starts after silence is detected; the OpenAI Realtime API would be the next step if live partial transcripts become a requirement.
- The rate limiter is in memory. Use a shared store such as Redis when running more than one gateway process.
- CORS is not authentication. For private or abuse-sensitive deployments, add user authentication, bot protection, and Cloudflare rate limiting.
- The server accepts one Webflow origin. Supporting production and staging simultaneously requires an explicit origin allowlist change.
