import { applyStaticTranslations, getInitialLanguage, saveLanguage, t } from "./i18n.js";

const elements = {
  apiBaseUrl: document.querySelector("#apiBaseUrl"),
  gatewayBaseUrl: document.querySelector("#gatewayBaseUrl"),
  sessionTitle: document.querySelector("#sessionTitle"),
  sourceLanguage: document.querySelector("#sourceLanguage"),
  targetLanguages: document.querySelector("#targetLanguages"),
  sessionId: document.querySelector("#sessionId"),
  sessionInfo: document.querySelector("#sessionInfo"),
  webStatus: document.querySelector("#webStatus"),
  gatewayStatus: document.querySelector("#gatewayStatus"),
  permissionStatus: document.querySelector("#permissionStatus"),
  captureStatus: document.querySelector("#captureStatus"),
  pageLanguage: document.querySelector("#pageLanguage"),
  microphoneSelect: document.querySelector("#microphoneSelect"),
  captureTranscriptHint: document.querySelector("#captureTranscriptHint"),
  startCaptureButton: document.querySelector("#startCaptureButton"),
  stopCaptureButton: document.querySelector("#stopCaptureButton"),
  captureLevelFill: document.querySelector("#captureLevelFill"),
  chunkCount: document.querySelector("#chunkCount"),
  byteCount: document.querySelector("#byteCount"),
  lastAck: document.querySelector("#lastAck"),
  textPayload: document.querySelector("#textPayload"),
  audioFileInput: document.querySelector("#audioFileInput"),
  fileTranscriptHint: document.querySelector("#fileTranscriptHint"),
  sourceTranscriptList: document.querySelector("#sourceTranscriptList"),
  translationTranscriptList: document.querySelector("#translationTranscriptList"),
  summaryStatus: document.querySelector("#summaryStatus"),
  summaryList: document.querySelector("#summaryList"),
  audioClipList: document.querySelector("#audioClipList"),
  shareInfo: document.querySelector("#shareInfo"),
  eventLog: document.querySelector("#eventLog"),
  createSessionButton: document.querySelector("#createSessionButton"),
  connectButton: document.querySelector("#connectButton"),
  loadReplayButton: document.querySelector("#loadReplayButton"),
  stopButton: document.querySelector("#stopButton"),
  shareButton: document.querySelector("#shareButton"),
  requestMicButton: document.querySelector("#requestMicButton"),
  refreshDevicesButton: document.querySelector("#refreshDevicesButton"),
  sendTextButton: document.querySelector("#sendTextButton"),
  sendFileButton: document.querySelector("#sendFileButton")
};

const state = {
  language: getInitialLanguage(),
  devices: [],
  eventSource: null,
  capture: null,
  animationFrameId: null,
  sourceSegments: new Map(),
  translations: new Map(),
  audioClips: new Map()
};

function tr(key, replacements) {
  return t(state.language, key, replacements);
}

function targetLanguages() {
  return elements.targetLanguages.value
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function formatBytes(byteLength) {
  if (byteLength < 1024) return `${byteLength} B`;
  if (byteLength < 1024 * 1024) return `${(byteLength / 1024).toFixed(1)} KB`;
  return `${(byteLength / (1024 * 1024)).toFixed(1)} MB`;
}

function setPill(element, text, tone = "ok") {
  element.textContent = text;
  element.classList.toggle("warn", tone === "warn");
}

function appendEvent(title, payload) {
  const item = document.createElement("div");
  item.className = "event";
  item.innerHTML = `<strong>${title}</strong><pre>${JSON.stringify(payload, null, 2)}</pre>`;
  elements.eventLog.prepend(item);
}

function resetReplayState() {
  state.sourceSegments.clear();
  state.translations.clear();
  state.audioClips.clear();
  renderTranscriptViews();
  renderSummary();
  renderAudioClips();
}

function orderedSourceSegments() {
  return Array.from(state.sourceSegments.values()).sort((left, right) => left.sequence - right.sequence);
}

function orderedTranslations() {
  return Array.from(state.translations.values()).sort((left, right) => {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
    return (left.targetLanguage ?? "").localeCompare(right.targetLanguage ?? "");
  });
}

function orderedAudioClips() {
  return Array.from(state.audioClips.values()).sort((left, right) => {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence;
    return left.createdAt.localeCompare(right.createdAt);
  });
}

function translationBySegmentId(segmentId) {
  return orderedTranslations().find((translation) => translation.segmentId === segmentId);
}

function renderTranscriptViews() {
  const sourceHtml = orderedSourceSegments().map((segment) => `
    <div class="transcript-item">
      <div class="transcript-meta">#${segment.sequence} · ${segment.status}</div>
      <div>${segment.text}</div>
    </div>
  `).join("");

  const translationHtml = orderedSourceSegments().map((segment) => {
    const translation = translationBySegmentId(segment.segmentId);
    return `
      <div class="transcript-item">
        <div class="transcript-meta">#${segment.sequence} · ${translation?.targetLanguage ?? tr("status.translationPending")}</div>
        <div>${translation?.text ?? `<em>${tr("status.translationPending")}</em>`}</div>
      </div>
    `;
  }).join("");

  elements.sourceTranscriptList.innerHTML = sourceHtml || `<div class="transcript-item">${tr("status.noSource")}</div>`;
  elements.translationTranscriptList.innerHTML = translationHtml || `<div class="transcript-item">${tr("status.noTranslation")}</div>`;
}

function renderSummary() {
  const finalSegments = orderedSourceSegments().filter((segment) => segment.status === "final");

  if (finalSegments.length === 0) {
    elements.summaryStatus.textContent = tr("status.replayWaiting");
    elements.summaryList.innerHTML = `<div class="transcript-item">${tr("status.noSummary")}</div>`;
    return;
  }

  const bullets = finalSegments.slice(-4).map((segment) => {
    const translation = translationBySegmentId(segment.segmentId);
    return `
      <div class="transcript-item">
        <div class="transcript-meta">Focus #${segment.sequence}</div>
        <div>${segment.text}</div>
        ${translation?.text ? `<div class="transcript-meta">${translation.text}</div>` : ""}
      </div>
    `;
  }).join("");

  elements.summaryStatus.textContent = tr("status.replaySummary", { count: finalSegments.length });
  elements.summaryList.innerHTML = bullets;
}

function renderAudioClips() {
  const html = orderedAudioClips().map((clip) => `
    <div class="audio-item">
      <div class="transcript-meta">#${clip.sequence} · ${clip.targetLanguage ?? "audio"} · ${formatBytes(clip.byteLength)}</div>
      <audio controls src="data:${clip.mimeType};base64,${clip.dataBase64}"></audio>
    </div>
  `).join("");

  elements.audioClipList.innerHTML = html || `<div class="audio-item">${tr("status.noAudio")}</div>`;
}

function updateFromReplay(replay) {
  resetReplayState();

  for (const segment of replay.segments ?? []) {
    state.sourceSegments.set(segment.segmentId, segment);
  }

  for (const translation of replay.translations ?? []) {
    const segment = state.sourceSegments.get(translation.segmentId);
    state.translations.set(`${translation.segmentId}:${translation.targetLanguage}`, {
      ...translation,
      sequence: segment?.sequence ?? Number.MAX_SAFE_INTEGER
    });
  }

  for (const audioClip of replay.audioClips ?? []) {
    state.audioClips.set(audioClip.audioClipId, audioClip);
  }

  renderTranscriptViews();
  renderSummary();
  renderAudioClips();
}

function applyLanguage(language) {
  state.language = language;
  elements.pageLanguage.value = language;
  saveLanguage(language);
  applyStaticTranslations(language);
  setPill(elements.webStatus, tr("status.webReady"));
  setPill(elements.permissionStatus, tr("status.permissionIdle"));
  if (!state.capture) {
    setPill(elements.captureStatus, tr("status.captureIdle"));
  }
  if (!elements.sessionInfo.textContent || elements.sessionInfo.textContent === "No active session yet.") {
    elements.sessionInfo.textContent = tr("status.sessionNone");
  }
  if (!elements.shareInfo.textContent || elements.shareInfo.textContent === "No share link generated yet.") {
    elements.shareInfo.textContent = tr("status.shareNone");
  }
  renderTranscriptViews();
  renderSummary();
  renderAudioClips();
}

async function refreshGatewayHealth() {
  try {
    const response = await fetch(`${elements.gatewayBaseUrl.value}/health`);
    const payload = await response.json();
    const configured = payload.asrProvider ?? "unknown";
    const active = payload.activeProvider ?? configured;
    const fallback = payload.fallbackProvider ? ` / fallback ${payload.fallbackProvider}` : "";
    const suffix = active !== configured ? ` / active ${active}` : "";
    setPill(elements.gatewayStatus, `${tr("status.gatewayPrefix")}: ${configured}${suffix}${fallback}`);
  } catch (error) {
    setPill(elements.gatewayStatus, tr("status.gatewayUnavailable"), "warn");
    appendEvent("gateway.health_error", { message: error instanceof Error ? error.message : String(error) });
  }
}

async function createSession() {
  const response = await fetch(`${elements.apiBaseUrl.value}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: elements.sessionTitle.value,
      config: {
        sourceLanguage: elements.sourceLanguage.value,
        targetLanguages: targetLanguages(),
        enableAudioStorage: false,
        enableLiveShare: true,
        glossaryIds: [],
        referenceDocumentIds: []
      },
      deviceSelection: { sourceKind: "microphone" }
    })
  });

  const session = await response.json();
  elements.sessionId.value = session.id;
  elements.sessionInfo.textContent = `Session created: ${session.id}`;
  appendEvent("session.created", session);
  resetReplayState();
  return session.id;
}

async function ensureSessionId() {
  return elements.sessionId.value.trim() || createSession();
}

function applyRealtimeEnvelope(envelope) {
  if (envelope.type === "segment.upserted") {
    state.sourceSegments.set(envelope.payload.segmentId, envelope.payload);
  }

  if (envelope.type === "translation.upserted") {
    const segment = state.sourceSegments.get(envelope.payload.segmentId);
    state.translations.set(`${envelope.payload.segmentId}:${envelope.payload.targetLanguage}`, {
      ...envelope.payload,
      sequence: segment?.sequence ?? Number.MAX_SAFE_INTEGER
    });
  }

  if (envelope.type === "audio.clip_received") {
    state.audioClips.set(envelope.payload.audioClipId, envelope.payload);
  }

  renderTranscriptViews();
  renderSummary();
  renderAudioClips();
}

function connectStream() {
  const sessionId = elements.sessionId.value.trim();
  if (!sessionId) {
    alert(tr("status.sessionMissing"));
    return;
  }

  if (state.eventSource) {
    state.eventSource.close();
  }

  state.eventSource = new EventSource(`${elements.gatewayBaseUrl.value}/sessions/${sessionId}/stream`);
  state.eventSource.onmessage = (event) => {
    const envelope = JSON.parse(event.data);
    appendEvent(envelope.type, envelope.payload);
    applyRealtimeEnvelope(envelope);
  };
}

async function sendText() {
  const sessionId = await ensureSessionId();
  const response = await fetch(`${elements.gatewayBaseUrl.value}/sessions/${sessionId}/ingest-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: elements.textPayload.value,
      sourceLanguage: elements.sourceLanguage.value,
      targetLanguages: targetLanguages()
    })
  });

  appendEvent("send.text", await response.json());
}

async function loadReplay() {
  const sessionId = elements.sessionId.value.trim();
  if (!sessionId) {
    alert(tr("status.sessionMissing"));
    return;
  }

  const response = await fetch(`${elements.apiBaseUrl.value}/sessions/${sessionId}/replay`);
  updateFromReplay(await response.json());
}

async function createShareLink() {
  const sessionId = elements.sessionId.value.trim();
  if (!sessionId) {
    alert(tr("status.sessionMissing"));
    return;
  }

  const response = await fetch(`${elements.apiBaseUrl.value}/sessions/${sessionId}/share-links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access: "anonymous_view",
      expiresInHours: 24
    })
  });

  const link = await response.json();
  const viewerUrl = `${location.origin}/viewer?token=${link.token}&api=${encodeURIComponent(elements.apiBaseUrl.value)}&gateway=${encodeURIComponent(elements.gatewayBaseUrl.value)}`;
  elements.shareInfo.innerHTML = `<a href="${viewerUrl}" target="_blank">${viewerUrl}</a>`;
  appendEvent("share.created", link);
}

function renderDeviceOptions() {
  elements.microphoneSelect.innerHTML = "";

  if (state.devices.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = tr("status.devicesMissing");
    elements.microphoneSelect.append(option);
    return;
  }

  for (const [index, device] of state.devices.entries()) {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `Microphone ${index + 1}`;
    elements.microphoneSelect.append(option);
  }
}

async function refreshAudioInputDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    setPill(elements.webStatus, tr("status.devicesUnsupported"), "warn");
    return;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  state.devices = devices.filter((device) => device.kind === "audioinput");
  renderDeviceOptions();

  if (state.devices.length === 0) {
    setPill(elements.webStatus, tr("status.devicesMissing"), "warn");
    return;
  }

  setPill(elements.webStatus, tr("status.devicesLoaded", { count: state.devices.length }));
}

async function requestMicrophoneAccess() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setPill(elements.permissionStatus, tr("status.permissionUnsupported"), "warn");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    setPill(elements.permissionStatus, tr("status.permissionGranted"));
    await refreshAudioInputDevices();
  } catch (error) {
    setPill(elements.permissionStatus, tr("status.permissionDenied"), "warn");
    appendEvent("microphone.permission_error", { message: error instanceof Error ? error.message : String(error) });
  }
}

function chooseMimeType() {
  if (!window.MediaRecorder) return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function encodingFromMimeType(mimeType) {
  return mimeType.includes("opus") ? "opus" : "unknown";
}

function startAudioMeter(stream) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    return async () => {
      elements.captureLevelFill.style.width = "0%";
    };
  }

  const audioContext = new AudioContextCtor();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);

  const tick = () => {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;

    for (const sample of samples) {
      const normalized = (sample - 128) / 128;
      sum += normalized * normalized;
    }

    const rms = Math.sqrt(sum / samples.length);
    const width = Math.min(100, Math.round(rms * 220));
    elements.captureLevelFill.style.width = `${width}%`;
    state.animationFrameId = window.requestAnimationFrame(tick);
  };

  tick();

  return async () => {
    if (state.animationFrameId) {
      window.cancelAnimationFrame(state.animationFrameId);
      state.animationFrameId = null;
    }
    source.disconnect();
    analyser.disconnect();
    elements.captureLevelFill.style.width = "0%";
    await audioContext.close();
  };
}

async function uploadChunk(sessionId, body, options) {
  const response = await fetch(`${elements.gatewayBaseUrl.value}/sessions/${sessionId}/audio-chunks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "x-audio-chunk-id": options.chunkId,
      "x-audio-sequence": String(options.sequence),
      "x-audio-encoding": options.encoding,
      "x-audio-sample-rate": String(options.sampleRateHz),
      "x-audio-channels": String(options.channels),
      "x-audio-duration-ms": String(options.durationMs),
      "x-audio-final": options.isFinalChunk ? "true" : "false",
      "x-source-language": options.sourceLanguage,
      "x-target-languages": options.targetLanguages.join(","),
      ...(options.transcriptHint ? { "x-transcript-hint": options.transcriptHint } : {})
    },
    body
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.detail ?? "Audio chunk upload failed.");
  }

  elements.chunkCount.textContent = String(payload.totalChunksReceived ?? 0);
  elements.byteCount.textContent = formatBytes(payload.totalBytesReceived ?? 0);
  elements.lastAck.textContent = payload.transcriptAccepted ? tr("status.transcriptAccepted") : tr("status.chunkAccepted");
  appendEvent("send.chunk", payload);
  return payload;
}

async function startCapture() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setPill(elements.captureStatus, tr("status.captureUnsupported"), "warn");
    return;
  }

  if (state.capture?.recorder) {
    return;
  }

  const sessionId = await ensureSessionId();
  connectStream();

  const selectedDeviceId = elements.microphoneSelect.value;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: selectedDeviceId ? { deviceId: { exact: selectedDeviceId }, channelCount: 1 } : true
  });

  const mimeType = chooseMimeType();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const cleanupMeter = startAudioMeter(stream);

  state.capture = {
    sessionId,
    recorder,
    stream,
    cleanupMeter,
    nextSequence: 1,
    encoding: encodingFromMimeType(mimeType),
    sampleRateHz: 48_000,
    channels: 1
  };

  elements.startCaptureButton.disabled = true;
  elements.stopCaptureButton.disabled = false;
  setPill(elements.captureStatus, tr("status.captureActive"));

  recorder.ondataavailable = async (event) => {
    if (!event.data || event.data.size === 0 || !state.capture) return;
    const body = new Uint8Array(await event.data.arrayBuffer());
    const ack = await uploadChunk(sessionId, body, {
      chunkId: crypto.randomUUID(),
      sequence: state.capture.nextSequence,
      encoding: state.capture.encoding,
      sampleRateHz: state.capture.sampleRateHz,
      channels: state.capture.channels,
      durationMs: 1000,
      isFinalChunk: false,
      sourceLanguage: elements.sourceLanguage.value,
      targetLanguages: targetLanguages()
    });
    state.capture.nextSequence += 1;
    appendEvent("audio.chunk_uploaded", ack);
  };

  recorder.onerror = (event) => {
    setPill(elements.captureStatus, tr("status.captureFailed"), "warn");
    appendEvent("microphone.capture_error", {
      message: event.error?.message ?? "unknown media recorder error"
    });
  };

  recorder.onstop = async () => {
    const currentCapture = state.capture;
    const transcriptHint = elements.captureTranscriptHint.value.trim();

    try {
      if (currentCapture && transcriptHint) {
        const ack = await uploadChunk(sessionId, new Uint8Array(0), {
          chunkId: crypto.randomUUID(),
          sequence: currentCapture.nextSequence,
          encoding: "unknown",
          sampleRateHz: currentCapture.sampleRateHz,
          channels: currentCapture.channels,
          durationMs: 0,
          isFinalChunk: true,
          sourceLanguage: elements.sourceLanguage.value,
          targetLanguages: targetLanguages(),
          transcriptHint
        });
        appendEvent("audio.capture_finalized", ack);
      }
    } finally {
      if (currentCapture) {
        currentCapture.stream.getTracks().forEach((track) => track.stop());
        await currentCapture.cleanupMeter();
      }
      state.capture = null;
      elements.startCaptureButton.disabled = false;
      elements.stopCaptureButton.disabled = true;
      setPill(elements.captureStatus, tr("status.captureIdle"));
    }
  };

  recorder.start(1000);
}

function stopCapture() {
  if (!state.capture?.recorder) return;
  setPill(elements.captureStatus, tr("status.captureStopping"));
  state.capture.recorder.stop();
}

async function sendSelectedFile() {
  const sessionId = await ensureSessionId();
  const file = elements.audioFileInput.files?.[0];
  if (!file) {
    alert(tr("status.selectFile"));
    return;
  }

  const chunkSize = 32 * 1024;
  let offset = 0;
  let sequence = 1;

  while (offset < file.size) {
    const chunk = file.slice(offset, offset + chunkSize);
    const buffer = new Uint8Array(await chunk.arrayBuffer());
    offset += chunkSize;

    await uploadChunk(sessionId, buffer, {
      chunkId: crypto.randomUUID(),
      sequence,
      encoding: file.name.toLowerCase().endsWith(".wav") ? "wav" : "unknown",
      sampleRateHz: 16000,
      channels: 1,
      durationMs: 1000,
      isFinalChunk: offset >= file.size,
      sourceLanguage: elements.sourceLanguage.value,
      targetLanguages: targetLanguages(),
      transcriptHint: offset >= file.size ? elements.fileTranscriptHint.value.trim() : undefined
    });

    sequence += 1;
  }
}

async function stopSession() {
  const sessionId = elements.sessionId.value.trim();
  if (!sessionId) {
    alert(tr("status.sessionMissing"));
    return;
  }

  await fetch(`${elements.gatewayBaseUrl.value}/sessions/${sessionId}/stop`, { method: "POST" });
  appendEvent("session.stopped", { sessionId });
}

elements.pageLanguage.addEventListener("change", (event) => applyLanguage(event.target.value));
elements.createSessionButton.addEventListener("click", () => createSession().catch((error) => appendEvent("session.create_error", { message: error instanceof Error ? error.message : String(error) })));
elements.connectButton.addEventListener("click", connectStream);
elements.loadReplayButton.addEventListener("click", () => loadReplay().catch((error) => appendEvent("replay.load_error", { message: error instanceof Error ? error.message : String(error) })));
elements.stopButton.addEventListener("click", () => stopSession().catch((error) => appendEvent("session.stop_error", { message: error instanceof Error ? error.message : String(error) })));
elements.shareButton.addEventListener("click", () => createShareLink().catch((error) => appendEvent("share.create_error", { message: error instanceof Error ? error.message : String(error) })));
elements.sendTextButton.addEventListener("click", () => sendText().catch((error) => appendEvent("send.text_error", { message: error instanceof Error ? error.message : String(error) })));
elements.sendFileButton.addEventListener("click", () => sendSelectedFile().catch((error) => appendEvent("send.file_error", { message: error instanceof Error ? error.message : String(error) })));
elements.requestMicButton.addEventListener("click", () => requestMicrophoneAccess().catch((error) => appendEvent("microphone.permission_error", { message: error instanceof Error ? error.message : String(error) })));
elements.refreshDevicesButton.addEventListener("click", () => refreshAudioInputDevices().catch((error) => appendEvent("device.refresh_error", { message: error instanceof Error ? error.message : String(error) })));
elements.startCaptureButton.addEventListener("click", () => startCapture().catch((error) => {
  setPill(elements.captureStatus, tr("status.captureFailed"), "warn");
  appendEvent("capture.start_error", { message: error instanceof Error ? error.message : String(error) });
}));
elements.stopCaptureButton.addEventListener("click", stopCapture);
elements.gatewayBaseUrl.addEventListener("change", () => {
  refreshGatewayHealth().catch(() => {
    setPill(elements.gatewayStatus, tr("status.gatewayUnavailable"), "warn");
  });
});

window.addEventListener("load", () => {
  applyLanguage(state.language);
  refreshAudioInputDevices().catch(() => setPill(elements.webStatus, tr("status.devicesMissing"), "warn"));
  refreshGatewayHealth().catch(() => setPill(elements.gatewayStatus, tr("status.gatewayUnavailable"), "warn"));
  renderTranscriptViews();
  renderSummary();
  renderAudioClips();
});
