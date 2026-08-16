(function initializeAssistantWidget() {
  "use strict";

  const script = document.currentScript;
  if (
    !script ||
    script.dataset.assistantWidgetLoaded === "true" ||
    document.getElementById("assistant-chat-widget")
  ) {
    return;
  }
  script.dataset.assistantWidgetLoaded = "true";

  const WORKSPACES = Object.freeze({
    clevart: { label: "Creart Digital Media" },
    augmenthink: { label: "Augmenthink" },
    raisewisely: { label: "RaiseWisely" },
    mirrorxr: { label: "Mirror XR" },
  });
  const configuredWorkspace = script.dataset.workspace || "augmenthink";
  let workspace = WORKSPACES[configuredWorkspace]
    ? configuredWorkspace
    : "augmenthink";
  const scriptUrl = new URL(script.src, window.location.href);
  const assetCacheKey = Date.now().toString(36);
  const avatarUrl = new URL("assets/CLEO.jpg", scriptUrl);
  avatarUrl.search = scriptUrl.search;
  avatarUrl.searchParams.set("widget-cache", assetCacheKey);
  const apiUrl = (script.dataset.apiUrl || scriptUrl.origin).replace(/\/$/, "");
  const HISTORY_KEY = "assistant-chat-history-v1";
  const SESSION_KEY_PREFIX = "assistant-chat-session:";
  const VOICE_REPLIES_KEY = "assistant-voice-replies-enabled";
  const REQUEST_TIMEOUT_MS = 35000;
  const AUDIO_REQUEST_TIMEOUT_MS = 210000;
  const SILENT_AUDIO_DATA_URI =
    "data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA";
  const MAX_RECORDING_MS = 180000;
  const NO_SPEECH_TIMEOUT_MS = 12000;
  const SILENCE_STOP_MS = 2000;
  const VOICE_ACTIVITY_THRESHOLD = 0.024;
  const MESSAGE_KINDS = new Set(["user", "assistant", "error"]);

  function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function createIcon(pathData) {
    const namespace = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(namespace, "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", pathData);
    icon.appendChild(path);
    return icon;
  }

  const microphoneIcon = () =>
    createIcon(
      "M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21H8v2h8v-2h-3v-3.08A7 7 0 0 0 19 11h-2Z",
    );
  const voiceActivityIcon = () => {
    const indicator = createElement("span", "assistant-voice-indicator");
    indicator.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 4; index += 1) {
      indicator.appendChild(createElement("i"));
    }
    return indicator;
  };
  const sendIcon = () =>
    createIcon("M11 20V7.83l-4.59 4.58L5 11l7-7 7 7-1.41 1.41L13 7.83V20h-2Z");
  const speakerIcon = () =>
    createIcon(
      "M3 9v6h4l5 5V4L7 9H3Zm11-1.03v8.05A4.49 4.49 0 0 0 16.5 12 4.49 4.49 0 0 0 14 7.97Zm0-4.74v2.06A7 7 0 0 1 19 12a7 7 0 0 1-5 6.71v2.06A9 9 0 0 0 21 12a9 9 0 0 0-7-8.77Z",
    );

  function createSessionId() {
    return (
      window.crypto?.randomUUID?.() ||
      `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
  }

  function sessionStorageKey(workspaceName) {
    return `${SESSION_KEY_PREFIX}${workspaceName}`;
  }

  function storeSessionId(sessionId, workspaceName = workspace) {
    try {
      window.localStorage.setItem(sessionStorageKey(workspaceName), sessionId);
    } catch (_error) {
      // The in-memory session still works when storage is unavailable.
    }
  }

  function getSessionId(workspaceName = workspace) {
    try {
      let sessionId = window.localStorage.getItem(
        sessionStorageKey(workspaceName),
      );
      if (!sessionId || !/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)) {
        sessionId = createSessionId();
        storeSessionId(sessionId, workspaceName);
      }
      return sessionId;
    } catch (_error) {
      return createSessionId();
    }
  }

  function loadHistories() {
    const result = Object.fromEntries(
      Object.keys(WORKSPACES).map((key) => [key, []]),
    );
    try {
      const stored = JSON.parse(window.localStorage.getItem(HISTORY_KEY) || "{}");
      Object.keys(WORKSPACES).forEach((key) => {
        if (!Array.isArray(stored[key])) return;
        result[key] = stored[key].filter(
          (entry) =>
            entry &&
            MESSAGE_KINDS.has(entry.kind) &&
            typeof entry.text === "string" &&
            entry.text.length > 0,
        );
      });
    } catch (_error) {
      // Start empty if stored data is unavailable.
    }
    return result;
  }

  let histories = loadHistories();
  let sessionId = getSessionId();
  let voiceRepliesEnabled = false;
  try {
    voiceRepliesEnabled =
      window.localStorage.getItem(VOICE_REPLIES_KEY) === "true";
  } catch (_error) {
    // Voice replies remain off when storage is unavailable.
  }

  function storeHistories() {
    try {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(histories));
    } catch (_error) {
      // The current page still retains its full in-memory conversation.
    }
  }

  function rememberMessage(kind, text) {
    histories[workspace].push({ kind, text });
    storeHistories();
  }

  const host = createElement("div");
  host.id = "assistant-chat-widget";
  document.body.appendChild(host);

  const root = host.attachShadow({ mode: "open" });
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  const stylesheetUrl = new URL("chat-widget.css", scriptUrl);
  stylesheetUrl.search = scriptUrl.search;
  stylesheetUrl.searchParams.set("widget-cache", assetCacheKey);
  stylesheet.href = stylesheetUrl.href;
  root.appendChild(stylesheet);

  const launcher = createElement("button", "assistant-launcher");
  launcher.type = "button";
  launcher.setAttribute("aria-label", "Open knowledge assistant");
  launcher.setAttribute("aria-expanded", "false");
  launcher.appendChild(createElement("span", "assistant-launcher-mark", "A"));
  const launcherPulse = createElement("span", "assistant-launcher-pulse");
  launcherPulse.setAttribute("aria-hidden", "true");
  launcher.appendChild(launcherPulse);

  const panel = createElement("section", "assistant-panel");
  panel.setAttribute("aria-label", "Portfolio knowledge assistant");
  panel.setAttribute("aria-hidden", "true");

  const header = createElement("header", "assistant-header");
  const identity = createElement("div", "assistant-identity");
  const avatar = createElement("img", "assistant-avatar");
  avatar.src = avatarUrl.href;
  avatar.alt = "";
  avatar.setAttribute("aria-hidden", "true");
  const titleGroup = createElement("div", "assistant-title-group");
  const eyebrow = createElement(
    "span",
    "assistant-eyebrow",
    "What would you like to know",
  );
  const workspaceSelect = createElement("select", "assistant-workspace-select");
  workspaceSelect.setAttribute("aria-label", "Choose a workspace");
  Object.entries(WORKSPACES).forEach(([value, config]) => {
    const option = createElement("option", "", config.label);
    option.value = value;
    option.selected = value === workspace;
    workspaceSelect.appendChild(option);
  });
  titleGroup.append(eyebrow, workspaceSelect);
  identity.append(avatar, titleGroup);

  const headerActions = createElement("div", "assistant-header-actions");
  const voiceReplyButton = createElement(
    "button",
    "assistant-header-voice",
  );
  voiceReplyButton.type = "button";
  voiceReplyButton.disabled = true;
  voiceReplyButton.appendChild(speakerIcon());
  const closeButton = createElement("button", "assistant-icon-button", "×");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Close assistant");
  closeButton.title = "Close";
  headerActions.append(voiceReplyButton, closeButton);
  header.append(identity, headerActions);

  const messages = createElement("div", "assistant-messages");
  messages.setAttribute("role", "log");
  messages.setAttribute("aria-live", "polite");
  messages.setAttribute("aria-relevant", "additions");

  const composer = createElement("form", "assistant-composer");
  const input = createElement("textarea", "assistant-input");
  input.rows = 1;
  input.maxLength = 8000;
  input.setAttribute("aria-label", "Ask the knowledge assistant");

  const micButton = createElement("button", "assistant-action assistant-mic");
  micButton.type = "button";
  micButton.setAttribute("aria-label", "Start voice input");
  micButton.title = "Voice input";
  micButton.appendChild(microphoneIcon());

  const sendButton = createElement("button", "assistant-action assistant-send");
  sendButton.type = "submit";
  sendButton.setAttribute("aria-label", "Send message");
  sendButton.title = "Send";
  sendButton.disabled = true;
  sendButton.appendChild(sendIcon());

  composer.append(input, micButton, sendButton);
  const responseAudio = createElement("audio", "assistant-response-audio");
  responseAudio.preload = "auto";
  responseAudio.setAttribute("playsinline", "");
  panel.append(header, messages, composer);
  root.append(launcher, panel, responseAudio);

  let busy = false;
  let transcribing = false;
  let voiceConfigured = null;
  let capturePending = false;
  let captureGeneration = 0;
  let mediaRecorder = null;
  let mediaStream = null;
  let recordingChunks = [];
  let recordingMimeType = "";
  let discardRecording = false;
  let recordingStartedAt = 0;
  let heardSpeech = false;
  let lastVoiceActivityAt = 0;
  let audioContext = null;
  let audioAnalyser = null;
  let audioMonitorFrame = 0;
  let recordingTimeout = 0;
  let transcriptionController = null;
  let audioUnlocked = false;
  let audioUnlockPromise = null;
  let playbackTimeout = 0;
  let playbackGeneration = 0;
  const mediaCaptureSupported = Boolean(
    navigator.mediaDevices?.getUserMedia && window.MediaRecorder,
  );

  function scrollToLatest() {
    messages.scrollTop = messages.scrollHeight;
  }

  function addMessage(kind, text, options = {}) {
    const row = createElement("div", `assistant-message-row ${kind}`);
    const bubble = createElement("div", "assistant-message", text);
    row.appendChild(bubble);
    messages.appendChild(row);
    if (options.persist !== false) rememberMessage(kind, text);
    scrollToLatest();
    return row;
  }

  function appendWordReveal(container, text, delayStep = 24) {
    let wordIndex = 0;
    container.setAttribute("aria-label", text);
    text.split(/(\s+)/).forEach((part) => {
      if (!part) return;
      if (/^\s+$/.test(part)) {
        container.appendChild(document.createTextNode(part));
        return;
      }
      const word = createElement("span", "assistant-response-word", part);
      word.setAttribute("aria-hidden", "true");
      word.style.setProperty(
        "--assistant-word-delay",
        `${Math.min(wordIndex * delayStep, 1200)}ms`,
      );
      wordIndex += 1;
      container.appendChild(word);
    });
  }

  function addAnimatedResponse(text) {
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const row = createElement(
      "div",
      `assistant-message-row assistant response-enter${
        reducedMotion ? " response-reduced-motion" : ""
      }`,
    );
    const bubble = createElement("div", "assistant-message assistant-response");
    appendWordReveal(bubble, text);
    row.appendChild(bubble);
    messages.appendChild(row);
    rememberMessage("assistant", text);
    scrollToLatest();
    return row;
  }

  function addTypingIndicator() {
    const row = createElement("div", "assistant-message-row assistant typing");
    row.setAttribute("aria-label", "Assistant is thinking");
    const bubble = createElement("div", "assistant-message assistant-typing");
    for (let index = 0; index < 3; index += 1) {
      bubble.appendChild(createElement("span"));
    }
    row.appendChild(bubble);
    messages.appendChild(row);
    scrollToLatest();
    return row;
  }

  function renderConversation() {
    messages.replaceChildren();
    input.placeholder = `Message ${WORKSPACES[workspace].label}…`;
    histories[workspace].forEach(({ kind, text }) => {
      addMessage(kind, text, { persist: false });
    });
    scrollToLatest();
  }

  function updateVoiceReplyButton() {
    voiceReplyButton.classList.toggle("active", voiceRepliesEnabled);
    voiceReplyButton.setAttribute(
      "aria-pressed",
      String(voiceRepliesEnabled),
    );
    const label = voiceRepliesEnabled
      ? "Turn off spoken replies for voice input"
      : "Turn on spoken replies for voice input";
    voiceReplyButton.setAttribute("aria-label", label);
    voiceReplyButton.title = label;
  }

  function stopAudioPlayback() {
    playbackGeneration += 1;
    window.clearTimeout(playbackTimeout);
    playbackTimeout = 0;
    voiceReplyButton.classList.remove("loading", "playing");
    responseAudio.onplaying = null;
    responseAudio.onended = null;
    responseAudio.onerror = null;
    responseAudio.pause();
    responseAudio.removeAttribute("src");
    responseAudio.load();
    updateVoiceReplyButton();
  }

  function primeAudioPlayback() {
    if (audioUnlocked) return Promise.resolve(true);
    if (audioUnlockPromise) return audioUnlockPromise;

    responseAudio.onplaying = null;
    responseAudio.onended = null;
    responseAudio.onerror = null;
    responseAudio.src = SILENT_AUDIO_DATA_URI;
    responseAudio.load();
    audioUnlockPromise = Promise.resolve(responseAudio.play())
      .then(() => {
        responseAudio.pause();
        responseAudio.currentTime = 0;
        responseAudio.removeAttribute("src");
        responseAudio.load();
        audioUnlocked = true;
        return true;
      })
      .catch(() => false)
      .finally(() => {
        audioUnlockPromise = null;
      });
    return audioUnlockPromise;
  }

  function setVoiceRepliesEnabled(enabled) {
    voiceRepliesEnabled = Boolean(enabled);
    try {
      window.localStorage.setItem(
        VOICE_REPLIES_KEY,
        String(voiceRepliesEnabled),
      );
    } catch (_error) {
      // The toggle still works for the current page.
    }
    if (!voiceRepliesEnabled) stopAudioPlayback();
    else updateVoiceReplyButton();
  }

  function showPlaybackFallback(responseRow, speechId) {
    if (!responseRow || !responseRow.isConnected) return;
    let button = responseRow.querySelector(".assistant-play-reply");
    if (button) {
      button.disabled = false;
      button.classList.remove("playing");
      button.querySelector("span").textContent = "Play voice reply";
      return;
    }

    button = createElement("button", "assistant-play-reply");
    button.type = "button";
    button.append(speakerIcon(), createElement("span", "", "Play voice reply"));
    button.setAttribute("aria-label", "Play this voice reply");
    button.addEventListener("click", () => {
      void playSpeech(speechId, responseRow, button);
    });
    responseRow.appendChild(button);
    scrollToLatest();
  }

  async function playSpeech(speechId, responseRow, playbackButton = null) {
    if (!voiceRepliesEnabled || typeof speechId !== "string") return;
    stopAudioPlayback();
    const generation = playbackGeneration;
    const speechUrl = new URL(
      `${apiUrl}/api/speech/${encodeURIComponent(speechId)}`,
    );
    speechUrl.searchParams.set("sessionId", sessionId);
    const player = responseAudio;
    voiceReplyButton.classList.add("loading");
    voiceReplyButton.title = "Preparing spoken reply";
    player.preload = "auto";
    player.src = speechUrl.href;

    const finish = () => {
      if (generation !== playbackGeneration) return;
      window.clearTimeout(playbackTimeout);
      playbackTimeout = 0;
      voiceReplyButton.classList.remove("loading", "playing");
      if (playbackButton) {
        playbackButton.disabled = false;
        playbackButton.classList.remove("playing");
        playbackButton.querySelector("span").textContent = "Play voice reply";
      }
      updateVoiceReplyButton();
    };
    let failed = false;
    const offerFallback = () => {
      if (failed || generation !== playbackGeneration) return;
      failed = true;
      finish();
      showPlaybackFallback(responseRow, speechId);
    };
    player.onplaying = () => {
      if (generation !== playbackGeneration) return;
      window.clearTimeout(playbackTimeout);
      playbackTimeout = 0;
      voiceReplyButton.classList.remove("loading");
      voiceReplyButton.classList.add("playing");
      voiceReplyButton.title = "Playing spoken reply";
      if (playbackButton) {
        playbackButton.disabled = true;
        playbackButton.classList.add("playing");
        playbackButton.querySelector("span").textContent = "Playing voice reply";
      }
    };
    player.onended = finish;
    player.onerror = offerFallback;
    playbackTimeout = window.setTimeout(() => {
      if (generation !== playbackGeneration) return;
      offerFallback();
    }, AUDIO_REQUEST_TIMEOUT_MS);

    try {
      player.load();
      await player.play();
    } catch (_error) {
      offerFallback();
    }
  }

  function resetRecordingControls() {
    micButton.classList.remove("listening", "processing");
    micButton.replaceChildren(microphoneIcon());
    micButton.setAttribute("aria-label", "Start voice input");
    micButton.title = "Voice input";
    micButton.disabled = busy || transcribing || voiceConfigured === false;
    workspaceSelect.disabled = busy || transcribing;
  }

  function stopCaptureAnalysis() {
    if (audioMonitorFrame) {
      window.cancelAnimationFrame(audioMonitorFrame);
      audioMonitorFrame = 0;
    }
    window.clearTimeout(recordingTimeout);
    recordingTimeout = 0;
    audioAnalyser = null;
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
  }

  function releaseMediaStream() {
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  function cleanupCaptureResources() {
    stopCaptureAnalysis();
    releaseMediaStream();
  }

  function stopRecording(shouldDiscard = false) {
    discardRecording ||= shouldDiscard;
    if (mediaRecorder?.state === "recording") mediaRecorder.stop();
    stopCaptureAnalysis();
  }

  function cancelVoiceInput() {
    captureGeneration += 1;
    stopRecording(true);
    transcriptionController?.abort();
    transcriptionController = null;
    cleanupCaptureResources();
    resetRecordingControls();
  }

  function selectedRecordingMimeType() {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus",
    ];
    if (typeof MediaRecorder.isTypeSupported !== "function") return "";
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  function monitorVoiceActivity(stream) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    try {
      audioContext = new AudioContextClass();
      if (audioContext.state === "suspended") {
        audioContext.resume().catch(() => {});
      }
      const source = audioContext.createMediaStreamSource(stream);
      audioAnalyser = audioContext.createAnalyser();
      audioAnalyser.fftSize = 1024;
      source.connect(audioAnalyser);
      const samples = new Uint8Array(audioAnalyser.fftSize);
      const monitor = () => {
        if (
          !mediaRecorder ||
          mediaRecorder.state !== "recording" ||
          !audioAnalyser
        ) {
          return;
        }
        audioAnalyser.getByteTimeDomainData(samples);
        let energy = 0;
        samples.forEach((sample) => {
          const amplitude = (sample - 128) / 128;
          energy += amplitude * amplitude;
        });
        const volume = Math.sqrt(energy / samples.length);
        const now = performance.now();
        const elapsed = now - recordingStartedAt;
        if (volume >= VOICE_ACTIVITY_THRESHOLD) {
          heardSpeech = true;
          lastVoiceActivityAt = now;
        }
        if (heardSpeech && now - lastVoiceActivityAt >= SILENCE_STOP_MS) {
          stopRecording(false);
          return;
        }
        if (!heardSpeech && elapsed >= NO_SPEECH_TIMEOUT_MS) {
          stopRecording(true);
          return;
        }
        audioMonitorFrame = window.requestAnimationFrame(monitor);
      };
      audioMonitorFrame = window.requestAnimationFrame(monitor);
    } catch (_error) {
      // Tap-to-stop still works when audio analysis is unavailable.
    }
  }

  async function transcribeRecording(recording) {
    if (!recording.size) return;
    transcribing = true;
    micButton.classList.remove("listening");
    micButton.classList.add("processing");
    micButton.replaceChildren(voiceActivityIcon());
    micButton.setAttribute("aria-label", "Processing voice input");
    micButton.title = "Processing voice input";
    micButton.disabled = true;
    workspaceSelect.disabled = true;
    const controller = new AbortController();
    transcriptionController = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, AUDIO_REQUEST_TIMEOUT_MS);
    let transcript = "";

    try {
      const response = await fetch(
        `${apiUrl}/api/transcribe?workspace=${encodeURIComponent(workspace)}`,
        {
          method: "POST",
          headers: { "Content-Type": recording.type || "audio/webm" },
          body: recording,
          signal: controller.signal,
        },
      );
      const payload = await response.json().catch(() => null);
      if (
        !response.ok ||
        payload?.success !== true ||
        typeof payload?.text !== "string"
      ) {
        throw new Error(payload?.error || "The recording could not be transcribed.");
      }
      transcript = payload.text.trim();
    } catch (error) {
      if (controller.signal.aborted && !timedOut) return;
      addMessage(
        "error",
        timedOut
          ? "Transcription took too long. Please try again."
          : error?.message || "Voice transcription is temporarily unavailable.",
      );
    } finally {
      window.clearTimeout(timeout);
      if (transcriptionController === controller) transcriptionController = null;
      transcribing = false;
      resetRecordingControls();
    }

    if (!transcript) {
      input.focus();
      return;
    }
    input.value = transcript;
    resizeInput();
    await sendMessage({ fromVoice: true });
  }

  async function startListening() {
    if (
      !mediaCaptureSupported ||
      busy ||
      transcribing ||
      capturePending ||
      mediaRecorder?.state === "recording"
    ) {
      return;
    }
    if (voiceConfigured === false) {
      addMessage("error", "Voice input is not configured yet.");
      return;
    }

    discardRecording = false;
    recordingChunks = [];
    heardSpeech = false;
    lastVoiceActivityAt = 0;
    micButton.disabled = true;
    workspaceSelect.disabled = true;
    const requestedCaptureGeneration = ++captureGeneration;
    try {
      capturePending = true;
      const requestedStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: { ideal: 48000 },
          sampleSize: { ideal: 16 },
        },
      });
      capturePending = false;
      if (requestedCaptureGeneration !== captureGeneration) {
        requestedStream.getTracks().forEach((track) => track.stop());
        return;
      }
      mediaStream = requestedStream;
      const preferredMimeType = selectedRecordingMimeType();
      const recorderOptions = {
        ...(preferredMimeType ? { mimeType: preferredMimeType } : {}),
        audioBitsPerSecond: 128000,
      };
      mediaRecorder = new MediaRecorder(mediaStream, recorderOptions);
      recordingMimeType =
        mediaRecorder.mimeType?.split(";", 1)[0] ||
        preferredMimeType.split(";", 1)[0] ||
        "audio/webm";
      mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) recordingChunks.push(event.data);
      });
      mediaRecorder.addEventListener(
        "stop",
        () => {
          const shouldDiscard = discardRecording;
          const recording = new Blob(recordingChunks, {
            type: recordingMimeType,
          });
          mediaRecorder = null;
          recordingChunks = [];
          cleanupCaptureResources();
          resetRecordingControls();
          if (!shouldDiscard) void transcribeRecording(recording);
        },
        { once: true },
      );
      mediaRecorder.addEventListener(
        "error",
        () => {
          discardRecording = true;
          stopRecording(true);
          addMessage("error", "The microphone recording failed.");
        },
        { once: true },
      );
      mediaRecorder.start(100);
      recordingStartedAt = performance.now();
      recordingTimeout = window.setTimeout(
        () => stopRecording(!heardSpeech),
        MAX_RECORDING_MS,
      );
      monitorVoiceActivity(mediaStream);
      micButton.disabled = false;
      micButton.classList.add("listening");
      micButton.replaceChildren(voiceActivityIcon());
      micButton.setAttribute("aria-label", "Stop and transcribe voice input");
      micButton.title = "Stop recording";
    } catch (error) {
      capturePending = false;
      cleanupCaptureResources();
      mediaRecorder = null;
      resetRecordingControls();
      const permissionDenied = ["NotAllowedError", "SecurityError"].includes(
        error?.name,
      );
      addMessage(
        "error",
        permissionDenied
          ? "Microphone permission is needed."
          : "The microphone is unavailable.",
      );
    }
  }

  function setOpen(open) {
    panel.classList.toggle("open", open);
    launcher.classList.toggle("hidden", open);
    panel.setAttribute("aria-hidden", String(!open));
    launcher.setAttribute("aria-expanded", String(open));
    if (open) {
      window.setTimeout(() => input.focus(), 150);
    } else {
      stopAudioPlayback();
      if (mediaRecorder?.state === "recording" || capturePending) {
        cancelVoiceInput();
      }
      launcher.focus();
    }
  }

  function setWorkspace(nextWorkspace, openPanel = false) {
    if (
      !WORKSPACES[nextWorkspace] ||
      busy ||
      transcribing ||
      capturePending ||
      mediaRecorder?.state === "recording"
    ) {
      return;
    }
    const changed = workspace !== nextWorkspace;
    workspace = nextWorkspace;
    workspaceSelect.value = workspace;
    if (changed) {
      stopAudioPlayback();
      sessionId = getSessionId(workspace);
      input.value = "";
      renderConversation();
      resizeInput();
    }
    if (openPanel) setOpen(true);
    document.dispatchEvent(
      new CustomEvent("assistant:workspace-change", {
        detail: { workspace, label: WORKSPACES[workspace].label },
      }),
    );
  }

  function resizeInput() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    sendButton.disabled = busy || input.value.trim().length === 0;
  }

  async function checkReadiness() {
    try {
      const response = await fetch(`${apiUrl}/api/readiness`, {
        headers: { Accept: "application/json" },
      });
      const payload = await response.json();
      const anythingLlmReady = payload?.anythingLlm === true;
      voiceConfigured = payload?.voice?.configured === true;
      launcher.classList.toggle("unavailable", !anythingLlmReady);
      micButton.disabled = busy || transcribing || !voiceConfigured;
      voiceReplyButton.disabled =
        !mediaCaptureSupported || !voiceConfigured;
      micButton.title = voiceConfigured
        ? "Voice input"
        : "Voice input needs setup";
    } catch (_error) {
      voiceConfigured = false;
      launcher.classList.add("unavailable");
      micButton.disabled = true;
      voiceReplyButton.disabled = true;
    }
  }

  async function sendMessage(options = {}) {
    const message = input.value.trim();
    if (!message || busy) return;
    const shouldSpeak =
      options.fromVoice === true &&
      voiceRepliesEnabled &&
      voiceConfigured !== false;
    stopAudioPlayback();
    addMessage("user", message);
    input.value = "";
    busy = true;
    input.disabled = true;
    micButton.disabled = true;
    workspaceSelect.disabled = true;
    resizeInput();
    const typing = addTypingIndicator();
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await fetch(`${apiUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          workspace,
          sessionId,
          voice: shouldSpeak,
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (
        !response.ok ||
        payload?.success !== true ||
        typeof payload?.message !== "string"
      ) {
        throw new Error(
          typeof payload?.error === "string"
            ? payload.error
            : "The assistant could not answer. Please try again.",
        );
      }
      typing.remove();
      const responseRow = addAnimatedResponse(payload.message);
      if (shouldSpeak && typeof payload.speechId === "string") {
        void playSpeech(payload.speechId, responseRow);
      }
    } catch (error) {
      typing.remove();
      addMessage(
        "error",
        error?.name === "AbortError"
          ? "That took too long. Please try the question again."
          : error?.message || "The assistant is unreachable. Please try again.",
      );
    } finally {
      window.clearTimeout(timeout);
      busy = false;
      input.disabled = false;
      micButton.disabled = transcribing || voiceConfigured === false;
      workspaceSelect.disabled = false;
      resizeInput();
      input.focus();
    }
  }

  if (!mediaCaptureSupported) {
    micButton.hidden = true;
    micButton.title = "Microphone recording is not supported in this browser";
    voiceReplyButton.disabled = true;
    voiceReplyButton.title = "Microphone recording is not supported in this browser";
  }

  voiceReplyButton.addEventListener("click", () => {
    const enabling = !voiceRepliesEnabled;
    setVoiceRepliesEnabled(enabling);
    if (enabling) void primeAudioPlayback();
  });
  micButton.addEventListener("click", () => {
    stopAudioPlayback();
    if (voiceRepliesEnabled) void primeAudioPlayback();
    if (mediaRecorder?.state === "recording") stopRecording(false);
    else void startListening();
  });
  launcher.addEventListener("click", () => setOpen(true));
  closeButton.addEventListener("click", () => setOpen(false));
  workspaceSelect.addEventListener("change", () => {
    setWorkspace(workspaceSelect.value);
  });
  input.addEventListener("input", resizeInput);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  });
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendMessage();
  });
  document.addEventListener("assistant:set-workspace", (event) => {
    setWorkspace(event.detail?.workspace, true);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel.classList.contains("open")) {
      setOpen(false);
    }
  });

  renderConversation();
  updateVoiceReplyButton();
  resizeInput();
  void checkReadiness();
})();
