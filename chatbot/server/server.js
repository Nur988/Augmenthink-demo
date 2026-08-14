const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const cors = require("cors");
const dotenv = require("dotenv");
const express = require("express");
const { rateLimit } = require("express-rate-limit");

dotenv.config();

const DEFAULT_PORT = 3000;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_SPEECH_OUTPUT_LENGTH = 3800;
const READINESS_TIMEOUT_MS = 5000;
const UPSTREAM_TIMEOUT_MS = 30000;
const OPENAI_AUDIO_TIMEOUT_MS = 45000;
const SPEECH_CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_SPEECH_CACHE_ENTRIES = 200;

const AUDIO_FILE_EXTENSIONS = Object.freeze({
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/x-m4a": "m4a",
  "audio/x-wav": "wav",
});

const WORKSPACES = Object.freeze({
  mirrorxr: "mirrorxr",
  augmenthink: "augmenthink",
  clevart: "clevart",
});

function normalizeOrigin(value) {
  return value ? value.trim().replace(/\/$/, "") : "";
}

function getAssistantMessage(payload) {
  const candidates = [
    payload?.textResponse,
    payload?.message,
    payload?.response,
    payload?.data?.message,
    payload?.data?.textResponse,
  ];

  return candidates.find(
    (candidate) => typeof candidate === "string" && candidate.trim().length > 0,
  );
}

function normalizeHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch (_error) {
    return null;
  }
}

function getAssistantSources(payload) {
  const candidates = payload?.sources || payload?.data?.sources;
  if (!Array.isArray(candidates)) return [];

  return candidates.slice(0, 5).map((source, index) => {
    const item = source && typeof source === "object" ? source : {};
    const titleCandidates = [
      item.title,
      item.name,
      item.metadata?.title,
      item.metadata?.name,
    ];
    const excerptCandidates = [
      item.text,
      item.chunk,
      item.content,
      item.description,
    ];
    const urlCandidates = [item.url, item.link, item.metadata?.url];
    const title =
      titleCandidates.find(
        (value) => typeof value === "string" && value.trim().length > 0,
      ) || `Knowledge source ${index + 1}`;
    const excerpt = excerptCandidates.find(
      (value) => typeof value === "string" && value.trim().length > 0,
    );
    const url = urlCandidates.map(normalizeHttpUrl).find(Boolean);

    return {
      title: title.trim().slice(0, 160),
      ...(excerpt ? { excerpt: excerpt.trim().slice(0, 280) } : {}),
      ...(url ? { url } : {}),
    };
  });
}

function getWorkspaceSlugs(payload) {
  const candidates = payload?.workspaces || payload?.data?.workspaces || payload?.data;
  if (!Array.isArray(candidates)) return [];

  return candidates
    .map((workspace) => workspace?.slug)
    .filter((slug) => typeof slug === "string");
}

function validateChatRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Request body must be a JSON object.";
  }

  if (typeof body.message !== "string" || body.message.trim().length === 0) {
    return "Message is required.";
  }

  if (body.message.trim().length > MAX_MESSAGE_LENGTH) {
    return `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`;
  }

  if (typeof body.workspace !== "string" || !WORKSPACES[body.workspace]) {
    return "Invalid workspace.";
  }

  if (
    typeof body.sessionId !== "string" ||
    body.sessionId.length < 1 ||
    body.sessionId.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(body.sessionId)
  ) {
    return "Invalid session ID.";
  }

  if (body.voice !== undefined && typeof body.voice !== "boolean") {
    return "Voice must be a boolean.";
  }

  return null;
}

function formatDisplayText(input) {
  if (typeof input !== "string") return "";

  return decodeSpeechEntities(input.normalize("NFKC"))
    .replace(/```[^\n]*\n?/g, "")
    .replace(/~~~[^\n]*\n?/g, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>+\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1$2")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function convertSpeechLists(input) {
  const lines = input.split("\n");
  const output = [];
  const naturalizeItem = (item) =>
    item.replace(
      /^(Ask|Check|Choose|Compare|Consider|Open|Read|Review|Run|Select|Start|Use|Visit)\b/,
      (word) => word.toLowerCase(),
    );

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*(?:[-*+•]|\d+[.)])\s+(.+)$/);
    if (!match) {
      output.push(lines[index]);
      continue;
    }

    const items = [];
    while (index < lines.length) {
      const item = lines[index].match(/^\s*(?:[-*+•]|\d+[.)])\s+(.+)$/);
      if (!item) break;
      items.push(item[1].trim().replace(/[.;:,]+$/, ""));
      index += 1;
    }
    index -= 1;

    const sentences = items.map((item, itemIndex) => {
      let transition = "";
      if (items.length > 1) {
        if (itemIndex === 0) transition = "First, ";
        else if (itemIndex === items.length - 1) transition = "Finally, ";
        else transition = "Next, ";
      }
      return `${transition}${naturalizeItem(item)}.`;
    });
    output.push(sentences.join(" "));
  }

  return output.join("\n");
}

function decodeSpeechEntities(value) {
  const namedEntities = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|(amp|apos|gt|lt|nbsp|quot));/gi,
    (match, decimal, hexadecimal, named) => {
      const codePoint = decimal
        ? Number.parseInt(decimal, 10)
        : hexadecimal
          ? Number.parseInt(hexadecimal, 16)
          : null;
      if (codePoint !== null) {
        return Number.isInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : " ";
      }
      return namedEntities[named.toLowerCase()] || match;
    },
  );
}

function formatSpeechText(input, maxLength = MAX_SPEECH_OUTPUT_LENGTH) {
  if (typeof input !== "string") return "";

  let text = decodeSpeechEntities(input.normalize("NFKC"));
  text = text
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ")
    .replace(/```[\s\S]*$|~~~[\s\S]*$/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1 ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/\[(?:source\s*)?\d+(?:\s*,\s*\d+)*\]/gi, "")
    .replace(/(?:https?:\/\/|www\.)[^\s)]+/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, "$1. ")
    .replace(/^\s*>+\s?/gm, "")
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, "")
    .replace(/\|/g, ". ")
    .replace(/[*_~]/g, "")
    .replace(
      /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200D\u20E3\uFE0E\uFE0F]/gu,
      "",
    );
  text = convertSpeechLists(text)
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ");
  text = text
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= maxLength) return text;
  const candidate = text.slice(0, maxLength - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("? "),
    candidate.lastIndexOf("! "),
  );
  const wordEnd = candidate.lastIndexOf(" ");
  const cutAt = sentenceEnd >= maxLength * 0.65 ? sentenceEnd + 1 : wordEnd;
  return `${candidate.slice(0, Math.max(cutAt, 1)).trim()}…`;
}

function createApp(options = {}) {
  const app = express();
  const anythingLlmUrl = (
    options.anythingLlmUrl ||
    process.env.ANYTHINGLLM_URL ||
    "http://localhost:3001"
  ).replace(/\/$/, "");
  const anythingLlmApiKey =
    options.anythingLlmApiKey || process.env.ANYTHINGLLM_API_KEY || "";
  const openAiApiKey = options.openAiApiKey ?? process.env.OPENAI_API_KEY ?? "";
  const openAiBaseUrl = (
    options.openAiBaseUrl ||
    process.env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  const openAiSttModel =
    options.openAiSttModel || process.env.OPENAI_STT_MODEL || "gpt-transcribe";
  const openAiTtsModel =
    options.openAiTtsModel || process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
  const openAiTtsVoice =
    options.openAiTtsVoice || process.env.OPENAI_TTS_VOICE || "marin";
  const openAiTtsInstructions =
    options.openAiTtsInstructions ||
    process.env.OPENAI_TTS_INSTRUCTIONS ||
    "Speak warmly and naturally, with confident conversational pacing, subtle emotional variation, and clear Australian English pronunciation. Avoid sounding like an announcer.";
  const allowedOrigin = normalizeOrigin(
    options.allowedOrigin || process.env.ALLOWED_ORIGIN || "http://localhost:3000",
  );
  const fetchImpl = options.fetchImpl || global.fetch;
  const speechCache = new Map();

  function pruneSpeechCache(now = Date.now()) {
    for (const [id, item] of speechCache) {
      if (item.expiresAt <= now) speechCache.delete(id);
    }
    while (speechCache.size >= MAX_SPEECH_CACHE_ENTRIES) {
      speechCache.delete(speechCache.keys().next().value);
    }
  }

  function cacheSpeech(text, sessionId) {
    pruneSpeechCache();
    const id = randomUUID();
    speechCache.set(id, {
      text,
      sessionId,
      expiresAt: Date.now() + SPEECH_CACHE_TTL_MS,
    });
    return id;
  }

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  app.use((request, response, next) => {
    const requestOrigin = normalizeOrigin(
      `${request.protocol}://${request.get("host")}`,
    );
    return cors({
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type"],
      origin(origin, callback) {
        const normalizedOrigin = normalizeOrigin(origin);
        if (
          !origin ||
          normalizedOrigin === allowedOrigin ||
          normalizedOrigin === requestOrigin
        ) {
          callback(null, true);
          return;
        }

        const error = new Error("Origin not allowed");
        error.status = 403;
        callback(error);
      },
    })(request, response, next);
  });

  app.use(express.json({ limit: "16kb", strict: true }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  const widgetDirectory = path.resolve(__dirname, "../widget");
  app.get("/", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.sendFile(path.join(widgetDirectory, "preview.html"));
  });
  app.get("/chat-widget.js", (_request, response) => {
    response.setHeader("Cache-Control", "public, max-age=300");
    response.sendFile(path.join(widgetDirectory, "chat-widget.js"));
  });
  app.get("/chat-widget.css", (_request, response) => {
    response.setHeader("Cache-Control", "public, max-age=300");
    response.sendFile(path.join(widgetDirectory, "chat-widget.css"));
  });

  app.get("/api/readiness", async (_request, response) => {
    if (!anythingLlmApiKey) {
      response.status(503).json({
        ready: false,
        gateway: true,
        anythingLlm: false,
        apiConfigured: false,
        voice: {
          configured: Boolean(openAiApiKey),
          sttModel: openAiSttModel,
          ttsModel: openAiTtsModel,
          ttsVoice: openAiTtsVoice,
        },
        workspaces: Object.fromEntries(
          Object.keys(WORKSPACES).map((workspace) => [workspace, false]),
        ),
      });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), READINESS_TIMEOUT_MS);

    try {
      const upstreamResponse = await fetchImpl(`${anythingLlmUrl}/api/v1/workspaces`, {
        headers: { Authorization: `Bearer ${anythingLlmApiKey}` },
        signal: controller.signal,
      });
      if (!upstreamResponse.ok) throw new Error("AnythingLLM is unavailable");

      const slugs = getWorkspaceSlugs(await upstreamResponse.json());
      const workspaces = Object.fromEntries(
        Object.entries(WORKSPACES).map(([publicKey, slug]) => [
          publicKey,
          slugs.includes(slug),
        ]),
      );
      const anythingLlmReady = Object.values(workspaces).every(Boolean);
      const ready = anythingLlmReady && Boolean(openAiApiKey);
      response.status(ready ? 200 : 503).json({
        ready,
        gateway: true,
        anythingLlm: true,
        apiConfigured: true,
        voice: {
          configured: Boolean(openAiApiKey),
          sttModel: openAiSttModel,
          ttsModel: openAiTtsModel,
          ttsVoice: openAiTtsVoice,
        },
        workspaces,
      });
    } catch (_error) {
      response.status(503).json({
        ready: false,
        gateway: true,
        anythingLlm: false,
        apiConfigured: true,
        voice: {
          configured: Boolean(openAiApiKey),
          sttModel: openAiSttModel,
          ttsModel: openAiTtsModel,
          ttsVoice: openAiTtsVoice,
        },
        workspaces: Object.fromEntries(
          Object.keys(WORKSPACES).map((workspace) => [workspace, false]),
        ),
      });
    } finally {
      clearTimeout(timeout);
    }
  });

  const chatLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      success: false,
      error: "Too many messages. Please wait a few minutes and try again.",
    },
  });
  const voiceLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 40,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      success: false,
      error: "Too many voice requests. Please wait a few minutes and try again.",
    },
  });

  app.post("/api/chat", chatLimiter, async (request, response) => {
    const validationError = validateChatRequest(request.body);
    if (validationError) {
      response.status(400).json({ success: false, error: validationError });
      return;
    }

    if (!anythingLlmApiKey) {
      console.error("ANYTHINGLLM_API_KEY is not configured.");
      response.status(503).json({
        success: false,
        error: "The assistant is not configured yet. Please try again later.",
      });
      return;
    }

    const workspaceSlug = WORKSPACES[request.body.workspace];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    try {
      const upstreamResponse = await fetchImpl(
        `${anythingLlmUrl}/api/v1/workspace/${encodeURIComponent(workspaceSlug)}/chat`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${anythingLlmApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: request.body.message.trim(),
            mode: "chat",
            sessionId: request.body.sessionId,
          }),
          signal: controller.signal,
        },
      );

      if (!upstreamResponse.ok) {
        console.error(`AnythingLLM returned HTTP ${upstreamResponse.status}.`);
        response.status(502).json({
          success: false,
          error: "The assistant could not answer right now. Please try again.",
        });
        return;
      }

      let upstreamPayload;
      try {
        upstreamPayload = await upstreamResponse.json();
      } catch (_error) {
        response.status(502).json({
          success: false,
          error: "The assistant returned an invalid response. Please try again.",
        });
        return;
      }

      const assistantMessage = getAssistantMessage(upstreamPayload);
      if (!assistantMessage) {
        response.status(502).json({
          success: false,
          error: "The assistant returned an invalid response. Please try again.",
        });
        return;
      }

      const displayText = formatDisplayText(assistantMessage);
      const speechText = request.body.voice
        ? formatSpeechText(assistantMessage)
        : "";
      const speechId = speechText
        ? cacheSpeech(speechText, request.body.sessionId)
        : null;

      response.json({
        success: true,
        message: displayText,
        ...(speechId ? { speechId } : {}),
        sources: getAssistantSources(upstreamPayload),
      });
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      console.error(
        timedOut
          ? "AnythingLLM request timed out."
          : "AnythingLLM request failed.",
      );
      response.status(timedOut ? 504 : 502).json({
        success: false,
        error: timedOut
          ? "The assistant took too long to respond. Please try again."
          : "The assistant is temporarily unavailable. Please try again.",
      });
    } finally {
      clearTimeout(timeout);
    }
  });

  app.post(
    "/api/transcribe",
    voiceLimiter,
    express.raw({ type: () => true, limit: "10mb" }),
    async (request, response) => {
      if (!openAiApiKey) {
        response.status(503).json({
          success: false,
          error: "Voice services are not configured yet.",
        });
        return;
      }

      const mimeType = String(request.headers["content-type"] || "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      const extension = AUDIO_FILE_EXTENSIONS[mimeType];
      if (!extension) {
        response.status(415).json({
          success: false,
          error: "Unsupported audio format.",
        });
        return;
      }
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        response.status(400).json({
          success: false,
          error: "An audio recording is required.",
        });
        return;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), OPENAI_AUDIO_TIMEOUT_MS);
      try {
        const form = new FormData();
        form.append(
          "file",
          new Blob([request.body], { type: mimeType }),
          `recording.${extension}`,
        );
        const workspace =
          typeof request.query.workspace === "string" &&
          WORKSPACES[request.query.workspace]
            ? request.query.workspace
            : "augmenthink";
        const workspaceName = {
          mirrorxr: "MirrorXR",
          augmenthink: "Augmenthink",
          clevart: "Clevart",
        }[workspace];
        form.append("model", openAiSttModel);
        form.append("languages[]", "en");
        form.append(
          "prompt",
          `A clear conversational question for the ${workspaceName} assistant. Preserve product, company, and technical names accurately.`,
        );
        for (const keyword of [
          workspaceName,
          "MirrorXR",
          "Augmenthink",
          "Clevart",
          "AnythingLLM",
        ]) {
          form.append("keywords[]", keyword);
        }

        const upstreamResponse = await fetchImpl(
          `${openAiBaseUrl}/audio/transcriptions`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${openAiApiKey}` },
            body: form,
            signal: controller.signal,
          },
        );
        if (!upstreamResponse.ok) {
          console.error(
            `OpenAI transcription returned HTTP ${upstreamResponse.status}.`,
          );
          response.status(502).json({
            success: false,
            error: "The recording could not be transcribed. Please try again.",
          });
          return;
        }

        const payload = await upstreamResponse.json();
        const transcript =
          typeof payload?.text === "string" ? payload.text.trim() : "";
        if (!transcript) {
          response.status(502).json({
            success: false,
            error: "No speech was detected in the recording.",
          });
          return;
        }
        response.json({ success: true, text: transcript });
      } catch (error) {
        const timedOut = error?.name === "AbortError";
        console.error(
          timedOut
            ? "OpenAI transcription timed out."
            : "OpenAI transcription failed.",
        );
        response.status(timedOut ? 504 : 502).json({
          success: false,
          error: timedOut
            ? "Transcription took too long. Please try again."
            : "Voice transcription is temporarily unavailable.",
        });
      } finally {
        clearTimeout(timeout);
      }
    },
  );

  app.get("/api/speech/:speechId", voiceLimiter, async (request, response) => {
    if (!openAiApiKey) {
      response.status(503).json({
        success: false,
        error: "Voice services are not configured yet.",
      });
      return;
    }
    pruneSpeechCache();
    const speech = speechCache.get(request.params.speechId);
    if (!speech || speech.sessionId !== request.query.sessionId) {
      response.status(404).json({
        success: false,
        error: "This spoken response is no longer available.",
      });
      return;
    }

    const controller = new AbortController();
    const abortOnDisconnect = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", abortOnDisconnect);
    const timeout = setTimeout(() => controller.abort(), OPENAI_AUDIO_TIMEOUT_MS);
    try {
      const upstreamResponse = await fetchImpl(`${openAiBaseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openAiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: openAiTtsModel,
          voice: openAiTtsVoice,
          input: speech.text,
          instructions: openAiTtsInstructions,
          response_format: "mp3",
        }),
        signal: controller.signal,
      });
      if (!upstreamResponse.ok) {
        console.error(`OpenAI speech returned HTTP ${upstreamResponse.status}.`);
        response.status(502).json({
          success: false,
          error: "The spoken response could not be generated.",
        });
        return;
      }

      if (!upstreamResponse.body) {
        response.status(502).json({
          success: false,
          error: "The voice service returned an empty audio response.",
        });
        return;
      }
      response.setHeader("Content-Type", "audio/mpeg");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders();
      await pipeline(Readable.fromWeb(upstreamResponse.body), response);
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      console.error(
        timedOut ? "OpenAI speech timed out." : "OpenAI speech failed.",
      );
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      response.status(timedOut ? 504 : 502).json({
        success: false,
        error: timedOut
          ? "Speech generation took too long. Please try again."
          : "Voice playback is temporarily unavailable.",
      });
    } finally {
      clearTimeout(timeout);
      response.off("close", abortOnDisconnect);
    }
  });

  app.use((error, _request, response, _next) => {
    if (error?.type === "entity.too.large") {
      response.status(413).json({ success: false, error: "Request is too large." });
      return;
    }

    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({ success: false, error: "Malformed JSON body." });
      return;
    }

    const status = error?.status || 500;
    if (status >= 500) {
      console.error("Unhandled gateway error.", error);
    }
    response.status(status).json({
      success: false,
      error: status === 403 ? "Origin not allowed." : "Unexpected server error.",
    });
  });

  return app;
}

function startServer() {
  const port = Number.parseInt(process.env.PORT || DEFAULT_PORT, 10);
  const app = createApp();
  return app.listen(port, () => {
    console.log(`Chat gateway listening on http://localhost:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  WORKSPACES,
  createApp,
  formatDisplayText,
  formatSpeechText,
  getAssistantMessage,
  getAssistantSources,
  getWorkspaceSlugs,
  validateChatRequest,
};
