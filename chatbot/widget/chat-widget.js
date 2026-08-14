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
    mirrorxr: {
      label: "MirrorXR",
    },
    augmenthink: {
      label: "Augmenthink",
    },
    clevart: {
      label: "Clevart",
    },
  });

  const configuredWorkspace = script.dataset.workspace || "augmenthink";
  let workspace = WORKSPACES[configuredWorkspace]
    ? configuredWorkspace
    : "augmenthink";
  const scriptUrl = new URL(script.src, window.location.href);
  const apiUrl = (
    script.dataset.apiUrl || scriptUrl.origin
  ).replace(/\/$/, "");
  const submitSpeech = script.dataset.submitSpeech === "true";
  const SESSION_KEY = "assistant-chat-session";
  const REQUEST_TIMEOUT_MS = 35000;
  const AUDIO_REQUEST_TIMEOUT_MS = 60000;
  const MAX_RECORDING_MS = 45000;
  const NO_SPEECH_TIMEOUT_MS = 8000;
  const SILENCE_STOP_MS = 850;
  const VOICE_ACTIVITY_THRESHOLD = 0.024;

  function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function createSessionId() {
    return (
      window.crypto?.randomUUID?.() ||
      `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
  }

  function storeSessionId(sessionId) {
    try {
      window.localStorage.setItem(SESSION_KEY, sessionId);
    } catch (_error) {
      // The in-memory session still works when storage is unavailable.
    }
  }

  function getSessionId() {
    try {
      let sessionId = window.localStorage.getItem(SESSION_KEY);
      if (!sessionId || !/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)) {
        sessionId = createSessionId();
        storeSessionId(sessionId);
      }
      return sessionId;
    } catch (_error) {
      return createSessionId();
    }
  }

  let sessionId = getSessionId();
  const host = createElement("div");
  host.id = "assistant-chat-widget";
  document.body.appendChild(host);

  const root = host.attachShadow({ mode: "open" });
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  const stylesheetUrl = new URL("chat-widget.css", scriptUrl);
  stylesheetUrl.search = scriptUrl.search;
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
  const avatar = createElement("span", "assistant-avatar", "A");
  avatar.setAttribute("aria-hidden", "true");
  const titleGroup = createElement("div", "assistant-title-group");
  const eyebrow = createElement("span", "assistant-eyebrow", "Knowledge assistant");
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
  const status = createElement("span", "assistant-status", "Checking");
  status.setAttribute("role", "status");
  const clearButton = createElement("button", "assistant-clear-button", "Clear");
  clearButton.type = "button";
  clearButton.setAttribute("aria-label", "Clear chat and start a new conversation");
  clearButton.title = "Clear chat";
  const closeButton = createElement("button", "assistant-icon-button", "×");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Close assistant");
  closeButton.title = "Close";
  headerActions.append(status, clearButton, closeButton);
  header.append(identity, headerActions);

  const modeSwitch = createElement("div", "assistant-mode-switch");
  modeSwitch.setAttribute("role", "tablist");
  modeSwitch.setAttribute("aria-label", "Interaction mode");
  const chatModeButton = createElement(
    "button",
    "assistant-mode-option active",
    "Chat",
  );
  chatModeButton.type = "button";
  chatModeButton.setAttribute("role", "tab");
  chatModeButton.setAttribute("aria-selected", "true");
  const voiceModeButton = createElement(
    "button",
    "assistant-mode-option",
    "Voice",
  );
  voiceModeButton.type = "button";
  voiceModeButton.setAttribute("role", "tab");
  voiceModeButton.setAttribute("aria-selected", "false");
  modeSwitch.append(chatModeButton, voiceModeButton);

  const messages = createElement("div", "assistant-messages");
  messages.setAttribute("role", "log");
  messages.setAttribute("aria-live", "polite");
  messages.setAttribute("aria-relevant", "additions");

  const voiceStage = createElement("section", "assistant-voice-stage");
  voiceStage.setAttribute("aria-label", "Voice conversation");
  voiceStage.dataset.state = "idle";
  const voiceContext = createElement(
    "p",
    "assistant-voice-context",
    `Voice conversation with ${WORKSPACES[workspace].label}`,
  );
  const voiceOrbButton = createElement("button", "assistant-voice-orb");
  voiceOrbButton.type = "button";
  voiceOrbButton.setAttribute("aria-label", "Start voice conversation");
  const voiceOrbCore = createElement("span", "assistant-voice-orb-core");
  const voiceWave = createElement("span", "assistant-voice-wave");
  for (let index = 0; index < 5; index += 1) {
    voiceWave.appendChild(createElement("i"));
  }
  voiceOrbCore.appendChild(voiceWave);
  voiceOrbButton.appendChild(voiceOrbCore);
  const voiceStateLabel = createElement(
    "p",
    "assistant-voice-state-label",
    "Tap to start",
  );
  voiceStateLabel.setAttribute("role", "status");
  const voiceHint = createElement(
    "p",
    "assistant-voice-hint",
    "AI-generated voice · tap the orb to interrupt",
  );
  const voiceTurns = createElement("div", "assistant-voice-turns");
  const voiceUserTurn = createElement("div", "assistant-voice-turn user hidden");
  voiceUserTurn.append(
    createElement("span", "assistant-voice-turn-label", "You"),
  );
  const voiceUserText = createElement("p", "assistant-voice-turn-text");
  voiceUserTurn.appendChild(voiceUserText);
  const voiceAgentTurn = createElement(
    "div",
    "assistant-voice-turn assistant hidden",
  );
  voiceAgentTurn.append(
    createElement("span", "assistant-voice-turn-label", "Assistant"),
  );
  const voiceAgentText = createElement("p", "assistant-voice-turn-text");
  voiceAgentTurn.appendChild(voiceAgentText);
  voiceTurns.append(voiceUserTurn, voiceAgentTurn);
  voiceStage.append(
    voiceContext,
    voiceOrbButton,
    voiceStateLabel,
    voiceHint,
    voiceTurns,
  );

  const composer = createElement("form", "assistant-composer");
  const input = createElement("textarea", "assistant-input");
  input.rows = 1;
  input.maxLength = 4000;
  input.setAttribute("aria-label", "Ask the knowledge assistant");

  const micButton = createElement("button", "assistant-action assistant-mic", "Mic");
  micButton.type = "button";
  micButton.setAttribute("aria-label", "Start voice input");
  micButton.title = "Voice input";

  const sendButton = createElement("button", "assistant-action assistant-send", "↑");
  sendButton.type = "submit";
  sendButton.setAttribute("aria-label", "Send message");
  sendButton.title = "Send";
  sendButton.disabled = true;

  composer.append(input, micButton, sendButton);
  panel.append(header, modeSwitch, messages, voiceStage, composer);
  root.append(launcher, panel);

  let busy = false;
  let transcribing = false;
  let interactionMode = "chat";
  let voiceSessionActive = false;
  let voiceState = "idle";
  let voiceConfigured = null;
  let capturePending = false;
  let captureGeneration = 0;
  let mediaRecorder = null;
  let mediaStream = null;
  let recordingChunks = [];
  let recordingMimeType = "";
  let recordingRequestMode = "chat";
  let discardRecording = false;
  let recordingStartedAt = 0;
  let heardSpeech = false;
  let lastVoiceActivityAt = 0;
  let audioContext = null;
  let audioAnalyser = null;
  let audioMonitorFrame = 0;
  let recordingTimeout = 0;
  let transcriptionController = null;
  let responseAudio = null;
  let playbackTimeout = 0;
  let playbackGeneration = 0;
  const mediaCaptureSupported = Boolean(
    navigator.mediaDevices?.getUserMedia && window.MediaRecorder,
  );

  function scrollToLatest() {
    messages.scrollTop = messages.scrollHeight;
  }

  function addMessage(kind, text) {
    const row = createElement("div", `assistant-message-row ${kind}`);
    const bubble = createElement("div", "assistant-message", text);
    row.appendChild(bubble);
    messages.appendChild(row);
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
    return wordIndex;
  }

  function addAnimatedResponse(text, options = {}) {
    const deferred = options.deferred === true;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const row = createElement(
      "div",
      `assistant-message-row assistant response-enter${
        deferred ? " response-deferred" : ""
      }${reducedMotion ? " response-reduced-motion" : ""}`,
    );
    const bubble = createElement("div", "assistant-message assistant-response");
    appendWordReveal(bubble, text);

    row.appendChild(bubble);
    messages.appendChild(row);
    scrollToLatest();
    return {
      row,
      startReveal() {
        row.classList.remove("response-deferred");
        scrollToLatest();
      },
    };
  }

  function renderVoiceResponse(text, deferred = false) {
    voiceAgentText.replaceChildren();
    voiceAgentText.classList.toggle("response-deferred", deferred);
    appendWordReveal(voiceAgentText, text, 20);
    voiceAgentTurn.classList.remove("hidden");
    return () => voiceAgentText.classList.remove("response-deferred");
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

  function resetConversation() {
    messages.replaceChildren();
    input.placeholder = `Ask ${WORKSPACES[workspace].label}…`;
    voiceContext.textContent = `Voice conversation with ${WORKSPACES[workspace].label}`;
    voiceUserText.textContent = "";
    voiceAgentText.textContent = "";
    voiceUserTurn.classList.add("hidden");
    voiceAgentTurn.classList.add("hidden");
    scrollToLatest();
  }

  function clearConversation() {
    if (busy || transcribing || capturePending) return;
    stopVoiceSession();
    sessionId = createSessionId();
    storeSessionId(sessionId);
    input.value = "";
    resetConversation();
    resizeInput();
    if (interactionMode === "voice") voiceOrbButton.focus();
    else input.focus();
  }

  function updateVoiceState(nextState, label) {
    const labels = {
      idle: "Tap to talk",
      listening: "I’m listening…",
      thinking: "Thinking…",
      speaking: "Speaking…",
      unavailable: "Voice unavailable",
    };
    voiceState = nextState;
    voiceStage.dataset.state = nextState;
    voiceStateLabel.textContent = label || labels[nextState] || labels.idle;
    voiceOrbButton.setAttribute(
      "aria-label",
      nextState === "listening"
        ? "Stop listening"
        : nextState === "speaking"
          ? "Interrupt assistant and speak"
          : "Start voice conversation",
    );
  }

  function resetRecordingControls() {
    micButton.classList.remove("listening");
    micButton.textContent = "Mic";
    micButton.setAttribute("aria-label", "Start voice input");
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

  function cleanupCaptureResources({ releaseStream = true } = {}) {
    stopCaptureAnalysis();
    if (releaseStream) releaseMediaStream();
  }

  function stopRecording(shouldDiscard = false, options = {}) {
    discardRecording ||= shouldDiscard;
    if (mediaRecorder?.state === "recording") {
      mediaRecorder.stop();
    }
    stopCaptureAnalysis();
    if (options.releaseStream) releaseMediaStream();
  }

  function stopAudioPlayback() {
    playbackGeneration += 1;
    window.clearTimeout(playbackTimeout);
    playbackTimeout = 0;
    if (responseAudio) {
      responseAudio.onplaying = null;
      responseAudio.onended = null;
      responseAudio.onerror = null;
      responseAudio.pause();
      responseAudio.removeAttribute("src");
      responseAudio.load();
      responseAudio = null;
    }
  }

  function stopVoiceSession() {
    voiceSessionActive = false;
    captureGeneration += 1;
    stopRecording(true, { releaseStream: true });
    transcriptionController?.abort();
    transcriptionController = null;
    stopAudioPlayback();
    updateVoiceState("idle");
  }

  function setInteractionMode(nextMode) {
    if (!["chat", "voice"].includes(nextMode)) return;
    if (nextMode === "voice" && !mediaCaptureSupported) {
      updateVoiceState("unavailable", "Voice is not supported in this browser");
      return;
    }
    if (nextMode === "voice" && voiceConfigured === false) {
      updateVoiceState("unavailable", "Voice mode needs setup");
      return;
    }

    interactionMode = nextMode;
    const voiceMode = interactionMode === "voice";
    panel.classList.toggle("voice-mode", voiceMode);
    chatModeButton.classList.toggle("active", !voiceMode);
    voiceModeButton.classList.toggle("active", voiceMode);
    chatModeButton.setAttribute("aria-selected", String(!voiceMode));
    voiceModeButton.setAttribute("aria-selected", String(voiceMode));
    if (voiceMode) {
      voiceOrbButton.focus();
    } else {
      stopVoiceSession();
      input.focus();
    }
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
        if (!mediaRecorder || mediaRecorder.state !== "recording" || !audioAnalyser) {
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
          if (recordingRequestMode === "voice") {
            updateVoiceState("thinking", "Got it…");
          }
          stopRecording(false);
          return;
        }
        if (!heardSpeech && elapsed >= NO_SPEECH_TIMEOUT_MS) {
          if (recordingRequestMode === "voice") {
            voiceSessionActive = false;
            updateVoiceState("idle", "I didn’t hear anything—tap to retry");
          }
          stopRecording(true);
          return;
        }
        audioMonitorFrame = window.requestAnimationFrame(monitor);
      };
      audioMonitorFrame = window.requestAnimationFrame(monitor);
    } catch (_error) {
      // Recording still works with tap-to-stop when audio analysis is unavailable.
    }
  }

  async function transcribeRecording(recording, requestMode) {
    if (!recording.size) return;
    transcribing = true;
    micButton.disabled = true;
    if (requestMode === "voice") updateVoiceState("thinking", "Got it…");
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
      if (!response.ok || payload?.success !== true || typeof payload?.text !== "string") {
        throw new Error(payload?.error || "The recording could not be transcribed.");
      }
      transcript = payload.text.trim();
    } catch (error) {
      if (controller.signal.aborted && !timedOut) return;
      const message = timedOut
        ? "Transcription took too long. Please try again."
        : error?.message || "Voice transcription is temporarily unavailable.";
      if (requestMode === "voice") {
        voiceSessionActive = false;
        updateVoiceState("idle", "Tap to try again");
        voiceUserText.textContent = message;
        voiceUserTurn.classList.remove("hidden");
      } else {
        addMessage("error", message);
      }
    } finally {
      window.clearTimeout(timeout);
      if (transcriptionController === controller) transcriptionController = null;
      transcribing = false;
      micButton.disabled = busy || voiceConfigured === false;
    }

    if (!transcript) return;
    input.value = transcript;
    resizeInput();
    if (
      requestMode === "voice" &&
      interactionMode === "voice" &&
      voiceSessionActive
    ) {
      voiceUserText.textContent = transcript;
      voiceUserTurn.classList.remove("hidden");
      await sendMessage();
    } else {
      input.focus();
      if (requestMode === "chat" && submitSpeech) await sendMessage();
    }
  }

  async function startListening(requestMode = interactionMode) {
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
      if (requestMode === "voice") {
        updateVoiceState("unavailable", "Voice mode needs setup");
      } else {
        addMessage("error", "Voice mode is not configured yet.");
      }
      return;
    }

    stopAudioPlayback();
    recordingRequestMode = requestMode;
    discardRecording = false;
    recordingChunks = [];
    heardSpeech = false;
    lastVoiceActivityAt = 0;
    const requestedCaptureGeneration = ++captureGeneration;
    try {
      let requestedStream = mediaStream?.active ? mediaStream : null;
      if (!requestedStream) {
        capturePending = true;
        requestedStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            autoGainControl: true,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            sampleRate: { ideal: 48000 },
            sampleSize: { ideal: 16 },
          },
        });
      }
      capturePending = false;
      if (requestedCaptureGeneration !== captureGeneration) {
        requestedStream.getTracks().forEach((track) => track.stop());
        return;
      }
      mediaStream = requestedStream;
      mediaStream.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
      const preferredMimeType = selectedRecordingMimeType();
      const recorderOptions = {
        ...(preferredMimeType ? { mimeType: preferredMimeType } : {}),
        audioBitsPerSecond: 128000,
      };
      mediaRecorder = preferredMimeType
        ? new MediaRecorder(mediaStream, recorderOptions)
        : new MediaRecorder(mediaStream, recorderOptions);
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
          const requestWasFor = recordingRequestMode;
          const shouldDiscard = discardRecording;
          const recording = new Blob(recordingChunks, {
            type: recordingMimeType,
          });
          mediaRecorder = null;
          recordingChunks = [];
          resetRecordingControls();
          const keepStream =
            requestWasFor === "voice" &&
            voiceSessionActive &&
            interactionMode === "voice";
          cleanupCaptureResources({ releaseStream: !keepStream });
          if (!shouldDiscard) void transcribeRecording(recording, requestWasFor);
        },
        { once: true },
      );
      mediaRecorder.addEventListener(
        "error",
        () => {
          discardRecording = true;
          stopRecording(true);
          if (requestMode === "voice") {
            voiceSessionActive = false;
            updateVoiceState("idle", "Recording failed—tap to retry");
          } else {
            addMessage("error", "The microphone recording failed.");
          }
        },
        { once: true },
      );
      mediaRecorder.start(100);
      recordingStartedAt = performance.now();
      recordingTimeout = window.setTimeout(() => {
        if (requestMode === "voice") {
          updateVoiceState("thinking", "Got it…");
        }
        stopRecording(!heardSpeech);
      }, MAX_RECORDING_MS);
      monitorVoiceActivity(mediaStream);
      micButton.classList.add("listening");
      micButton.textContent = "Stop";
      micButton.setAttribute("aria-label", "Stop and transcribe voice input");
      if (requestMode === "voice") {
        voiceSessionActive = true;
        voiceUserText.textContent = "Listening…";
        voiceUserTurn.classList.remove("hidden");
        updateVoiceState("listening", "I’m listening…");
      }
    } catch (error) {
      capturePending = false;
      cleanupCaptureResources();
      mediaRecorder = null;
      resetRecordingControls();
      const permissionDenied = ["NotAllowedError", "SecurityError"].includes(
        error?.name,
      );
      if (requestMode === "voice") {
        voiceSessionActive = false;
        updateVoiceState(
          "idle",
          permissionDenied
            ? "Microphone permission is needed"
            : "Microphone unavailable—tap to retry",
        );
      } else {
        addMessage(
          "error",
          permissionDenied
            ? "Microphone permission is needed."
            : "The microphone is unavailable.",
        );
      }
    }
  }

  async function speakResponse(speechId, callbacks = {}) {
    if (interactionMode !== "voice" || !voiceSessionActive) {
      updateVoiceState("idle");
      return;
    }

    stopAudioPlayback();
    const generation = playbackGeneration;
    updateVoiceState("thinking", "Almost ready…");
    try {
      const speechUrl = new URL(
        `${apiUrl}/api/speech/${encodeURIComponent(speechId)}`,
      );
      speechUrl.searchParams.set("sessionId", sessionId);
      const player = new Audio();
      responseAudio = player;
      player.preload = "auto";
      player.src = speechUrl.href;
      player.onplaying = () => {
        if (generation !== playbackGeneration) return;
        window.clearTimeout(playbackTimeout);
        playbackTimeout = 0;
        mediaStream?.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
        callbacks.onPlaying?.();
        updateVoiceState("speaking");
      };
      player.onended = () => {
        if (generation !== playbackGeneration) return;
        responseAudio = null;
        if (voiceSessionActive && interactionMode === "voice") {
          updateVoiceState("idle", "Your turn…");
          void startListening("voice");
        } else {
          updateVoiceState("idle");
        }
      };
      player.onerror = () => {
        if (generation !== playbackGeneration) return;
        callbacks.onFailure?.();
        stopAudioPlayback();
        voiceSessionActive = false;
        updateVoiceState("idle", "Audio could not play—tap to retry");
      };
      playbackTimeout = window.setTimeout(() => {
        if (generation !== playbackGeneration || !responseAudio) return;
        callbacks.onFailure?.();
        stopAudioPlayback();
        voiceSessionActive = false;
        updateVoiceState("idle", "Voice took too long—tap to retry");
      }, AUDIO_REQUEST_TIMEOUT_MS);
      player.load();
      await player.play();
    } catch (error) {
      if (generation !== playbackGeneration) return;
      callbacks.onFailure?.();
      stopAudioPlayback();
      voiceSessionActive = false;
      updateVoiceState(
        "idle",
        "Voice playback failed—tap to retry",
      );
    }
  }

  function setOpen(open) {
    panel.classList.toggle("open", open);
    launcher.classList.toggle("hidden", open);
    panel.setAttribute("aria-hidden", String(!open));
    launcher.setAttribute("aria-expanded", String(open));
    if (open) {
      window.setTimeout(
        () =>
          interactionMode === "voice"
            ? voiceOrbButton.focus()
            : input.focus(),
        150,
      );
    } else {
      stopVoiceSession();
      launcher.focus();
    }
  }

  function setWorkspace(nextWorkspace, openPanel = false) {
    if (!WORKSPACES[nextWorkspace] || busy) return;
    const changed = workspace !== nextWorkspace;
    workspace = nextWorkspace;
    workspaceSelect.value = workspace;
    if (changed) {
      stopVoiceSession();
      resetConversation();
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
      const ready = payload?.ready === true;
      voiceConfigured = payload?.voice?.configured === true;
      const anythingLlmReady = payload?.anythingLlm === true;
      status.textContent = ready
        ? "Ready"
        : anythingLlmReady
          ? "Voice setup"
          : "Check setup";
      status.classList.toggle("ready", ready);
      status.classList.toggle("unavailable", !ready);
      launcher.classList.toggle("unavailable", !ready);
      voiceModeButton.disabled = !mediaCaptureSupported || !voiceConfigured;
      micButton.disabled = busy || transcribing || !voiceConfigured;
      if (!voiceConfigured) {
        voiceModeButton.title = "Voice mode needs setup";
        micButton.title = "Voice input needs setup";
      } else {
        voiceModeButton.title = "";
        micButton.title = "Voice input";
      }
    } catch (_error) {
      voiceConfigured = false;
      status.textContent = "Offline";
      status.classList.add("unavailable");
      launcher.classList.add("unavailable");
      voiceModeButton.disabled = true;
      micButton.disabled = true;
    }
  }

  async function sendMessage() {
    const message = input.value.trim();
    if (!message || busy) return;
    const requestMode = interactionMode;

    addMessage("user", message);
    if (requestMode === "voice") {
      voiceUserText.textContent = message;
      voiceUserTurn.classList.remove("hidden");
      voiceAgentTurn.classList.add("hidden");
      updateVoiceState("thinking");
    }
    input.value = "";
    busy = true;
    clearButton.disabled = true;
    resizeInput();
    input.disabled = true;
    micButton.disabled = true;
    workspaceSelect.disabled = true;
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
          voice: requestMode === "voice" && voiceSessionActive,
        }),
        signal: controller.signal,
      });

      let payload;
      try {
        payload = await response.json();
      } catch (_error) {
        throw new Error("The server returned an invalid response.");
      }

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
      const shouldSpeak =
        requestMode === "voice" &&
        interactionMode === "voice" &&
        voiceSessionActive &&
        typeof payload.speechId === "string";
      const responseView = addAnimatedResponse(payload.message, {
        deferred: shouldSpeak,
      });
      if (requestMode === "voice") {
        const startVoiceReveal = renderVoiceResponse(
          payload.message,
          shouldSpeak,
        );
        if (shouldSpeak) {
          let revealed = false;
          const revealResponse = () => {
            if (revealed) return;
            revealed = true;
            responseView.startReveal();
            startVoiceReveal();
          };
          await speakResponse(payload.speechId, {
            onPlaying: revealResponse,
            onFailure: revealResponse,
          });
        } else if (voiceSessionActive && interactionMode === "voice") {
          updateVoiceState("idle", "Your turn…");
          void startListening("voice");
        }
      }
    } catch (error) {
      typing.remove();
      const errorMessage =
        error?.name === "AbortError"
          ? "That took too long. Please try the question again."
          : error?.message || "The assistant is unreachable. Please try again.";
      addMessage("error", errorMessage);
      if (requestMode === "voice") {
        voiceSessionActive = false;
        voiceAgentText.textContent = errorMessage;
        voiceAgentTurn.classList.remove("hidden");
        updateVoiceState("idle", "Tap to try again");
      }
    } finally {
      window.clearTimeout(timeout);
      busy = false;
      clearButton.disabled = false;
      input.disabled = false;
      micButton.disabled = transcribing || voiceConfigured === false;
      workspaceSelect.disabled = false;
      resizeInput();
      if (interactionMode === "chat") input.focus();
    }
  }

  if (!mediaCaptureSupported) {
    micButton.hidden = true;
    voiceModeButton.disabled = true;
    voiceModeButton.title = "Microphone recording is not supported in this browser";
  }

  chatModeButton.addEventListener("click", () => setInteractionMode("chat"));
  voiceModeButton.addEventListener("click", () => setInteractionMode("voice"));
  micButton.addEventListener("click", () => {
    if (mediaRecorder?.state === "recording") {
      stopRecording(false);
    } else {
      void startListening("chat");
    }
  });
  voiceOrbButton.addEventListener("click", () => {
    if (voiceState === "listening") {
      updateVoiceState("thinking", "Got it…");
      stopRecording(false);
      return;
    }
    if (voiceState === "speaking") {
      stopAudioPlayback();
      void startListening("voice");
      return;
    }
    if (voiceState === "thinking") {
      voiceSessionActive = false;
      transcriptionController?.abort();
      stopAudioPlayback();
      updateVoiceState("idle", "Paused—tap to continue");
      return;
    }
    void startListening("voice");
  });
  launcher.addEventListener("click", () => setOpen(true));
  clearButton.addEventListener("click", clearConversation);
  closeButton.addEventListener("click", () => setOpen(false));
  workspaceSelect.addEventListener("change", () => {
    setWorkspace(workspaceSelect.value);
  });
  input.addEventListener("input", resizeInput);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage();
  });
  document.addEventListener("assistant:set-workspace", (event) => {
    setWorkspace(event.detail?.workspace, true);
  });
  document.addEventListener("assistant:set-mode", (event) => {
    setInteractionMode(event.detail?.mode);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel.classList.contains("open")) {
      setOpen(false);
    }
  });

  resetConversation();
  resizeInput();
  checkReadiness();
})();
