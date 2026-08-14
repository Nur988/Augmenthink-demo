# Engineering Notes

## Boundaries

- The browser talks only to the Express gateway. Never add an AnythingLLM or OpenAI secret to `widget/`.
- Public workspace keys must be resolved through `WORKSPACES` in `server/server.js`; never forward a browser-provided slug directly.
- Render user and assistant text with DOM text nodes or `textContent`.

## Verification

Run these commands from `chatbot/server` after backend or widget changes:

```sh
npm test
node --check server.js
node --check ../widget/chat-widget.js
```

Use Node.js 18 or newer.
