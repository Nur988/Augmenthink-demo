const assert = require("node:assert/strict");
const { once } = require("node:events");
const http = require("node:http");
const test = require("node:test");

const {
  createApp,
  formatDisplayText,
  formatSpeechText,
  getAssistantSources,
  splitSpeechText,
} = require("./server");

async function startTestServer(options = {}) {
  const server = http.createServer(createApp(options));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function postChat(url, body, headers = {}) {
  return fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("health endpoint reports ok", async (t) => {
  const gateway = await startTestServer();
  t.after(() => gateway.server.close());

  const response = await fetch(`${gateway.url}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("gateway serves a widget-only preview and widget assets", async (t) => {
  const gateway = await startTestServer();
  t.after(() => gateway.server.close());

  const pageResponse = await fetch(`${gateway.url}/`);
  assert.equal(pageResponse.status, 200);
  const preview = await pageResponse.text();
  assert.match(preview, /chat-widget\.js/);
  assert.doesNotMatch(preview, /Investor demo|portfolio|workspace-card/);

  const demoResponse = await fetch(`${gateway.url}/demo`);
  assert.equal(demoResponse.status, 404);

  const cssResponse = await fetch(`${gateway.url}/chat-widget.css`);
  assert.equal(cssResponse.status, 200);
  assert.match(cssResponse.headers.get("content-type"), /text\/css/);
  assert.match(cssResponse.headers.get("cache-control"), /no-store/);
  assert.match(cssResponse.headers.get("cache-control"), /must-revalidate/);
  assert.equal(cssResponse.headers.get("pragma"), "no-cache");
  assert.equal(cssResponse.headers.get("surrogate-control"), "no-store");

  const widgetResponse = await fetch(`${gateway.url}/chat-widget.js`);
  const widgetScript = await widgetResponse.text();
  assert.equal(widgetResponse.status, 200);
  assert.match(widgetResponse.headers.get("cache-control"), /no-store/);
  assert.doesNotMatch(widgetScript, /assistant-clear-button|clearConversation/);
  assert.doesNotMatch(widgetScript, /assistant-status|"Ready"|"Checking"/);
  assert.match(widgetScript, /assistant-chat-history-v1/);
  assert.match(widgetScript, /assistant-voice-indicator/);
  assert.match(widgetScript, /Processing voice input/);
  assert.match(widgetScript, /assistant-voice-replies-enabled/);
  assert.match(widgetScript, /spoken replies for voice input/);
  assert.match(widgetScript, /primeAudioPlayback/);
  assert.match(widgetScript, /SILENT_AUDIO_DATA_URI/);
  assert.match(widgetScript, /Play voice reply/);
  assert.match(widgetScript, /MAX_RECORDING_MS = 180000/);
  assert.match(widgetScript, /SILENCE_STOP_MS = 2000/);
  assert.match(widgetScript, /input\.maxLength = 8000/);
  assert.match(widgetScript, /latestScrollSettledFrame/);
  assert.match(widgetScript, /visualViewport\?\.addEventListener\("resize"/);
  assert.doesNotMatch(widgetScript, /const player = new Audio/);
  assert.match(widgetScript, /await sendMessage\(\{ fromVoice: true \}\)/);
  assert.doesNotMatch(widgetScript, /assistant-mode-switch|assistant:set-mode/);
  assert.match(widgetScript, /api\/speech/);
  assert.match(widgetScript, /speechPartCount/);
  assert.match(widgetScript, /searchParams\.set\("part"/);
  assert.doesNotMatch(widgetScript, /assistant-sources|createSources/);
  assert.doesNotMatch(widgetScript, /assistant-suggestions|Try asking|greeting:/);
  assert.match(widgetScript, /What would you like to know/);
  assert.doesNotMatch(widgetScript, /Knowledge assistant/);
  assert.match(widgetScript, /Creart Digital Media/);
  assert.match(widgetScript, /RaiseWisely/);
  assert.match(widgetScript, /Mirror XR/);
  assert.match(widgetScript, /assets\/au_logo\.png/);
  assert.doesNotMatch(widgetScript, /assets\/CLEO\.jpg/);
  assert.match(widgetScript, /widget-cache/);

  const logoResponse = await fetch(`${gateway.url}/assets/au_logo.png`);
  assert.equal(logoResponse.status, 200);
  assert.match(logoResponse.headers.get("content-type"), /image\/png/);
  assert.match(logoResponse.headers.get("cache-control"), /no-store/);
  assert.ok((await logoResponse.arrayBuffer()).byteLength > 0);
});

test("readiness confirms API access and required workspaces", async (t) => {
  const gateway = await startTestServer({
    anythingLlmUrl: "http://localhost:3001",
    anythingLlmApiKey: "test-key",
    openAiApiKey: "test-openai-key",
    openAiTtsVoice: "cedar",
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://localhost:3001/api/v1/workspaces");
      assert.equal(options.headers.Authorization, "Bearer test-key");
      return new Response(
        JSON.stringify({
          workspaces: [
            { slug: "mirrorxr" },
            { slug: "my-workspace" },
            { slug: "creart-digital-media" },
            { slug: "raise-wisely" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  t.after(() => gateway.server.close());

  const response = await fetch(`${gateway.url}/api/readiness`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ready: true,
    gateway: true,
    anythingLlm: true,
    apiConfigured: true,
    voice: {
      configured: true,
      sttModel: "gpt-transcribe",
      ttsModel: "gpt-4o-mini-tts",
      ttsVoice: "cedar",
    },
    workspaces: {
      clevart: true,
      augmenthink: true,
      raisewisely: true,
      mirrorxr: true,
    },
  });
});

test("chat endpoint rejects invalid and arbitrary workspaces", async (t) => {
  const gateway = await startTestServer({ anythingLlmApiKey: "test-key" });
  t.after(() => gateway.server.close());

  const response = await postChat(gateway.url, {
    message: "Hello",
    workspace: "../../admin",
    sessionId: "8a55767c-5e86-4a2c-b855-32253a414978",
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    success: false,
    error: "Invalid workspace.",
  });
});

test("chat endpoint validates empty messages and session IDs", async (t) => {
  const gateway = await startTestServer({ anythingLlmApiKey: "test-key" });
  t.after(() => gateway.server.close());

  const emptyMessage = await postChat(gateway.url, {
    message: "   ",
    workspace: "augmenthink",
    sessionId: "session-1",
  });
  assert.equal(emptyMessage.status, 400);

  const invalidSession = await postChat(gateway.url, {
    message: "Hello",
    workspace: "augmenthink",
    sessionId: "session id with spaces",
  });
  assert.equal(invalidSession.status, 400);
});

test("chat endpoint enforces the configured browser origin", async (t) => {
  const gateway = await startTestServer({
    allowedOrigin: "https://example.webflow.io",
    anythingLlmApiKey: "test-key",
  });
  t.after(() => gateway.server.close());

  const response = await postChat(
    gateway.url,
    { message: "Hello", workspace: "augmenthink", sessionId: "session-1" },
    { Origin: "https://malicious.example" },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    success: false,
    error: "Origin not allowed.",
  });
});

test("chat endpoint sends agent mode, maps workspace, and normalizes the response", async (t) => {
  let upstreamRequest;
  const gateway = await startTestServer({
    anythingLlmUrl: "http://anythingllm.internal:3001",
    anythingLlmApiKey: "server-only-secret",
    fetchImpl: async (url, options) => {
      upstreamRequest = { url, options };
      return new Response(JSON.stringify({ textResponse: "  Hello from AI  " }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  t.after(() => gateway.server.close());

  const response = await postChat(gateway.url, {
    message: "  Hello  ",
    workspace: "mirrorxr",
    sessionId: "session-1",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    message: "Hello from AI",
    sources: [],
  });
  assert.equal(
    upstreamRequest.url,
    "http://anythingllm.internal:3001/api/v1/workspace/mirrorxr/chat",
  );
  assert.equal(
    upstreamRequest.options.headers.Authorization,
    "Bearer server-only-secret",
  );
  assert.deepEqual(JSON.parse(upstreamRequest.options.body), {
    message: "@agent Hello",
    mode: "chat",
    sessionId: "session-1",
  });
});

test("chat endpoint does not duplicate an existing agent trigger", async (t) => {
  let upstreamRequest;
  const gateway = await startTestServer({
    anythingLlmApiKey: "test-key",
    fetchImpl: async (_url, options) => {
      upstreamRequest = options;
      return new Response(JSON.stringify({ textResponse: "Search complete" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  t.after(() => gateway.server.close());

  const response = await postChat(gateway.url, {
    message: "@Agent search the web for current news",
    workspace: "augmenthink",
    sessionId: "session-agent",
  });

  assert.equal(response.status, 200);
  assert.equal(
    JSON.parse(upstreamRequest.body).message,
    "@agent search the web for current news",
  );
});

test("source normalization keeps display text and safe web links", () => {
  assert.deepEqual(
    getAssistantSources({
      sources: [
        {
          title: "Investor brief",
          text: "Grounded context",
          url: "https://example.com/brief",
        },
        {
          metadata: { title: "Internal note" },
          chunk: "Supporting detail",
          url: "javascript:alert(1)",
        },
      ],
    }),
    [
      {
        title: "Investor brief",
        excerpt: "Grounded context",
        url: "https://example.com/brief",
      },
      { title: "Internal note", excerpt: "Supporting detail" },
    ],
  );
});

test("chat endpoint rejects malformed upstream responses", async (t) => {
  const gateway = await startTestServer({
    anythingLlmApiKey: "test-key",
    fetchImpl: async () =>
      new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
  });
  t.after(() => gateway.server.close());

  const response = await postChat(gateway.url, {
    message: "Hello",
    workspace: "augmenthink",
    sessionId: "session-1",
  });

  assert.equal(response.status, 502);
  assert.equal((await response.json()).success, false);
});

test("speech formatter stays aligned with the displayed response", () => {
  const source = `
# Result 🚀

- Read [the guide](https://example.com/docs).
- Visit https://example.com.
- Run \`inline_code()\` now.

\`\`\`js
console.log("not spoken");
\`\`\`
  `;
  const formatted = formatSpeechText(source);

  assert.equal(formatted, formatDisplayText(source));
  assert.match(formatted, /Result 🚀/);
  assert.match(formatted, /inline_code\(\)|console\.log/);
  assert.doesNotMatch(formatted, /```|\]\(/);
});

test("long spoken responses are split at natural API-safe boundaries", () => {
  const source = Array.from(
    { length: 80 },
    (_, index) => `Sentence ${index + 1} explains a useful next step clearly.`,
  ).join(" ");
  const chunks = splitSpeechText(source, 180);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 180));
  assert.equal(chunks.join(" "), formatSpeechText(source));
});

test("display formatter removes Markdown artifacts without truncating content", () => {
  const longTail = "Complete ending ".repeat(400);
  const formatted = formatDisplayText(
    `## Full answer\n- Read [the guide](https://example.com).\n\`inline\`\n\`\`\`js\nconst kept = true;\n\`\`\`\n${longTail}`,
  );

  assert.match(formatted, /^Full answer\n• Read the guide\./);
  assert.match(formatted, /inline/);
  assert.match(formatted, /const kept = true;/);
  assert.ok(formatted.endsWith(longTail.trim()));
  assert.doesNotMatch(formatted, /##|```|\]\(/);
});

test("transcription endpoint forwards recorded audio with accuracy context", async (t) => {
  let upstreamRequest;
  const gateway = await startTestServer({
    openAiApiKey: "openai-server-secret",
    openAiBaseUrl: "https://openai.test/v1",
    fetchImpl: async (url, options) => {
      upstreamRequest = { url, options };
      return new Response(
        JSON.stringify({ text: "  Tell me about Creart Digital Media.  " }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  });
  t.after(() => gateway.server.close());

  const response = await fetch(
    `${gateway.url}/api/transcribe?workspace=clevart`,
    {
      method: "POST",
      headers: { "Content-Type": "audio/webm;codecs=opus" },
      body: Buffer.from("recorded-audio"),
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    text: "Tell me about Creart Digital Media.",
  });
  assert.equal(upstreamRequest.url, "https://openai.test/v1/audio/transcriptions");
  assert.equal(
    upstreamRequest.options.headers.Authorization,
    "Bearer openai-server-secret",
  );
  assert.equal(upstreamRequest.options.body.get("model"), "gpt-transcribe");
  assert.equal(upstreamRequest.options.body.get("languages[]"), "en");
  assert.equal(upstreamRequest.options.body.get("language"), null);
  assert.match(
    upstreamRequest.options.body.get("prompt"),
    /Creart Digital Media/,
  );
  assert.ok(
    upstreamRequest.options.body
      .getAll("keywords[]")
      .includes("Creart Digital Media"),
  );
  assert.equal(
    await upstreamRequest.options.body.get("file").text(),
    "recorded-audio",
  );
});

test("speech endpoint streams cached speech-safe text as audio", async (t) => {
  let upstreamRequest;
  const audio = Buffer.from([0x49, 0x44, 0x33, 0x04]);
  const gateway = await startTestServer({
    anythingLlmApiKey: "anything-server-secret",
    openAiApiKey: "openai-server-secret",
    openAiBaseUrl: "https://openai.test/v1",
    openAiTtsVoice: "cedar",
    openAiTtsSpeed: 1.2,
    openAiTtsInstructions:
      "Speak in British English (en-GB) with a +1.6 pitch adjustment.",
    fetchImpl: async (url, options) => {
      if (url.includes("/api/v1/workspace/")) {
        return new Response(
          JSON.stringify({
            textResponse:
              "## Update ✨\n- Read [the brief](https://example.com).\n- Run `secret_code()` now.",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      upstreamRequest = { url, options };
      return new Response(audio, {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      });
    },
  });
  t.after(() => gateway.server.close());

  const chatResponse = await postChat(gateway.url, {
    message: "Give me the update",
    workspace: "augmenthink",
    sessionId: "session-voice-1",
    voice: true,
  });
  const chatPayload = await chatResponse.json();
  assert.equal(chatResponse.status, 200);
  assert.equal(
    chatPayload.message,
    "Update ✨\n• Read the brief.\n• Run secret_code() now.",
  );
  assert.match(chatPayload.speechId, /^[0-9a-f-]{36}$/);
  assert.equal(chatPayload.speechPartCount, 1);

  const response = await fetch(
    `${gateway.url}/api/speech/${chatPayload.speechId}?sessionId=session-voice-1`,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(response.headers.get("x-speech-part"), "0");
  assert.equal(response.headers.get("x-speech-part-count"), "1");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
  assert.equal(upstreamRequest.url, "https://openai.test/v1/audio/speech");
  assert.equal(
    upstreamRequest.options.headers.Authorization,
    "Bearer openai-server-secret",
  );
  const body = JSON.parse(upstreamRequest.options.body);
  assert.equal(body.model, "gpt-4o-mini-tts");
  assert.equal(body.voice, "cedar");
  assert.equal(body.input, chatPayload.message);
  assert.equal(
    body.input,
    "Update ✨\n• Read the brief.\n• Run secret_code() now.",
  );
  assert.match(body.instructions, /British English \(en-GB\)/i);
  assert.match(body.instructions, /\+1\.6 pitch adjustment/i);
  assert.equal(body.speed, 1.2);
  assert.equal(body.response_format, "mp3");
});

test("long speech replies are served as separately playable audio parts", async (t) => {
  const spokenInputs = [];
  const longReply = `${"A complete opening sentence. ".repeat(130)}${
    "A complete closing sentence. ".repeat(40)
  }`.trim();
  const gateway = await startTestServer({
    anythingLlmApiKey: "anything-server-secret",
    openAiApiKey: "openai-server-secret",
    openAiBaseUrl: "https://openai.test/v1",
    fetchImpl: async (url, options) => {
      if (url.includes("/api/v1/workspace/")) {
        return Response.json({ textResponse: longReply });
      }
      const body = JSON.parse(options.body);
      spokenInputs.push(body.input);
      return new Response(Buffer.from([0x49, 0x44, 0x33, spokenInputs.length]), {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      });
    },
  });
  t.after(() => gateway.server.close());

  const chatResponse = await postChat(gateway.url, {
    message: "Give me the full response",
    workspace: "augmenthink",
    sessionId: "session-long-voice",
    voice: true,
  });
  const chatPayload = await chatResponse.json();
  assert.equal(chatResponse.status, 200);
  assert.ok(chatPayload.speechPartCount > 1);

  for (let part = 0; part < chatPayload.speechPartCount; part += 1) {
    const response = await fetch(
      `${gateway.url}/api/speech/${chatPayload.speechId}?sessionId=session-long-voice&part=${part}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-speech-part"), String(part));
    assert.equal(
      response.headers.get("x-speech-part-count"),
      String(chatPayload.speechPartCount),
    );
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      Buffer.from([0x49, 0x44, 0x33, part + 1]),
    );
  }

  assert.equal(spokenInputs.length, chatPayload.speechPartCount);
  assert.equal(spokenInputs.join(" "), chatPayload.message);
});

test("voice endpoints require a server-side OpenAI key", async (t) => {
  const gateway = await startTestServer({ openAiApiKey: "" });
  t.after(() => gateway.server.close());

  const transcription = await fetch(`${gateway.url}/api/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "audio/webm" },
    body: Buffer.from("audio"),
  });
  const speech = await fetch(
    `${gateway.url}/api/speech/not-cached?sessionId=session-1`,
  );

  assert.equal(transcription.status, 503);
  assert.equal(speech.status, 503);
});
