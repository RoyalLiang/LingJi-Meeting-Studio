import { applyI18n, getStoredLanguage, initLanguageSelect, languages, setStoredLanguage, translate } from "./i18n.js";
import { createPreviewChannel, publishPreviewState } from "./preview-channel.js";

const FOLDER_STORAGE_KEY = "tts.workspace.folderAssignments";
const PROJECT_FOLDERS_STORAGE_KEY = "tts.workspace.projectFolders";
const RECENT_SESSION_STORAGE_KEY = "tts.workspace.recentSessionIds";
const LAST_SESSION_STORAGE_KEY = "tts.workspace.lastSessionId";
const SESSION_INSIGHTS_STORAGE_KEY = "tts.workspace.sessionInsights";
const LIVE_TRANSCRIPT_WINDOW = 80;
const MAX_EVENT_LOG_ITEMS = 60;
const PCM_SAMPLE_RATE_HZ = 16_000;
const PCM_CHANNEL_COUNT = 1;
const PCM_BYTES_PER_SAMPLE = 2;
const PCM_CHUNK_DURATION_MS = 320;
const PCM_CHUNK_SIZE_BYTES = Math.round(
  (PCM_SAMPLE_RATE_HZ * PCM_CHANNEL_COUNT * PCM_BYTES_PER_SAMPLE * PCM_CHUNK_DURATION_MS) / 1000
);
const PCM_WORKLET_PROCESSOR_NAME = "tts-pcm-capture";
const PCM_WORKLET_FLUSH_TIMEOUT_MS = 2_000;
const LEVEL_UPDATE_INTERVAL_MS = 80;
const UPLOAD_QUEUE_WARN_THRESHOLD = 6;
const UPLOAD_QUEUE_PROTECT_THRESHOLD = 14;
const UPLOAD_QUEUE_TARGET_AFTER_PROTECT = 6;
const MAX_MERGED_UPLOAD_CHUNK_BYTES = 256 * 1024;
const VAD_SPEECH_RMS_THRESHOLD = 0.024;
const VAD_SILENCE_RMS_THRESHOLD = 0.012;
const VAD_HANGOVER_CHUNKS = 2;
const MAX_LIVE_SEGMENTS_IN_MEMORY = 160;
const MAX_LIVE_AUDIO_CLIPS_IN_MEMORY = 48;
const MAX_RECENT_SESSION_IDS = 8;
const STREAM_RETRY_BASE_MS = 900;
const STREAM_RETRY_MAX_MS = 8_000;
const STREAM_STALE_RECONNECT_MS = 6_000;
const STREAM_WATCHDOG_INTERVAL_MS = 1_500;
const HIDDEN_EVENT_TITLES = new Set([
  "send.chunk",
  "audio.chunk_received"
]);

const defaultProjectFolders = [];
const MOCK_FOLDER_IDS = new Set(["meetings", "research", "exports"]);
const FOLDER_COLOR_PALETTE = [
  "#7C3AED",
  "#0EA5E9",
  "#14B8A6",
  "#22C55E",
  "#F59E0B",
  "#EF4444"
];

const COMMON_LANGUAGE_OPTIONS = [
  { code: "zh", labels: { en: "Chinese (Mandarin)", "zh-CN": "\u4e2d\u6587\uff08\u666e\u901a\u8bdd\uff09" } },
  { code: "en", labels: { en: "English", "zh-CN": "\u82f1\u8bed" } },
  { code: "ja", labels: { en: "Japanese", "zh-CN": "\u65e5\u8bed" } },
  { code: "ko", labels: { en: "Korean", "zh-CN": "\u97e9\u8bed" } },
  { code: "fr", labels: { en: "French", "zh-CN": "\u6cd5\u8bed" } },
  { code: "de", labels: { en: "German", "zh-CN": "\u5fb7\u8bed" } },
  { code: "es", labels: { en: "Spanish", "zh-CN": "\u897f\u73ed\u7259\u8bed" } },
  { code: "ru", labels: { en: "Russian", "zh-CN": "\u4fc4\u8bed" } },
  { code: "pt", labels: { en: "Portuguese", "zh-CN": "\u8461\u8404\u7259\u8bed" } },
  { code: "it", labels: { en: "Italian", "zh-CN": "\u610f\u5927\u5229\u8bed" } },
  { code: "ar", labels: { en: "Arabic", "zh-CN": "\u963f\u62c9\u4f2f\u8bed" } },
  { code: "hi", labels: { en: "Hindi", "zh-CN": "\u5370\u5730\u8bed" } }
];
const AUTO_SOURCE_LANGUAGE_OPTION = {
  code: "auto",
  labels: { en: "Auto detect", "zh-CN": "\u81ea\u52a8\u68c0\u6d4b" }
};

const elements = {
  workspaceShell: document.querySelector("#workspaceShell"),
  navDashboardButton: document.querySelector("#navDashboardButton"),
  navFoldersButton: document.querySelector("#navFoldersButton"),
  sidebarDashboardButton: document.querySelector("#sidebarDashboardButton"),
  sidebarFoldersButton: document.querySelector("#sidebarFoldersButton"),
  sidebarHistoryButton: document.querySelector("#sidebarHistoryButton"),
  toggleLanguageButton: document.querySelector("#toggleLanguageButton"),
  toggleLanguageLabel: document.querySelector("#toggleLanguageLabel"),
  toggleSidebarButton: document.querySelector("#toggleSidebarButton"),
  apiBaseUrl: document.querySelector("#apiBaseUrl"),
  gatewayBaseUrl: document.querySelector("#gatewayBaseUrl"),
  sessionTitle: document.querySelector("#sessionTitle"),
  sourceLanguage: document.querySelector("#sourceLanguage"),
  targetLanguages: document.querySelector("#targetLanguages"),
  sessionId: document.querySelector("#sessionId"),
  sessionInfo: document.querySelector("#sessionInfo"),
  shellStatus: document.querySelector("#shellStatus"),
  gatewayStatus: document.querySelector("#gatewayStatus"),
  permissionStatus: document.querySelector("#permissionStatus"),
  captureStatus: document.querySelector("#captureStatus"),
  recordingTimerLive: document.querySelector("#recordingTimerLive"),
  liveLatencyBadge: document.querySelector("#liveLatencyBadge"),
  pauseCaptureButtonLive: document.querySelector("#pauseCaptureButtonLive"),
  recordingSourceLanguage: document.querySelector("#recordingSourceLanguage"),
  recordingTargetLanguage: document.querySelector("#recordingTargetLanguage"),
  lastSessionTitle: document.querySelector("#lastSessionTitle"),
  lastSessionMeta: document.querySelector("#lastSessionMeta"),
  languageSelect: document.querySelector("#languageSelect"),
  openOverlayButton: document.querySelector("#openOverlayButton"),
  heroStartCaptureButton: document.querySelector("#heroStartCaptureButton"),
  uploadAudioTriggerButton: document.querySelector("#uploadAudioTriggerButton"),
  resumeLiveSessionButton: document.querySelector("#resumeLiveSessionButton"),
  resumeReplaySessionButton: document.querySelector("#resumeReplaySessionButton"),
  resumeLiveSessionButtonHero: document.querySelector("#resumeLiveSessionButtonHero"),
  resumeReplaySessionButtonHero: document.querySelector("#resumeReplaySessionButtonHero"),
  resumeLiveSessionButtonLive: document.querySelector("#resumeLiveSessionButtonLive"),
  resumeReplaySessionButtonLive: document.querySelector("#resumeReplaySessionButtonLive"),
  jumpToFoldersButton: document.querySelector("#jumpToFoldersButton"),
  microphoneSelect: document.querySelector("#microphoneSelect"),
  microphonePopdown: document.querySelector("#microphonePopdown"),
  microphonePopdownTrigger: document.querySelector("#microphonePopdownTrigger"),
  microphonePopdownPanel: document.querySelector("#microphonePopdownPanel"),
  sourceLanguagePopdown: document.querySelector("#sourceLanguagePopdown"),
  sourceLanguagePopdownTrigger: document.querySelector("#sourceLanguagePopdownTrigger"),
  sourceLanguagePopdownPanel: document.querySelector("#sourceLanguagePopdownPanel"),
  targetLanguagesPopdown: document.querySelector("#targetLanguagesPopdown"),
  targetLanguagesPopdownTrigger: document.querySelector("#targetLanguagesPopdownTrigger"),
  targetLanguagesPopdownPanel: document.querySelector("#targetLanguagesPopdownPanel"),
  captureTranscriptHint: document.querySelector("#captureTranscriptHint"),
  startCaptureButton: document.querySelector("#startCaptureButton"),
  startCaptureButtonDuplicate: document.querySelector("#startCaptureButtonDuplicate"),
  stopCaptureButton: document.querySelector("#stopCaptureButton"),
  stopCaptureButtonDuplicate: document.querySelector("#stopCaptureButtonDuplicate"),
  captureLevelFill: document.querySelector("#captureLevelFill"),
  chunkCount: document.querySelector("#chunkCount"),
  byteCount: document.querySelector("#byteCount"),
  lastAck: document.querySelector("#lastAck"),
  performanceStatus: document.querySelector("#performanceStatus"),
  textPayload: document.querySelector("#textPayload"),
  audioFileInput: document.querySelector("#audioFileInput"),
  fileTranscriptHint: document.querySelector("#fileTranscriptHint"),
  sourceTranscriptList: document.querySelector("#sourceTranscriptList"),
  translationTranscriptList: document.querySelector("#translationTranscriptList"),
  conversationList: document.querySelector("#conversationList"),
  summaryStatus: document.querySelector("#summaryStatus"),
  summaryList: document.querySelector("#summaryList"),
  audioClipList: document.querySelector("#audioClipList"),
  sessionPreviewDrawer: document.querySelector("#sessionPreviewDrawer"),
  replayInspector: document.querySelector("#replayInspector"),
  currentSourceLine: document.querySelector("#currentSourceLine"),
  currentTranslationLine: document.querySelector("#currentTranslationLine"),
  libraryEyebrow: document.querySelector("#libraryEyebrow"),
  libraryTitle: document.querySelector("#libraryTitle"),
  libraryCopy: document.querySelector("#libraryCopy"),
  sessionListTitle: document.querySelector("#sessionListTitle"),
  sessionListBadge: document.querySelector("#sessionListBadge"),
  eventLog: document.querySelector("#eventLog"),
  folderList: document.querySelector("#folderList"),
  folderEditorDialog: document.querySelector("#folderEditorDialog"),
  folderEditorTitle: document.querySelector("#folderEditorTitle"),
  folderEditorNameInput: document.querySelector("#folderEditorNameInput"),
  folderEditorColorList: document.querySelector("#folderEditorColorList"),
  folderEditorCancelButton: document.querySelector("#folderEditorCancelButton"),
  folderEditorConfirmButton: document.querySelector("#folderEditorConfirmButton"),
  sessionTitleSuggestionDialog: document.querySelector("#sessionTitleSuggestionDialog"),
  sessionTitleSuggestionTitle: document.querySelector("#sessionTitleSuggestionTitle"),
  sessionTitleSuggestionDescription: document.querySelector("#sessionTitleSuggestionDescription"),
  sessionTitleSuggestionInput: document.querySelector("#sessionTitleSuggestionInput"),
  sessionTitleSuggestionCancelButton: document.querySelector("#sessionTitleSuggestionCancelButton"),
  sessionTitleSuggestionConfirmButton: document.querySelector("#sessionTitleSuggestionConfirmButton"),
  captureFolderDialog: document.querySelector("#captureFolderDialog"),
  captureFolderList: document.querySelector("#captureFolderList"),
  captureFolderNameInput: document.querySelector("#captureFolderNameInput"),
  captureFolderCreateButton: document.querySelector("#captureFolderCreateButton"),
  captureFolderCancelButton: document.querySelector("#captureFolderCancelButton"),
  captureFolderConfirmButton: document.querySelector("#captureFolderConfirmButton"),
  undoToast: document.querySelector("#undoToast"),
  undoToastMessage: document.querySelector("#undoToastMessage"),
  undoToastUndoButton: document.querySelector("#undoToastUndoButton"),
  undoToastCloseButton: document.querySelector("#undoToastCloseButton"),
  sessionList: document.querySelector("#sessionList"),
  createSessionButton: document.querySelector("#createSessionButton"),
  connectButton: document.querySelector("#connectButton"),
  loadReplayButton: document.querySelector("#loadReplayButton"),
  stopButton: document.querySelector("#stopButton"),
  stopButtonInline: document.querySelector("#stopButtonInline"),
  stopButtonDuplicate: document.querySelector("#stopButtonDuplicate"),
  requestMicButton: document.querySelector("#requestMicButton"),
  refreshDevicesButton: document.querySelector("#refreshDevicesButton"),
  refreshDevicesButtonDuplicate: document.querySelector("#refreshDevicesButtonDuplicate"),
  sendTextButton: document.querySelector("#sendTextButton"),
  sendFileButton: document.querySelector("#sendFileButton"),
  openOverlayButtonDuplicate: document.querySelector("#openOverlayButtonDuplicate"),
  exportSummaryPdfButton: document.querySelector("#exportSummaryPdfButton"),
  exportReplayJsonButton: document.querySelector("#exportReplayJsonButton")
};

const state = {
  language: getStoredLanguage(),
  sidebarView: "dashboard",
  sidebarCollapsed: false,
  workspaceMode: "idle",
  historyMode: "live",
  folderFilter: "all",
  folderSessionSearch: "",
  folderSessionFolderFilter: "all",
  batchMoveTargetFolderId: "",
  activeProjectFolderId: "",
  selectedSessionIds: [],
  draggingSessionId: "",
  folderAssignments: loadFolderAssignments(),
  projectFolders: loadProjectFolders(),
  recentSessionIds: loadRecentSessionIds(),
  lastSessionId: loadLastSessionId(),
  sessionInsights: loadSessionInsights(),
  devices: [],
  activePopdown: null,
  sessions: [],
  previewSessionId: "",
  previewSessionLoading: false,
  previewSessionError: "",
  previewSessionQuery: "",
  previewReplayCache: new Map(),
  replaySearchQuery: "",
  replayFocusedSequence: 0,
  pendingReplayFocusSequence: 0,
  eventSource: null,
  streamSessionId: null,
  capture: null,
  captureTimerIntervalId: null,
  renderFrameId: null,
  overlayWindow: null,
  currentSpeechDraft: {
    sourceText: "",
    translationText: "",
    sourceTimerId: null,
    translationTimerId: null
  },
  liveNow: {
    sourceText: "",
    translationText: "",
    sourceEventPerfAt: 0,
    translationEventPerfAt: 0,
    sourceEventEpochMs: 0,
    translationEventEpochMs: 0
  },
  liveLatency: {
    sourceLocalMs: 0,
    translationLocalMs: 0,
    sourceE2eMs: 0,
    translationE2eMs: 0,
    sourceUpdatedAt: 0,
    translationUpdatedAt: 0
  },
  trimmedLiveData: {
    segments: 0,
    audioClips: 0
  },
  collectionsDirty: true,
  orderedSourceSegmentsCache: [],
  orderedTranslationsCache: [],
  orderedAudioClipsCache: [],
  primaryTranslations: new Map(),
  pendingRender: {
    transcripts: false,
    summary: false,
    audio: false,
    overlay: false
  },
  folderContextMenuCleanup: null,
  sessionListCleanup: null,
  undoToastTimeoutId: null,
  undoAction: null,
  streamRetryTimerId: null,
  streamRetryAttempt: 0,
  streamWatchdogTimerId: null,
  lastStreamEventAt: 0,
  liveLatencyTickerId: null,
  isEndingRecordingFlow: false,
  sourceSegments: new Map(),
  translations: new Map(),
  audioClips: new Map()
};

const channel = createPreviewChannel();
let pcmWorkletModuleUrl = null;

function loadFolderAssignments() {
  try {
    return JSON.parse(localStorage.getItem(FOLDER_STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveFolderAssignments() {
  localStorage.setItem(FOLDER_STORAGE_KEY, JSON.stringify(state.folderAssignments));
}

function normalizeFolderColor(rawColor) {
  if (typeof rawColor !== "string") {
    return FOLDER_COLOR_PALETTE[0];
  }

  const value = rawColor.trim().toUpperCase();
  return /^#[0-9A-F]{6}$/.test(value) ? value : FOLDER_COLOR_PALETTE[0];
}

function sanitizeProjectFolders(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((folder) => folder && typeof folder === "object")
    .filter((folder) => !MOCK_FOLDER_IDS.has(String(folder.id ?? "").trim().toLowerCase()) || !folder.labelKey)
    .map((folder, index) => ({
      id: String(folder.id ?? "").trim() || createProjectFolderId(),
      label: String(folder.label ?? "").trim() || `Folder ${index + 1}`,
      description: String(folder.description ?? "").trim() || "Custom project folder",
      favorite: Boolean(folder.favorite),
      color: normalizeFolderColor(folder.color ?? FOLDER_COLOR_PALETTE[index % FOLDER_COLOR_PALETTE.length])
    }))
    .filter((folder, index, array) => array.findIndex((item) => item.id === folder.id) === index);
}

function loadProjectFolders() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROJECT_FOLDERS_STORAGE_KEY) ?? "null");
    const folders = sanitizeProjectFolders(parsed);
    return folders.length > 0 ? folders : defaultProjectFolders.map((folder) => ({ ...folder }));
  } catch {
    return defaultProjectFolders.map((folder) => ({ ...folder }));
  }
}

function saveProjectFolders() {
  state.projectFolders = sanitizeProjectFolders(state.projectFolders);
  localStorage.setItem(PROJECT_FOLDERS_STORAGE_KEY, JSON.stringify(state.projectFolders));
}

function loadSessionInsights() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_INSIGHTS_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveSessionInsights() {
  localStorage.setItem(SESSION_INSIGHTS_STORAGE_KEY, JSON.stringify(state.sessionInsights));
}

function normalizeSessionIdList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const result = [];

  for (const item of value) {
    const id = String(item ?? "").trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }

  return result;
}

function setSelectedSessionIds(nextIds) {
  state.selectedSessionIds = normalizeSessionIdList(nextIds);
}

function isSessionSelected(sessionId) {
  return state.selectedSessionIds.includes(sessionId);
}

function toggleSessionSelection(sessionId, forcedState = null) {
  const id = String(sessionId ?? "").trim();
  if (!id) {
    return;
  }

  const current = new Set(state.selectedSessionIds);
  const shouldSelect = forcedState === null ? !current.has(id) : Boolean(forcedState);

  if (shouldSelect) {
    current.add(id);
  } else {
    current.delete(id);
  }

  setSelectedSessionIds(Array.from(current));
}

function clearSessionSelection() {
  setSelectedSessionIds([]);
}

function hideUndoToast() {
  if (state.undoToastTimeoutId) {
    window.clearTimeout(state.undoToastTimeoutId);
    state.undoToastTimeoutId = null;
  }

  state.undoAction = null;

  if (elements.undoToast) {
    elements.undoToast.hidden = true;
  }
}

function showUndoToast(message, undoHandler) {
  if (!elements.undoToast || !elements.undoToastMessage) {
    return;
  }

  hideUndoToast();
  elements.undoToastMessage.textContent = message;
  elements.undoToast.hidden = false;
  state.undoAction = typeof undoHandler === "function" ? undoHandler : null;
  state.undoToastTimeoutId = window.setTimeout(() => {
    hideUndoToast();
  }, 7000);
}

function undoLastAction() {
  if (typeof state.undoAction !== "function") {
    hideUndoToast();
    return;
  }

  const action = state.undoAction;
  hideUndoToast();
  action();
}

async function openFolderEditorDialog(options = {}) {
  const mode = options.mode === "rename" ? "rename" : "create";
  const initialName = String(options.initialName ?? "").trim();
  const initialColor = normalizeFolderColor(options.initialColor ?? nextFolderColor());
  const title = mode === "rename"
    ? (state.language === "zh-CN" ? "重命名文件夹" : "Rename folder")
    : (state.language === "zh-CN" ? "新建文件夹" : "Create folder");
  const confirmLabel = mode === "rename"
    ? (state.language === "zh-CN" ? "保存" : "Save")
    : (state.language === "zh-CN" ? "创建" : "Create");
  const cancelLabel = state.language === "zh-CN" ? "取消" : "Cancel";

  if (!(elements.folderEditorDialog instanceof HTMLDialogElement)
    || !elements.folderEditorNameInput
    || !elements.folderEditorColorList
    || !elements.folderEditorConfirmButton
    || !elements.folderEditorCancelButton) {
    const fallback = window.prompt(title, initialName);
    const name = fallback?.trim();
    if (!name) {
      return null;
    }

    return {
      name,
      color: initialColor
    };
  }

  const dialog = elements.folderEditorDialog;
  const input = elements.folderEditorNameInput;
  const colorList = elements.folderEditorColorList;
  const confirmButton = elements.folderEditorConfirmButton;
  const cancelButton = elements.folderEditorCancelButton;
  let selectedColor = initialColor;

  if (elements.folderEditorTitle) {
    elements.folderEditorTitle.textContent = title;
  }

  confirmButton.textContent = confirmLabel;
  cancelButton.textContent = cancelLabel;
  input.value = initialName;
  input.placeholder = state.language === "zh-CN" ? "输入文件夹名称" : "Folder name";
  colorList.innerHTML = FOLDER_COLOR_PALETTE.map((color) => `
    <button
      class="folder-editor-color ${normalizeFolderColor(color) === selectedColor ? "active" : ""}"
      data-folder-editor-color="${normalizeFolderColor(color)}"
      style="--folder-accent:${normalizeFolderColor(color)};"
      type="button"
      aria-label="${state.language === "zh-CN" ? "选择颜色" : "Choose color"}"
    ></button>
  `).join("");

  const renderColorSelection = () => {
    colorList.querySelectorAll("button[data-folder-editor-color]").forEach((button) => {
      button.classList.toggle("active", button.dataset.folderEditorColor === selectedColor);
    });
  };

  renderColorSelection();

  return new Promise((resolve) => {
    const complete = (payload) => {
      cleanup();
      if (dialog.open) {
        dialog.close();
      }
      resolve(payload);
    };

    const handleCancel = (event) => {
      event.preventDefault();
      complete(null);
    };

    const handleClose = () => {
      complete(null);
    };

    const handleCancelButton = () => {
      complete(null);
    };

    const handleConfirm = () => {
      const name = input.value.trim();
      if (!name) {
        input.focus();
        return;
      }

      complete({
        name,
        color: selectedColor
      });
    };

    const handleEnter = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handleConfirm();
      }
    };

    const handleColorPick = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const button = target.closest("button[data-folder-editor-color]");
      if (!(button instanceof HTMLButtonElement)) {
        return;
      }

      selectedColor = normalizeFolderColor(button.dataset.folderEditorColor);
      renderColorSelection();
    };

    const cleanup = () => {
      dialog.removeEventListener("cancel", handleCancel);
      dialog.removeEventListener("close", handleClose);
      cancelButton.removeEventListener("click", handleCancelButton);
      confirmButton.removeEventListener("click", handleConfirm);
      input.removeEventListener("keydown", handleEnter);
      colorList.removeEventListener("click", handleColorPick);
    };

    dialog.addEventListener("cancel", handleCancel);
    dialog.addEventListener("close", handleClose);
    cancelButton.addEventListener("click", handleCancelButton);
    confirmButton.addEventListener("click", handleConfirm);
    input.addEventListener("keydown", handleEnter);
    colorList.addEventListener("click", handleColorPick);

    if (!dialog.open) {
      dialog.showModal();
    }

    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}

function loadRecentSessionIds() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_SESSION_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveRecentSessionIds() {
  localStorage.setItem(RECENT_SESSION_STORAGE_KEY, JSON.stringify(state.recentSessionIds.slice(0, MAX_RECENT_SESSION_IDS)));
}

function loadLastSessionId() {
  return localStorage.getItem(LAST_SESSION_STORAGE_KEY) ?? "";
}

function saveLastSessionId() {
  if (!state.lastSessionId) {
    localStorage.removeItem(LAST_SESSION_STORAGE_KEY);
    return;
  }

  localStorage.setItem(LAST_SESSION_STORAGE_KEY, state.lastSessionId);
}

function targetLanguages() {
  return elements.targetLanguages.value
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeUiLanguageCode(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/_/g, "-")
    .toLowerCase();

  if (!normalized) {
    return "";
  }

  if (normalized === "auto") {
    return "auto";
  }

  return normalized.split("-")[0];
}

function resolveSelectValue(select, value, fallback = "") {
  const options = Array.from(select.options);
  const requested = String(value ?? "").trim();

  const directMatch = options.find((option) => option.value === requested);
  if (directMatch) {
    return directMatch.value;
  }

  const normalizedRequested = normalizeUiLanguageCode(requested);
  if (normalizedRequested) {
    const normalizedMatch = options.find((option) => normalizeUiLanguageCode(option.value) === normalizedRequested);
    if (normalizedMatch) {
      return normalizedMatch.value;
    }
  }

  if (fallback) {
    return resolveSelectValue(select, fallback);
  }

  return "";
}

function selectHasOption(select, value) {
  return Boolean(resolveSelectValue(select, value));
}

function sessionInsight(sessionId) {
  return state.sessionInsights[String(sessionId ?? "").trim()] ?? {};
}

function updateSessionInsight(sessionId, patch = {}) {
  const id = String(sessionId ?? "").trim();

  if (!id) {
    return;
  }

  const next = {
    ...sessionInsight(id),
    ...patch
  };

  state.sessionInsights = {
    ...state.sessionInsights,
    [id]: next
  };
  saveSessionInsights();
}

function languageCodeLabel(code, options = {}) {
  const normalized = normalizeUiLanguageCode(code);

  if (!normalized) {
    return options.compact ? "--" : "";
  }

  if (normalized === "auto") {
    return options.compact
      ? "AUTO"
      : languageOptionLabel(AUTO_SOURCE_LANGUAGE_OPTION);
  }

  const option = COMMON_LANGUAGE_OPTIONS.find((item) => item.code === normalized);
  if (!option) {
    return options.compact ? normalized.toUpperCase() : normalized;
  }

  return options.compact
    ? option.code.toUpperCase()
    : languageOptionLabel(option);
}

function formatDurationLabel(totalMs) {
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    return "--";
  }

  const totalSeconds = Math.max(1, Math.round(totalMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function durationMsFromSession(session) {
  const startedAt = Date.parse(session?.startedAt ?? "");
  const endedAt = Date.parse(session?.endedAt ?? "");

  if (Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt > startedAt) {
    return endedAt - startedAt;
  }

  return 0;
}

function durationMsFromSegments(segments = []) {
  const ordered = Array.isArray(segments) ? segments : [];
  const start = ordered.reduce((min, segment) => {
    return Number.isFinite(segment?.startMs) ? Math.min(min, segment.startMs) : min;
  }, Number.POSITIVE_INFINITY);
  const end = ordered.reduce((max, segment) => {
    return Number.isFinite(segment?.endMs) ? Math.max(max, segment.endMs) : max;
  }, 0);

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0;
  }

  return end - start;
}

function sessionLanguagePair(session) {
  const insight = sessionInsight(session?.id);
  const sourceLanguage = insight.sourceLanguage
    ?? session?.config?.sourceLanguage
    ?? "auto";
  const targetLanguage = insight.targetLanguage
    ?? session?.config?.targetLanguages?.[0]
    ?? "en";

  return `${languageCodeLabel(sourceLanguage, { compact: true })} -> ${languageCodeLabel(targetLanguage, { compact: true })}`;
}

function currentSessionLatencyMs() {
  return Math.max(
    state.liveLatency.translationE2eMs || 0,
    state.liveLatency.sourceE2eMs || 0,
    preferredLiveLatencyMs()
  );
}

function sessionLatencyChip(session) {
  const insight = sessionInsight(session?.id);
  const latencyMs = insight.latencyMs ?? 0;
  const tone = liveLatencyTone(latencyMs);
  const prefix = state.language === "zh-CN" ? "延迟" : "Latency";

  if (!latencyMs) {
    return {
      tone: "pending",
      label: `${prefix} -`
    };
  }

  const quality = tone === "good"
    ? (state.language === "zh-CN" ? "快" : "Fast")
    : tone === "warn"
      ? (state.language === "zh-CN" ? "中" : "Warm")
      : (state.language === "zh-CN" ? "慢" : "Slow");

  return {
    tone,
    label: `${prefix} ${quality}`
  };
}

function replayKeywordsFromSegments(segments = []) {
  const text = segments
    .map((segment) => String(segment?.text ?? "").trim())
    .filter(Boolean)
    .join(" ");

  if (!text) {
    return [];
  }

  const cjkTokens = text.match(/[\u4e00-\u9fff]{2,6}/g) ?? [];
  const latinTokens = text
    .toLowerCase()
    .match(/[a-z][a-z'-]{2,}/g) ?? [];
  const stopwords = new Set([
    "about", "after", "again", "also", "around", "because", "before", "between", "could",
    "discuss", "from", "have", "just", "meeting", "need", "next", "should", "that",
    "there", "these", "this", "those", "today", "with", "would", "please", "review",
    "summary", "transcript", "translation", "project"
  ]);
  const counts = new Map();

  for (const token of [...cjkTokens, ...latinTokens]) {
    const normalized = token.trim();
    if (!normalized || stopwords.has(normalized)) {
      continue;
    }
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([token]) => token);
}

function firstMeaningfulClause(text) {
  const clauses = String(text ?? "")
    .split(/[\n。！？!?;；,，]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 1);

  return clauses[0] ?? String(text ?? "").trim();
}

function buildSessionTitleSuggestion(replay) {
  const finalSegments = (replay?.segments ?? []).filter((segment) => segment.status === "final");
  const firstText = firstMeaningfulClause(finalSegments[0]?.text ?? "");
  const sourceLanguage = normalizeUiLanguageCode(
    replay?.session?.config?.sourceLanguage
    ?? finalSegments[0]?.sourceLanguage
    ?? ""
  );

  if (!firstText) {
    return "";
  }

  if (sourceLanguage === "zh" || /[\u4e00-\u9fff]/.test(firstText)) {
    return firstText.slice(0, 18);
  }

  const keywords = replayKeywordsFromSegments(finalSegments);
  if (keywords.length > 0) {
    return keywords
      .slice(0, 3)
      .map((token) => token.replace(/\b\w/g, (character) => character.toUpperCase()))
      .join(" / ");
  }

  return firstText
    .split(/\s+/)
    .slice(0, 6)
    .join(" ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function titleLooksGenerated(title, sessionId = "") {
  const value = String(title ?? "").trim();

  if (!value) {
    return true;
  }

  return value === String(sessionId ?? "").trim()
    || /^session\b/i.test(value)
    || /realtime language workspace/i.test(value);
}

function languageOptionLabel(option) {
  return option.labels[state.language] ?? option.labels.en ?? option.code;
}

function renderLanguageSelectors() {
  const sourceSelect = elements.sourceLanguage;
  const targetSelect = elements.targetLanguages;

  if (!(sourceSelect instanceof HTMLSelectElement) || !(targetSelect instanceof HTMLSelectElement)) {
    return;
  }

  const sourceValue = sourceSelect.value || "auto";
  const targetValue = targetSelect.value || "en";

  const buildOptions = (options) => options.map((option) => `
    <option value="${option.code}">${escapeHtml(languageOptionLabel(option))}</option>
  `).join("");

  sourceSelect.innerHTML = buildOptions([AUTO_SOURCE_LANGUAGE_OPTION, ...COMMON_LANGUAGE_OPTIONS]);
  targetSelect.innerHTML = buildOptions(COMMON_LANGUAGE_OPTIONS);

  sourceSelect.value = resolveSelectValue(sourceSelect, sourceValue, "auto") || "auto";
  targetSelect.value = resolveSelectValue(targetSelect, targetValue, "en") || "en";

  renderSourceLanguagePopdown();
  renderTargetLanguagesPopdown();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatBytes(byteLength) {
  if (byteLength < 1024) {
    return `${byteLength} B`;
  }

  if (byteLength < 1024 * 1024) {
    return `${(byteLength / 1024).toFixed(1)} KB`;
  }

  return `${(byteLength / (1024 * 1024)).toFixed(1)} MB`;
}

function updatePerformanceStatus(status) {
  if (elements.performanceStatus) {
    elements.performanceStatus.textContent = status;
  }
}

function setCaptureLevel(level) {
  elements.captureLevelFill.style.width = `${Math.min(100, Math.max(0, Math.round(level * 100)))}%`;
}

function resetCaptureLevel() {
  elements.captureLevelFill.style.width = "0%";
}

function refreshCapturePerformanceStatus(capture = state.capture) {
  if (!capture) {
    updatePerformanceStatus("Capture path: idle");
    return;
  }

  const elapsedMs = Math.max(1, performance.now() - capture.performance.windowStartedAt);
  const uploadsPerSecond = (capture.performance.uploadCount / elapsedMs) * 1000;
  const eventsPerSecond = (capture.performance.eventCount / elapsedMs) * 1000;
  const averageRenderMs = capture.performance.renderCount > 0
    ? capture.performance.renderDurationMs / capture.performance.renderCount
    : 0;
  const queueLabel = capture.queueState && capture.queueState !== "steady"
    ? ` | queue ${capture.queueState}`
    : "";
  const trimmedLabel = state.trimmedLiveData.segments > 0 || state.trimmedLiveData.audioClips > 0
    ? ` | trimmed ${state.trimmedLiveData.segments}/${state.trimmedLiveData.audioClips}`
    : "";
  updatePerformanceStatus(
    `Capture path: ${capture.engine} | upload ${uploadsPerSecond.toFixed(1)}/s | events ${eventsPerSecond.toFixed(1)}/s | render ${averageRenderMs.toFixed(1)}ms | backlog ${capture.pendingChunks.length}${queueLabel}${trimmedLabel}`
  );
}

function setPill(element, text, tone = "ok") {
  if (!element) {
    return;
  }

  element.textContent = text;
  element.classList.toggle("warn", tone === "warn");
}

function setSidebarView(view) {
  state.sidebarView = view;

  if (elements.workspaceShell) {
    elements.workspaceShell.dataset.sidebarView = view;
  }

  elements.navDashboardButton?.classList.toggle("active", view === "dashboard");
  elements.navFoldersButton?.classList.toggle("active", view === "folders");
  elements.sidebarDashboardButton?.classList.toggle("active", view === "dashboard");
  elements.sidebarFoldersButton?.classList.toggle("active", view === "folders");
  elements.sidebarHistoryButton?.classList.toggle("active", view === "history");

  if (view === "history") {
    state.folderFilter = "recent";
  } else if (view === "folders" && state.folderFilter === "recent") {
    state.folderFilter = "projects";
  }

  if (view === "folders" && state.folderSessionFolderFilter === "all" && state.projectFolders.length > 0) {
    state.activeProjectFolderId = state.projectFolders[0].id;
    state.folderSessionFolderFilter = state.projectFolders[0].id;
  }

  renderLibraryPanel();
  renderFolderList();
  renderSessionList();
}

function syncSidebarTooltips() {
  document.querySelectorAll(".menu-link").forEach((button) => {
    const label = button.querySelector(".menu-link-text")?.textContent?.trim();
    if (!label) {
      return;
    }

    button.dataset.tooltip = label;
    button.setAttribute("aria-label", label);
  });

  if (elements.toggleLanguageButton) {
    const label = elements.toggleLanguageLabel?.textContent?.trim() || translate(state.language, "menu.language");
    elements.toggleLanguageButton.dataset.tooltip = label;
    elements.toggleLanguageButton.setAttribute("aria-label", label);
  }

  if (elements.toggleSidebarButton) {
    const label = elements.toggleSidebarButton.querySelector(".sidebar-mini-label")?.textContent?.trim();
    if (label) {
      elements.toggleSidebarButton.dataset.tooltip = label;
      elements.toggleSidebarButton.setAttribute("aria-label", label);
    }
  }
}

function syncSidebarCollapseState() {
  if (elements.workspaceShell) {
    elements.workspaceShell.dataset.sidebarCollapsed = state.sidebarCollapsed ? "true" : "false";
  }

  if (elements.toggleSidebarButton) {
    const label = elements.toggleSidebarButton.querySelector(".sidebar-mini-label");
    if (label) {
      label.textContent = translate(state.language, state.sidebarCollapsed ? "menu.expand" : "menu.collapse");
    }
  }

  syncSidebarTooltips();
}

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  syncSidebarCollapseState();
}

function setCaptureButtonState(isCapturing) {
  const startDisabled = Boolean(isCapturing) || state.isEndingRecordingFlow;
  const stopDisabled = !isCapturing || state.isEndingRecordingFlow;

  if (elements.startCaptureButton) {
    elements.startCaptureButton.disabled = startDisabled;
  }

  if (elements.startCaptureButtonDuplicate) {
    elements.startCaptureButtonDuplicate.disabled = startDisabled;
  }

  if (elements.heroStartCaptureButton) {
    elements.heroStartCaptureButton.disabled = startDisabled;
  }

  if (elements.stopCaptureButton) {
    elements.stopCaptureButton.disabled = stopDisabled;
  }

  if (elements.stopCaptureButtonDuplicate) {
    elements.stopCaptureButtonDuplicate.disabled = stopDisabled;
  }

  syncPauseButton();
}

function formatRecordingDuration(totalMs) {
  const totalSeconds = Math.max(0, Math.floor(totalMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function captureElapsedMs(capture = state.capture) {
  if (!capture?.startedAt) {
    return 0;
  }

  const endPoint = capture.pauseStartedAt ?? performance.now();
  return Math.max(0, endPoint - capture.startedAt - (capture.pausedDurationMs ?? 0));
}

function updateRecordingTimer() {
  const label = formatRecordingDuration(captureElapsedMs());

  if (elements.recordingTimerLive) {
    elements.recordingTimerLive.textContent = label;
  }
}

function syncPauseButton() {
  if (!elements.pauseCaptureButtonLive) {
    return;
  }

  if (!state.capture) {
    elements.pauseCaptureButtonLive.disabled = true;
    elements.pauseCaptureButtonLive.textContent = translate(state.language, "button.pauseCapture");
    return;
  }

  elements.pauseCaptureButtonLive.disabled = state.isEndingRecordingFlow;
  elements.pauseCaptureButtonLive.textContent = state.capture.isPaused
    ? translate(state.language, "button.resumeCapture")
    : translate(state.language, "button.pauseCapture");
}

function stopSpeechDraftTimers() {
  if (state.currentSpeechDraft.sourceTimerId) {
    window.clearInterval(state.currentSpeechDraft.sourceTimerId);
    state.currentSpeechDraft.sourceTimerId = null;
  }

  if (state.currentSpeechDraft.translationTimerId) {
    window.clearInterval(state.currentSpeechDraft.translationTimerId);
    state.currentSpeechDraft.translationTimerId = null;
  }
}

function smoothMetric(previousValue, nextValue, alpha = 0.35) {
  if (!Number.isFinite(nextValue) || nextValue < 0) {
    return previousValue;
  }

  if (!Number.isFinite(previousValue) || previousValue <= 0) {
    return nextValue;
  }

  return previousValue * (1 - alpha) + nextValue * alpha;
}

function formatMetricMs(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "-";
  }

  return `${Math.round(value)}ms`;
}

function preferredLiveLatencyMs() {
  if (Number.isFinite(state.liveLatency.translationE2eMs) && state.liveLatency.translationE2eMs > 0) {
    return state.liveLatency.translationE2eMs;
  }

  if (Number.isFinite(state.liveLatency.sourceE2eMs) && state.liveLatency.sourceE2eMs > 0) {
    return state.liveLatency.sourceE2eMs;
  }

  return 0;
}

function liveLatencyTone(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "neutral";
  }

  if (value < 1500) {
    return "good";
  }

  if (value < 3000) {
    return "warn";
  }

  return "bad";
}

function updateLiveLatencyBadge() {
  if (!elements.liveLatencyBadge) {
    return;
  }

  const latencyMs = preferredLiveLatencyMs();
  const formatted = formatMetricMs(latencyMs);
  const tone = liveLatencyTone(latencyMs);

  elements.liveLatencyBadge.dataset.tone = tone;
  elements.liveLatencyBadge.textContent = formatted === "-"
    ? translate(state.language, "live.latencyPending")
    : formatted;
  elements.liveLatencyBadge.title = elements.liveLatencyBadge.textContent;
}

function animateSpeechLine(element, timerKey, stateKey, nextText) {
  const currentText = state.currentSpeechDraft[stateKey] ?? "";

  if (!element) {
    return;
  }

  if (currentText === nextText) {
    element.textContent = currentText;
    element.classList.toggle("current-speech-caret", Boolean(nextText));
    return;
  }

  if (state.currentSpeechDraft[timerKey]) {
    window.clearInterval(state.currentSpeechDraft[timerKey]);
    state.currentSpeechDraft[timerKey] = null;
  }

  const commonPrefixLength = (() => {
    const maxLength = Math.min(currentText.length, nextText.length);
    let index = 0;
    while (index < maxLength && currentText[index] === nextText[index]) {
      index += 1;
    }
    return index;
  })();

  if (nextText.length === 0) {
    state.currentSpeechDraft[stateKey] = "";
    element.textContent = "";
    element.classList.remove("current-speech-caret");
    return;
  }

  state.currentSpeechDraft[stateKey] = nextText.slice(0, commonPrefixLength);
  element.textContent = state.currentSpeechDraft[stateKey];

  const paint = () => {
    const draft = state.currentSpeechDraft[stateKey] ?? "";

    if (draft.length >= nextText.length) {
      element.textContent = nextText;
      state.currentSpeechDraft[stateKey] = nextText;
      element.classList.toggle("current-speech-caret", Boolean(nextText));
      if (state.currentSpeechDraft[timerKey]) {
        window.clearInterval(state.currentSpeechDraft[timerKey]);
        state.currentSpeechDraft[timerKey] = null;
      }
      return;
    }

    const remainingLength = nextText.length - draft.length;
    const acceleratedStep = Math.max(1, Math.ceil(remainingLength / 6));
    const nextDraft = nextText.slice(0, draft.length + acceleratedStep);
    state.currentSpeechDraft[stateKey] = nextDraft;
    element.textContent = nextDraft;
    element.classList.toggle("current-speech-caret", Boolean(nextDraft));
  };

  paint();
  state.currentSpeechDraft[timerKey] = window.setInterval(paint, 16);
}

function syncRecordingLanguageChips() {
  if (elements.recordingSourceLanguage) {
    elements.recordingSourceLanguage.textContent = elements.sourceLanguage?.value.trim() || "zh";
  }

  if (elements.recordingTargetLanguage) {
    elements.recordingTargetLanguage.textContent = targetLanguages().join(", ") || "en";
  }
}

function syncLanguageButton() {
  if (!elements.toggleLanguageLabel) {
    return;
  }

  const current = languages.find((item) => item.code === state.language);
  elements.toggleLanguageLabel.textContent = current?.label ?? state.language;
  syncSidebarTooltips();
}

function toggleLanguage() {
  const nextLanguage = state.language === "en" ? "zh-CN" : "en";

  if (elements.languageSelect) {
    elements.languageSelect.value = nextLanguage;
  }

  setStoredLanguage(nextLanguage);
  applyLanguage(nextLanguage);
}

async function refreshDevicesWithAnimation() {
  const button = elements.refreshDevicesButtonDuplicate;
  setPopdownOpen("microphone", false);

  if (button) {
    button.classList.add("is-refreshing");
    button.disabled = true;
  }

  try {
    await refreshDevices();
  } finally {
    if (button) {
      button.classList.remove("is-refreshing");
      button.disabled = false;
    }
  }
}

function startRecordingTimer() {
  stopRecordingTimer();
  updateRecordingTimer();
  state.captureTimerIntervalId = window.setInterval(updateRecordingTimer, 1000);
}

function stopRecordingTimer() {
  if (state.captureTimerIntervalId) {
    window.clearInterval(state.captureTimerIntervalId);
    state.captureTimerIntervalId = null;
  }
  updateRecordingTimer();
  syncPauseButton();
}

async function togglePauseCapture() {
  if (!state.capture || state.isEndingRecordingFlow) {
    return;
  }

  if (state.capture.isPaused) {
    state.capture.pausedDurationMs += performance.now() - (state.capture.pauseStartedAt ?? performance.now());
    state.capture.pauseStartedAt = null;
    state.capture.isPaused = false;
    await state.capture.audioContext.resume();
    setPill(elements.captureStatus, translate(state.language, "capture.active"));
  } else {
    state.capture.pauseStartedAt = performance.now();
    state.capture.isPaused = true;
    await state.capture.audioContext.suspend();
    setPill(elements.captureStatus, translate(state.language, "capture.paused"));
  }

  updateRecordingTimer();
  syncPauseButton();
}

function syncSessionActionButtons() {
  const hasSessionId = Boolean(elements.sessionId?.value.trim());
  const buttons = [
    elements.connectButton,
    elements.loadReplayButton
  ];

  for (const button of buttons) {
    if (button) {
      button.disabled = !hasSessionId || state.isEndingRecordingFlow;
    }
  }

  const stopButtons = [
    elements.stopButton,
    elements.stopButtonInline,
    elements.stopButtonDuplicate
  ];

  for (const button of stopButtons) {
    if (button) {
      button.disabled = !hasSessionId || state.isEndingRecordingFlow;
    }
  }
}

function projectFolders() {
  return state.projectFolders;
}

function activeProjectFolder() {
  return state.projectFolders.find((folder) => folder.id === state.activeProjectFolderId) ?? state.projectFolders[0] ?? null;
}

function createProjectFolderId() {
  return `folder-${Math.random().toString(36).slice(2, 10)}`;
}

function nextFolderColor() {
  const index = state.projectFolders.length % FOLDER_COLOR_PALETTE.length;
  return FOLDER_COLOR_PALETTE[index];
}

function folderAccentColor(folder) {
  return normalizeFolderColor(folder?.color ?? FOLDER_COLOR_PALETTE[0]);
}

function createProjectFolderWithName(rawName, options = {}) {
  const name = rawName?.trim();

  if (!name) {
    return null;
  }

  const nextFolder = {
    id: createProjectFolderId(),
    label: name,
    description: "Custom project folder",
    favorite: false,
    color: normalizeFolderColor(options.color ?? nextFolderColor())
  };

  state.projectFolders = [nextFolder, ...state.projectFolders];
  state.activeProjectFolderId = nextFolder.id;
  state.folderFilter = "projects";
  state.folderSessionFolderFilter = nextFolder.id;
  saveProjectFolders();
  return nextFolder;
}

async function createProjectFolder() {
  const snapshot = {
    folders: state.projectFolders.map((folder) => ({ ...folder })),
    activeFolderId: state.activeProjectFolderId,
    sessionFilter: state.folderSessionFolderFilter
  };
  const payload = await openFolderEditorDialog({
    mode: "create"
  });

  if (!payload) {
    return null;
  }

  const nextFolder = createProjectFolderWithName(payload.name, {
    color: payload.color
  });
  if (!nextFolder) {
    return null;
  }

  renderFolderList();
  renderSessionList();
  showUndoToast(
    state.language === "zh-CN" ? "已新建文件夹，可撤销。" : "Folder created. Undo available.",
    () => {
      state.projectFolders = snapshot.folders;
      state.activeProjectFolderId = snapshot.activeFolderId;
      state.folderSessionFolderFilter = snapshot.sessionFilter;
      saveProjectFolders();
      renderFolderList();
      renderSessionList();
    }
  );
  return nextFolder;
}

async function renameProjectFolder(folderId) {
  const folder = state.projectFolders.find((item) => item.id === folderId);

  if (!folder) {
    return false;
  }

  const payload = await openFolderEditorDialog({
    mode: "rename",
    initialName: folder.label,
    initialColor: folder.color
  });

  if (!payload) {
    return false;
  }

  const previousFolder = { ...folder };
  state.projectFolders = state.projectFolders.map((item) => {
    if (item.id !== folderId) {
      return item;
    }
    return {
      ...item,
      label: payload.name,
      color: normalizeFolderColor(payload.color)
    };
  });
  saveProjectFolders();
  renderFolderList();
  renderSessionList();
  showUndoToast(
    state.language === "zh-CN" ? "已更新文件夹，可撤销。" : "Folder updated. Undo available.",
    () => {
      state.projectFolders = state.projectFolders.map((item) => item.id === folderId ? { ...previousFolder } : item);
      saveProjectFolders();
      renderFolderList();
      renderSessionList();
    }
  );
  return true;
}

function updateProjectFolderColor(folderId, nextColor) {
  const previousFolder = state.projectFolders.find((item) => item.id === folderId);
  if (!previousFolder) {
    return;
  }

  const color = normalizeFolderColor(nextColor);
  if (previousFolder.color === color) {
    return;
  }

  state.projectFolders = state.projectFolders.map((item) => item.id === folderId ? { ...item, color } : item);
  saveProjectFolders();
  renderFolderList();
  renderSessionList();
  showUndoToast(
    state.language === "zh-CN" ? "已更新配色，可撤销。" : "Color updated. Undo available.",
    () => {
      state.projectFolders = state.projectFolders.map((item) => item.id === folderId ? { ...item, color: previousFolder.color } : item);
      saveProjectFolders();
      renderFolderList();
      renderSessionList();
    }
  );
}

function deleteProjectFolder(folderId) {
  const folder = state.projectFolders.find((item) => item.id === folderId);
  if (!folder) {
    return;
  }

  const snapshot = {
    folders: state.projectFolders.map((item) => ({ ...item })),
    assignments: { ...state.folderAssignments },
    activeFolderId: state.activeProjectFolderId,
    sessionFilter: state.folderSessionFolderFilter
  };

  state.projectFolders = state.projectFolders.filter((item) => item.id !== folderId);
  for (const [sessionId, assignedFolderId] of Object.entries(state.folderAssignments)) {
    if (assignedFolderId === folderId) {
      delete state.folderAssignments[sessionId];
    }
  }

  const nextActiveFolder = state.projectFolders[0]?.id ?? "";
  state.activeProjectFolderId = nextActiveFolder;

  if (state.folderSessionFolderFilter === folderId) {
    state.folderSessionFolderFilter = nextActiveFolder || "all";
  }

  saveFolderAssignments();
  saveProjectFolders();
  renderFolderList();
  renderSessionList();
  showUndoToast(
    state.language === "zh-CN" ? "文件夹已删除，可撤销。" : "Folder deleted. Undo available.",
    () => {
      state.projectFolders = snapshot.folders.map((item) => ({ ...item }));
      state.folderAssignments = { ...snapshot.assignments };
      state.activeProjectFolderId = snapshot.activeFolderId;
      state.folderSessionFolderFilter = snapshot.sessionFilter;
      saveFolderAssignments();
      saveProjectFolders();
      renderFolderList();
      renderSessionList();
    }
  );
}

function folderSessionCount(folderId) {
  return state.sessions.filter((session) => state.folderAssignments[session.id] === folderId).length;
}

function assignSessionToFolder(sessionId, folderId) {
  if (!sessionId || !folderId) {
    return;
  }

  state.folderAssignments[sessionId] = folderId;
  saveFolderAssignments();
}

async function requestCaptureFolderSelection() {
  const defaultFolderId = activeProjectFolder()?.id ?? state.projectFolders[0]?.id ?? "";

  const dialog = elements.captureFolderDialog;

  if (!dialog || typeof dialog.showModal !== "function") {
    if (!defaultFolderId) {
      const created = await createProjectFolder();
      return created?.id ?? null;
    }

    state.activeProjectFolderId = defaultFolderId;
    state.folderFilter = "projects";
    state.folderSessionFolderFilter = defaultFolderId;
    return defaultFolderId;
  }

  let selectedFolderId = defaultFolderId || state.projectFolders[0]?.id || "";

  const renderOptions = () => {
    if (!elements.captureFolderList) {
      return;
    }

    elements.captureFolderList.innerHTML = state.projectFolders.map((folder) => {
      const active = folder.id === selectedFolderId;
      return `
        <button class="folder-picker-option ${active ? "active" : ""}" data-capture-folder-id="${folder.id}" type="button">
          <span class="folder-picker-option-title">${escapeHtml(folderLabel(folder))}</span>
          <span class="folder-picker-option-meta">${escapeHtml(String(folderSessionCount(folder.id)))} ${escapeHtml(translate(state.language, "sidebar.sessionsUnit"))}</span>
        </button>
      `;
    }).join("");

    elements.captureFolderList.querySelectorAll("button[data-capture-folder-id]").forEach((button) => {
      button.addEventListener("click", () => {
        selectedFolderId = button.dataset.captureFolderId;
        renderOptions();
      });
    });
  };

  renderOptions();
  if (elements.captureFolderNameInput) {
    elements.captureFolderNameInput.value = "";
  }

  return new Promise((resolve) => {
    const complete = (folderId) => {
      cleanup();
      if (dialog.open) {
        dialog.close();
      }
      resolve(folderId ?? null);
    };

    const handleCancel = (event) => {
      event.preventDefault();
      complete(null);
    };

    const handleDialogClose = () => {
      complete(null);
    };

    const handleCancelButton = () => {
      complete(null);
    };

    const handleConfirm = () => {
      if (!selectedFolderId) {
        return;
      }
      state.activeProjectFolderId = selectedFolderId;
      state.folderFilter = "projects";
      state.folderSessionFolderFilter = selectedFolderId;
      complete(selectedFolderId);
    };

    const handleCreate = () => {
      const nextFolder = createProjectFolderWithName(elements.captureFolderNameInput?.value ?? "");
      if (!nextFolder) {
        elements.captureFolderNameInput?.focus();
        return;
      }

      selectedFolderId = nextFolder.id;
      if (elements.captureFolderNameInput) {
        elements.captureFolderNameInput.value = "";
      }
      renderOptions();
      renderFolderList();
      renderSessionList();
    };

    const handleNameInputEnter = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handleCreate();
      }
    };

    const cleanup = () => {
      dialog.removeEventListener("cancel", handleCancel);
      dialog.removeEventListener("close", handleDialogClose);
      elements.captureFolderCancelButton?.removeEventListener("click", handleCancelButton);
      elements.captureFolderConfirmButton?.removeEventListener("click", handleConfirm);
      elements.captureFolderCreateButton?.removeEventListener("click", handleCreate);
      elements.captureFolderNameInput?.removeEventListener("keydown", handleNameInputEnter);
    };

    dialog.addEventListener("cancel", handleCancel);
    dialog.addEventListener("close", handleDialogClose);
    elements.captureFolderCancelButton?.addEventListener("click", handleCancelButton);
    elements.captureFolderConfirmButton?.addEventListener("click", handleConfirm);
    elements.captureFolderCreateButton?.addEventListener("click", handleCreate);
    elements.captureFolderNameInput?.addEventListener("keydown", handleNameInputEnter);

    if (!dialog.open) {
      dialog.showModal();
    }
  });
}

function rememberRecentSession(sessionId) {
  if (!sessionId) {
    return;
  }

  state.lastSessionId = sessionId;
  state.recentSessionIds = [sessionId, ...state.recentSessionIds.filter((id) => id !== sessionId)]
    .slice(0, MAX_RECENT_SESSION_IDS);
  saveLastSessionId();
  saveRecentSessionIds();
  renderResumeState();
  renderFolderList();
  renderSessionList();
}

function resolveLastSession() {
  return state.sessions.find((session) => session.id === state.lastSessionId) ?? null;
}

function formatSessionStamp(session) {
  const stamp = session?.updatedAt ?? session?.lastEventAt ?? session?.createdAt;

  if (!stamp) {
    return "No session history yet";
  }

  try {
    return new Intl.DateTimeFormat(state.language === "zh-CN" ? "zh-CN" : "en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(stamp));
  } catch {
    return stamp;
  }
}

function renderResumeState() {
  const lastSession = resolveLastSession();
  const buttons = [
    elements.resumeLiveSessionButton,
    elements.resumeReplaySessionButton,
    elements.resumeLiveSessionButtonHero,
    elements.resumeReplaySessionButtonHero,
    elements.resumeLiveSessionButtonLive,
    elements.resumeReplaySessionButtonLive
  ];
  const hasSession = Boolean(lastSession);

  if (elements.lastSessionTitle) {
    elements.lastSessionTitle.textContent = hasSession ? lastSession.title : "No recent session";
  }

  if (elements.lastSessionMeta) {
    elements.lastSessionMeta.textContent = hasSession
      ? `${lastSession.status} - ${formatSessionStamp(lastSession)} - ${lastSession.segmentCount ?? 0} segments`
      : "After the first session, this card keeps a fast path back into live mode or replay mode.";
  }

  for (const button of buttons) {
    if (button) {
      button.disabled = !hasSession;
    }
  }
}

function renderLibraryPanel() {
  if (state.sidebarView === "history") {
    if (elements.sessionListTitle) {
      elements.sessionListTitle.textContent = state.language === "zh-CN" ? "会话历史" : "Session history";
    }
    if (elements.sessionListBadge) {
      elements.sessionListBadge.textContent = state.language === "zh-CN" ? "最近" : "Recent";
    }
    if (elements.folderList) {
      elements.folderList.style.display = "none";
    }
    return;
  }

  if (elements.sessionListTitle) {
    elements.sessionListTitle.textContent = state.language === "zh-CN" ? "转译列表" : "Translation list";
  }
  if (elements.sessionListBadge) {
    elements.sessionListBadge.textContent = state.language === "zh-CN" ? "倒序" : "Recent first";
  }
  if (elements.folderList) {
    elements.folderList.style.display = "";
  }
}

async function resumeLastSessionReplay() {
  const lastSession = resolveLastSession();

  if (!lastSession) {
    return;
  }

  elements.sessionId.value = lastSession.id;
  syncSessionActionButtons();
  state.sidebarView = "dashboard";
  setSidebarView("dashboard");
  await loadReplay();
}

async function resumeLastSessionLive() {
  const lastSession = resolveLastSession();

  if (!lastSession) {
    return;
  }

  elements.sessionId.value = lastSession.id;
  syncSessionActionButtons();
  state.sidebarView = "dashboard";
  setSidebarView("dashboard");
  await loadReplay();
  connectStream();
}

function appendEvent(title, payload) {
  if (!elements.eventLog || HIDDEN_EVENT_TITLES.has(title)) {
    return;
  }

  const item = document.createElement("div");
  item.className = "event";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(payload, null, 2);
  item.append(heading, pre);
  elements.eventLog.prepend(item);

  while (elements.eventLog.childElementCount > MAX_EVENT_LOG_ITEMS) {
    elements.eventLog.lastElementChild?.remove();
  }
}

function syncWorkspaceLayout() {
  if (!elements.workspaceShell) {
    return;
  }

  if (state.isEndingRecordingFlow) {
    elements.workspaceShell.dataset.layout = "idle";
    return;
  }

  if (state.sidebarView !== "dashboard" && !state.capture) {
    elements.workspaceShell.dataset.layout = "idle";
    return;
  }

  const hasLiveArtifacts = state.sourceSegments.size > 0
    || state.translations.size > 0
    || state.audioClips.size > 0
    || Boolean(state.capture);
  elements.workspaceShell.dataset.layout = state.workspaceMode === "live" || hasLiveArtifacts ? "live" : "idle";
}

function enterLiveWorkspace() {
  state.workspaceMode = "live";
  syncWorkspaceLayout();
}

function syncWorkspaceModeWithData() {
  if (!state.capture && state.sourceSegments.size === 0 && state.translations.size === 0 && state.audioClips.size === 0) {
    state.workspaceMode = "idle";
  }

  syncWorkspaceLayout();
}

function markCollectionsDirty() {
  state.collectionsDirty = true;
}

function ensureOrderedCollections() {
  if (!state.collectionsDirty) {
    return;
  }

  state.orderedSourceSegmentsCache = Array.from(state.sourceSegments.values()).sort((left, right) => left.sequence - right.sequence);
  state.orderedTranslationsCache = Array.from(state.translations.values()).sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }

    return (left.targetLanguage ?? "").localeCompare(right.targetLanguage ?? "");
  });
  state.orderedAudioClipsCache = Array.from(state.audioClips.values()).sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }

    return left.createdAt.localeCompare(right.createdAt);
  });
  state.collectionsDirty = false;
}

function scheduleWorkspaceRender(flags = {}) {
  state.pendingRender.transcripts ||= Boolean(flags.transcripts);
  state.pendingRender.summary ||= Boolean(flags.summary);
  state.pendingRender.audio ||= Boolean(flags.audio);
  state.pendingRender.overlay ||= Boolean(flags.overlay);

  if (state.renderFrameId) {
    return;
  }

  state.renderFrameId = window.requestAnimationFrame(() => {
    const renderStartedAt = performance.now();
    const pending = state.pendingRender;
    state.pendingRender = {
      transcripts: false,
      summary: false,
      audio: false,
      overlay: false
    };
    state.renderFrameId = null;

    if (pending.transcripts) {
      renderTranscriptViews();
    }

    if (pending.summary) {
      renderSummary();
    }

    if (pending.audio) {
      renderAudioClips();
    }

    if (pending.overlay) {
      publishOverlayState();
    }

    if (state.capture) {
      const renderDuration = performance.now() - renderStartedAt;
      state.capture.performance.renderCount += 1;
      state.capture.performance.renderDurationMs += renderDuration;
      refreshCapturePerformanceStatus(state.capture);
    }

    syncWorkspaceLayout();
  });
}

function resetReplayState() {
  if (state.renderFrameId) {
    window.cancelAnimationFrame(state.renderFrameId);
    state.renderFrameId = null;
    state.pendingRender = {
      transcripts: false,
      summary: false,
      audio: false,
      overlay: false
    };
  }

  state.sourceSegments.clear();
  state.translations.clear();
  state.audioClips.clear();
  state.primaryTranslations.clear();
  stopSpeechDraftTimers();
  state.currentSpeechDraft.sourceText = "";
  state.currentSpeechDraft.translationText = "";
  state.liveNow.sourceText = "";
  state.liveNow.translationText = "";
  state.liveNow.sourceEventPerfAt = 0;
  state.liveNow.translationEventPerfAt = 0;
  state.liveNow.sourceEventEpochMs = 0;
  state.liveNow.translationEventEpochMs = 0;
  state.liveLatency.sourceLocalMs = 0;
  state.liveLatency.translationLocalMs = 0;
  state.liveLatency.sourceE2eMs = 0;
  state.liveLatency.translationE2eMs = 0;
  state.liveLatency.sourceUpdatedAt = 0;
  state.liveLatency.translationUpdatedAt = 0;
  state.trimmedLiveData = {
    segments: 0,
    audioClips: 0
  };
  state.replaySearchQuery = "";
  state.replayFocusedSequence = 0;
  markCollectionsDirty();
  renderTranscriptViews();
  renderSummary();
  renderAudioClips();
  renderReplayInspector();
  syncWorkspaceModeWithData();
  updateLiveLatencyBadge();
  publishOverlayState();
}

function orderedSourceSegments() {
  ensureOrderedCollections();
  return state.orderedSourceSegmentsCache;
}

function orderedTranslations() {
  ensureOrderedCollections();
  return state.orderedTranslationsCache;
}

function orderedAudioClips() {
  ensureOrderedCollections();
  return state.orderedAudioClipsCache;
}

function translationBySegmentId(segmentId) {
  return state.primaryTranslations.get(segmentId);
}

function rebuildPrimaryTranslations() {
  state.primaryTranslations.clear();

  for (const translation of orderedTranslations()) {
    syncPrimaryTranslation(translation);
  }
}

function syncPrimaryTranslation(translation) {
  const existing = state.primaryTranslations.get(translation.segmentId);
  const preferredTargetLanguage = normalizeUiLanguageCode(targetLanguages()[0] ?? "");
  const translationTargetLanguage = normalizeUiLanguageCode(translation.targetLanguage);
  const existingTargetLanguage = normalizeUiLanguageCode(existing?.targetLanguage);

  if (!existing) {
    state.primaryTranslations.set(translation.segmentId, translation);
    return;
  }

  if (translationTargetLanguage && translationTargetLanguage === preferredTargetLanguage) {
    state.primaryTranslations.set(translation.segmentId, translation);
    return;
  }

  if (existingTargetLanguage !== preferredTargetLanguage && translation.isFinal && !existing.isFinal) {
    state.primaryTranslations.set(translation.segmentId, translation);
  }
}

function applySessionConfiguration(session) {
  if (!session || typeof session !== "object") {
    return;
  }

  if (elements.sessionTitle && typeof session.title === "string" && session.title.trim()) {
    elements.sessionTitle.value = session.title.trim();
  }

  const nextSourceLanguage = String(session.config?.sourceLanguage ?? "").trim();
  if (elements.sourceLanguage instanceof HTMLSelectElement && nextSourceLanguage && selectHasOption(elements.sourceLanguage, nextSourceLanguage)) {
    elements.sourceLanguage.value = resolveSelectValue(elements.sourceLanguage, nextSourceLanguage, "auto") || "auto";
  }

  const nextTargetLanguage = String(session.config?.targetLanguages?.[0] ?? "").trim();
  if (elements.targetLanguages instanceof HTMLSelectElement && nextTargetLanguage && selectHasOption(elements.targetLanguages, nextTargetLanguage)) {
    elements.targetLanguages.value = resolveSelectValue(elements.targetLanguages, nextTargetLanguage, "en") || "en";
  }

  renderSourceLanguagePopdown();
  renderTargetLanguagesPopdown();
  syncRecordingLanguageChips();
}

function currentReplaySnapshot(sessionId = elements.sessionId?.value.trim()) {
  const fallbackSession = sessionById(sessionId);

  return {
    session: {
      ...(fallbackSession ?? {}),
      id: sessionId,
      title: elements.sessionTitle?.value?.trim() || fallbackSession?.title || sessionId,
      config: {
        ...(fallbackSession?.config ?? {}),
        sourceLanguage: elements.sourceLanguage?.value?.trim() || fallbackSession?.config?.sourceLanguage || "auto",
        targetLanguages: targetLanguages()
      }
    },
    segments: orderedSourceSegments().map((segment) => ({ ...segment })),
    translations: orderedTranslations().map((translation) => ({ ...translation })),
    audioClips: orderedAudioClips().map((clip) => ({ ...clip })),
    summary: null
  };
}

function syncSessionInsightFromReplay(sessionId, replay, options = {}) {
  const derivedDurationMs = durationMsFromSegments(replay?.segments) || durationMsFromSession(replay?.session);
  const durationMs = options.durationMs ?? derivedDurationMs;
  const sourceLanguage = replay?.session?.config?.sourceLanguage
    ?? replay?.segments?.[0]?.sourceLanguage
    ?? sessionInsight(sessionId).sourceLanguage
    ?? "auto";
  const targetLanguage = replay?.session?.config?.targetLanguages?.[0]
    ?? replay?.translations?.[0]?.targetLanguage
    ?? sessionInsight(sessionId).targetLanguage
    ?? "en";
  const latencyMs = options.latencyMs
    ?? sessionInsight(sessionId).latencyMs
    ?? 0;

  updateSessionInsight(sessionId, {
    durationMs,
    sourceLanguage,
    targetLanguage,
    latencyMs,
    updatedAt: new Date().toISOString()
  });
}

function inferAudioFormatFromMimeType(mimeType) {
  const normalized = String(mimeType ?? "").toLowerCase();

  if (normalized.includes("wav")) {
    return "wav";
  }

  if (normalized.includes("webm")) {
    return "webm";
  }

  if (normalized.includes("ogg")) {
    return "ogg";
  }

  if (normalized.includes("mpeg")) {
    return "mp3";
  }

  return "audio";
}

function inferAudioMimeTypeFromFile(file) {
  const explicitType = String(file?.type ?? "").trim();

  if (explicitType) {
    return explicitType;
  }

  const fileName = String(file?.name ?? "").toLowerCase();

  if (fileName.endsWith(".wav")) {
    return "audio/wav";
  }

  if (fileName.endsWith(".webm")) {
    return "audio/webm";
  }

  if (fileName.endsWith(".ogg")) {
    return "audio/ogg";
  }

  if (fileName.endsWith(".mp3")) {
    return "audio/mpeg";
  }

  return "application/octet-stream";
}

function audioClipDisplayLabel(clip) {
  if (clip?.targetLanguage === "source") {
    return state.language === "zh-CN" ? "原音频" : "Original";
  }

  return clip?.targetLanguage ?? "audio";
}

function encodeWavFromPcm(pcmBytes, options = {}) {
  const bytes = pcmBytes instanceof Uint8Array ? pcmBytes : new Uint8Array(0);
  const sampleRateHz = Number(options.sampleRateHz ?? PCM_SAMPLE_RATE_HZ);
  const channels = Number(options.channels ?? PCM_CHANNEL_COUNT);
  const bitsPerSample = 16;
  const byteRate = sampleRateHz * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + bytes.length);
  const view = new DataView(buffer);
  const writeAscii = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + bytes.length, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, bytes.length, true);
  new Uint8Array(buffer, 44).set(bytes);

  return new Uint8Array(buffer);
}

function bytesToBase64(bytes) {
  let binary = "";

  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }

  return window.btoa(binary);
}

async function persistOriginalAudioClip(sessionId, bytes, options = {}) {
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);

  if (!sessionId || body.length === 0) {
    return null;
  }

  const mimeType = options.mimeType || "audio/wav";
  const response = await fetch(`${elements.apiBaseUrl.value}/sessions/${sessionId}/audio-clips`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      sequence: options.sequence ?? 0,
      targetLanguage: "source",
      provider: options.provider ?? "desktop-original-audio",
      format: options.format ?? inferAudioFormatFromMimeType(mimeType),
      mimeType,
      byteLength: body.length,
      dataBase64: bytesToBase64(body),
      createdAt: options.createdAt ?? new Date().toISOString()
    })
  });
  const clip = await response.json();

  if (!response.ok) {
    throw new Error(clip.detail ?? "Unable to persist original audio.");
  }

  state.audioClips.set(clip.audioClipId, clip);
  markCollectionsDirty();
  renderAudioClips();
  if (state.previewSessionId === sessionId) {
    const replay = state.previewReplayCache.get(sessionId);
    if (replay) {
      replay.audioClips = [clip, ...(replay.audioClips ?? []).filter((item) => item.audioClipId !== clip.audioClipId)];
    }
    renderSessionPreviewDrawer();
  }

  return clip;
}

async function persistSessionTitle(sessionId, title) {
  const response = await fetch(`${elements.apiBaseUrl.value}/sessions/${sessionId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title
    })
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.detail ?? "Unable to update session title.");
  }

  if (elements.sessionId.value.trim() === sessionId && elements.sessionTitle) {
    elements.sessionTitle.value = payload.title ?? title;
  }

  await loadSessions();
  return payload;
}

async function requestSessionTitleDialog(options = {}) {
  const normalizedSuggestion = String(options.initialValue ?? "").trim();

  if (!normalizedSuggestion) {
    return null;
  }

  if (!(elements.sessionTitleSuggestionDialog instanceof HTMLDialogElement)
    || !(elements.sessionTitleSuggestionInput instanceof HTMLInputElement)
    || !(elements.sessionTitleSuggestionConfirmButton instanceof HTMLButtonElement)
    || !(elements.sessionTitleSuggestionCancelButton instanceof HTMLButtonElement)) {
    return window.prompt(
      translate(state.language, "session.renamePrompt"),
      normalizedSuggestion
    )?.trim() ?? null;
  }

  const dialog = elements.sessionTitleSuggestionDialog;
  const input = elements.sessionTitleSuggestionInput;
  const confirmButton = elements.sessionTitleSuggestionConfirmButton;
  const cancelButton = elements.sessionTitleSuggestionCancelButton;
  const titleElement = elements.sessionTitleSuggestionTitle;
  const titleText = options.title ?? translate(state.language, "session.actionRename");
  const descriptionText = options.description ?? "";
  const confirmText = options.confirmText ?? (state.language === "zh-CN" ? "保存" : "Save");
  const cancelText = options.cancelText ?? (state.language === "zh-CN" ? "取消" : "Cancel");

  if (titleElement) {
    titleElement.textContent = titleText;
  }

  if (elements.sessionTitleSuggestionDescription) {
    elements.sessionTitleSuggestionDescription.textContent = descriptionText;
  }

  confirmButton.textContent = confirmText;
  cancelButton.textContent = cancelText;

  input.value = normalizedSuggestion;

  return new Promise((resolve) => {
    const complete = (value) => {
      cleanup();
      if (dialog.open) {
        dialog.close();
      }
      resolve(value);
    };

    const handleCancel = (event) => {
      event.preventDefault();
      complete(null);
    };

    const handleDialogClose = () => {
      complete(null);
    };

    const handleConfirm = () => {
      const nextTitle = input.value.trim();
      complete(nextTitle || null);
    };

    const handleEnter = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handleConfirm();
      }
    };

    const cleanup = () => {
      dialog.removeEventListener("cancel", handleCancel);
      dialog.removeEventListener("close", handleDialogClose);
      confirmButton.removeEventListener("click", handleConfirm);
      cancelButton.removeEventListener("click", handleCancel);
      input.removeEventListener("keydown", handleEnter);
    };

    dialog.addEventListener("cancel", handleCancel);
    dialog.addEventListener("close", handleDialogClose);
    confirmButton.addEventListener("click", handleConfirm);
    cancelButton.addEventListener("click", handleCancel);
    input.addEventListener("keydown", handleEnter);

    dialog.showModal();
    input.focus();
    input.select();
  });
}

async function requestSessionTitleSuggestion(currentTitle, suggestedTitle) {
  return requestSessionTitleDialog({
    initialValue: suggestedTitle,
    title: translate(state.language, "session.suggestionTitle"),
    description: translate(state.language, "session.suggestionDescription", {
      current: currentTitle || "-",
      suggestion: String(suggestedTitle ?? "").trim()
    }),
    confirmText: translate(state.language, "session.suggestionApply"),
    cancelText: translate(state.language, "session.suggestionKeep")
  });
}

async function maybeSuggestSessionTitle(sessionId, replay) {
  const currentSession = sessionById(sessionId) ?? replay?.session;
  const currentTitle = String(currentSession?.title ?? replay?.session?.title ?? "").trim();

  if (!titleLooksGenerated(currentTitle, sessionId)) {
    return;
  }

  const suggestedTitle = buildSessionTitleSuggestion(replay);

  if (!suggestedTitle || suggestedTitle === currentTitle) {
    return;
  }

  const chosenTitle = await requestSessionTitleSuggestion(currentTitle, suggestedTitle);

  if (!chosenTitle || chosenTitle === currentTitle) {
    return;
  }

  await persistSessionTitle(sessionId, chosenTitle);
}

function renderConversationFeed() {
  if (!elements.conversationList) {
    return;
  }

  const replayQuery = state.historyMode === "replay"
    ? state.replaySearchQuery.trim().toLowerCase()
    : "";
  const segments = state.historyMode === "replay"
    ? orderedSourceSegments()
    : orderedSourceSegments().slice(-LIVE_TRANSCRIPT_WINDOW);
  const html = segments.map((segment) => {
    const translation = translationBySegmentId(segment.segmentId);
    const isFocused = state.historyMode === "replay" && state.replayFocusedSequence === segment.sequence;
    const isMatched = state.historyMode === "replay" && Boolean(replayQuery) && segmentMatchesQuery(segment, translation, replayQuery);
    const translationTone = translation?.isFinal ? "" : "speculative";

    return `
      <article class="conversation-entry chat-entry ${translation?.text ? "" : "pending"} ${isFocused ? "focused" : ""} ${isMatched ? "matched" : ""}" data-segment-id="${escapeHtml(segment.segmentId)}" data-segment-sequence="${escapeHtml(String(segment.sequence))}">
        <div class="chat-bound">
          <div class="chat-source-wrap">
            <div class="chat-source">
              <div class="chat-label">#${escapeHtml(segment.sequence)}</div>
              <div class="entry-source">${escapeHtml(segment.text)}</div>
            </div>
          </div>
          ${translation?.text ? `
            <div class="chat-translation-wrap">
              <div class="chat-translation ${translationTone}">
                <div class="entry-translation">${escapeHtml(translation.text)}</div>
              </div>
            </div>
          ` : ""}
        </div>
      </article>
    `;
  }).join("");

  elements.conversationList.innerHTML = html || `
    <article class="conversation-entry pending">
      <div class="chat-source-wrap">
        <div class="chat-source">
          <div class="entry-source">${escapeHtml(translate(state.language, "workspace.sourceEmpty"))}</div>
        </div>
      </div>
    </article>
  `;

  if (state.historyMode === "live") {
    elements.conversationList.scrollTop = elements.conversationList.scrollHeight;
  } else if (state.replayFocusedSequence > 0) {
    window.requestAnimationFrame(() => {
      elements.conversationList
        .querySelector(`[data-segment-sequence="${String(state.replayFocusedSequence)}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }
}

function renderCurrentSpeech() {
  if (!elements.currentSourceLine || !elements.currentTranslationLine) {
    return;
  }

  const renderPerfAt = performance.now();
  const renderEpochMs = Date.now();
  const latestSegment = orderedSourceSegments().slice(-1)[0];
  const latestTranslation = latestSegment
    ? translationBySegmentId(latestSegment.segmentId)
    : null;
  const latestAnyTranslation = orderedTranslations().slice(-1)[0];
  const translationIsFinal = latestTranslation?.isFinal ?? latestAnyTranslation?.isFinal ?? false;

  const sourceFallback = latestSegment?.text ?? translate(state.language, "workspace.sourceEmpty");
  const translationFallback = latestTranslation?.text ?? latestAnyTranslation?.text ?? "";
  const sourceText = state.historyMode === "live"
    ? (state.liveNow.sourceText || sourceFallback)
    : sourceFallback;
  const translationText = state.historyMode === "live"
    ? (state.liveNow.translationText || translationFallback)
    : translationFallback;

  if (state.historyMode === "live") {
    animateSpeechLine(
      elements.currentSourceLine,
      "sourceTimerId",
      "sourceText",
      sourceText
    );
    animateSpeechLine(
      elements.currentTranslationLine,
      "translationTimerId",
      "translationText",
      translationText
    );
  } else {
    stopSpeechDraftTimers();
    state.currentSpeechDraft.sourceText = sourceText;
    state.currentSpeechDraft.translationText = translationText;
    elements.currentSourceLine.textContent = sourceText;
    elements.currentTranslationLine.textContent = translationText;
    elements.currentSourceLine.classList.toggle("current-speech-caret", Boolean(sourceText));
    elements.currentTranslationLine.classList.toggle("current-speech-caret", Boolean(translationText));
  }

  elements.currentTranslationLine.classList.toggle("speculative", Boolean(translationText) && !translationIsFinal);

  if (state.historyMode === "live") {
    if (state.liveNow.sourceEventPerfAt > 0) {
      const localLag = Math.max(0, renderPerfAt - state.liveNow.sourceEventPerfAt);
      state.liveLatency.sourceLocalMs = smoothMetric(state.liveLatency.sourceLocalMs, localLag);
      state.liveLatency.sourceUpdatedAt = renderEpochMs;
    }

    if (state.liveNow.translationEventPerfAt > 0) {
      const localLag = Math.max(0, renderPerfAt - state.liveNow.translationEventPerfAt);
      state.liveLatency.translationLocalMs = smoothMetric(state.liveLatency.translationLocalMs, localLag);
      state.liveLatency.translationUpdatedAt = renderEpochMs;
    }

    if (state.liveNow.sourceEventEpochMs > 0) {
      const e2eLag = Math.max(0, renderEpochMs - state.liveNow.sourceEventEpochMs);
      state.liveLatency.sourceE2eMs = smoothMetric(state.liveLatency.sourceE2eMs, e2eLag);
    }

    if (state.liveNow.translationEventEpochMs > 0) {
      const e2eLag = Math.max(0, renderEpochMs - state.liveNow.translationEventEpochMs);
      state.liveLatency.translationE2eMs = smoothMetric(state.liveLatency.translationE2eMs, e2eLag);
    }
  }

  updateLiveLatencyBadge();
}

function folderLabel(folder) {
  if (folder?.labelKey) {
    const translated = translate(state.language, folder.labelKey);
    if (translated && translated !== folder.labelKey) {
      return translated;
    }
  }

  return folder?.label ?? "";
}

function sessionsForActiveFolder() {
  if (state.sidebarView === "history" || state.folderFilter === "recent") {
    return state.recentSessionIds
      .map((sessionId) => state.sessions.find((session) => session.id === sessionId))
      .filter(Boolean);
  }

  if (state.folderSessionFolderFilter && state.folderSessionFolderFilter !== "all") {
    return state.sessions.filter((session) => state.folderAssignments[session.id] === state.folderSessionFolderFilter);
  }

  return state.sessions;
}

function sessionTimestamp(session) {
  const candidates = [session?.updatedAt, session?.lastEventAt, session?.createdAt];

  for (const value of candidates) {
    const timestamp = Date.parse(value ?? "");
    if (!Number.isNaN(timestamp)) {
      return timestamp;
    }
  }

  return 0;
}

function sessionStatusMeta(rawStatus) {
  const value = String(rawStatus ?? "").trim();
  const normalized = value.toLowerCase();

  if (!value) {
    return {
      tone: "pending",
      label: translate(state.language, "session.statusPending")
    };
  }

  if (/fail|error|cancel|reject|timeout|conflict/.test(normalized)) {
    return {
      tone: "failed",
      label: translate(state.language, "session.statusFailed")
    };
  }

  if (/pause|hold/.test(normalized)) {
    return {
      tone: "paused",
      label: translate(state.language, "session.statusPaused")
    };
  }

  if (/done|success|complete|final|closed|stopped|finished/.test(normalized)) {
    return {
      tone: "complete",
      label: translate(state.language, "session.statusComplete")
    };
  }

  if (/pending|queued|new|created|idle/.test(normalized)) {
    return {
      tone: "pending",
      label: translate(state.language, "session.statusPending")
    };
  }

  if (/active|running|processing|process|stream|capture|live|ingest|upload|connect/.test(normalized)) {
    return {
      tone: "processing",
      label: translate(state.language, "session.statusProcessing")
    };
  }

  return {
    tone: "processing",
    label: value
  };
}

function sessionMatchesSearch(session, searchTerm) {
  if (!searchTerm) {
    return true;
  }

  const assignedFolder = state.projectFolders.find((folder) => folder.id === state.folderAssignments[session.id]);
  const candidates = [
    session.title,
    session.id,
    assignedFolder ? folderLabel(assignedFolder) : translate(state.language, "session.unsorted")
  ];

  return candidates.some((item) => String(item ?? "").toLowerCase().includes(searchTerm));
}

function sortSessionsForList(sessions) {
  const next = [...sessions];
  next.sort((left, right) => sessionTimestamp(right) - sessionTimestamp(left));
  return next;
}

function sessionById(sessionId) {
  return state.sessions.find((session) => session.id === sessionId) ?? null;
}

async function renameSessionFromList(sessionId) {
  const session = sessionById(sessionId);

  if (!session) {
    return;
  }

  const currentTitle = String(session.title ?? "").trim() || session.id;
  const nextTitle = await requestSessionTitleDialog({
    initialValue: currentTitle,
    title: translate(state.language, "session.actionRename"),
    description: translate(state.language, "session.renamePrompt"),
    confirmText: state.language === "zh-CN" ? "保存" : "Save",
    cancelText: state.language === "zh-CN" ? "取消" : "Cancel"
  });

  if (nextTitle === null) {
    return;
  }

  if (!nextTitle) {
    alert(translate(state.language, "session.renameEmpty"));
    return;
  }

  if (nextTitle === currentTitle) {
    return;
  }

  await persistSessionTitle(sessionId, nextTitle);
}

async function openSessionFromList(sessionId) {
  if (!sessionId) {
    return;
  }

  const session = sessionById(sessionId);
  if (session) {
    applySessionConfiguration(session);
  }
  elements.sessionId.value = sessionId;
  rememberRecentSession(sessionId);
  syncSessionActionButtons();
  setSidebarView("dashboard");
  renderSessionList();
  await loadReplay();
}

function closeSessionPreview() {
  state.previewSessionId = "";
  state.previewSessionLoading = false;
  state.previewSessionError = "";
  state.previewSessionQuery = "";
  renderSessionList();
  renderSessionPreviewDrawer();
}

async function ensurePreviewReplay(sessionId, options = {}) {
  const force = Boolean(options.force);

  if (!force && state.previewReplayCache.has(sessionId)) {
    return state.previewReplayCache.get(sessionId);
  }

  const response = await fetch(`${elements.apiBaseUrl.value}/sessions/${sessionId}/replay`);
  const replay = await response.json();
  state.previewReplayCache.set(sessionId, replay);
  syncSessionInsightFromReplay(sessionId, replay);
  return replay;
}

async function openSessionPreview(sessionId) {
  if (!sessionId) {
    return;
  }

  state.previewSessionId = sessionId;
  state.previewSessionLoading = true;
  state.previewSessionError = "";
  state.previewSessionQuery = "";
  renderSessionList();
  renderSessionPreviewDrawer();

  try {
    await ensurePreviewReplay(sessionId);
  } catch (error) {
    if (state.previewSessionId === sessionId) {
      state.previewSessionError = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (state.previewSessionId === sessionId) {
      state.previewSessionLoading = false;
      renderSessionList();
      renderSessionPreviewDrawer();
    }
  }
}

function sessionsForFolder(folderId) {
  return state.sessions.filter((session) => state.folderAssignments[session.id] === folderId);
}

function folderOpsMetrics(folderId) {
  const now = Date.now();
  const sessions = sessionsForFolder(folderId);
  const total = sessions.length;
  const failed = sessions.filter((session) => sessionStatusMeta(session.status).tone === "failed").length;
  const updatedIn24h = sessions.filter((session) => sessionTimestamp(session) >= now - 24 * 60 * 60 * 1000).length;
  const avgSegments = total > 0
    ? Math.round((sessions.reduce((sum, session) => sum + (session.segmentCount ?? 0), 0) / total) * 10) / 10
    : 0;

  return {
    total,
    failed,
    failureRate: total > 0 ? Math.round((failed / total) * 1000) / 10 : 0,
    throughput24h: updatedIn24h,
    avgSegments
  };
}

function moveSessionsToFolder(sessionIds, targetFolderId) {
  const normalizedIds = normalizeSessionIdList(sessionIds);
  if (!targetFolderId || normalizedIds.length === 0) {
    return;
  }

  const previousAssignments = {};
  for (const sessionId of normalizedIds) {
    previousAssignments[sessionId] = state.folderAssignments[sessionId] ?? "";
    state.folderAssignments[sessionId] = targetFolderId;
  }

  saveFolderAssignments();
  renderFolderList();
  renderSessionList();
  showUndoToast(
    state.language === "zh-CN"
      ? `已移动 ${normalizedIds.length} 条会话，可撤销。`
      : `Moved ${normalizedIds.length} sessions. Undo available.`,
    () => {
      for (const [sessionId, folderId] of Object.entries(previousAssignments)) {
        if (folderId) {
          state.folderAssignments[sessionId] = folderId;
        } else {
          delete state.folderAssignments[sessionId];
        }
      }
      saveFolderAssignments();
      renderFolderList();
      renderSessionList();
    }
  );
}

function renderFolderList() {
  if (!elements.folderList) {
    return;
  }

  if (typeof state.folderContextMenuCleanup === "function") {
    state.folderContextMenuCleanup();
    state.folderContextMenuCleanup = null;
  }

  if (!activeProjectFolder() && state.projectFolders.length > 0) {
    state.activeProjectFolderId = state.projectFolders[0].id;
  }

  if (state.folderSessionFolderFilter !== "all" && !state.projectFolders.some((folder) => folder.id === state.folderSessionFolderFilter)) {
    state.folderSessionFolderFilter = state.projectFolders[0]?.id ?? "all";
  }

  const folders = projectFolders();
  const projectsHtml = folders.map((folder) => {
    const count = folderSessionCount(folder.id);
    const isActive = state.folderSessionFolderFilter === folder.id;
    const accent = folderAccentColor(folder);

    return `
      <button
        class="folder-strip-item folder-strip-project ${isActive ? "active" : ""}"
        data-project-id="${folder.id}"
        style="--folder-accent:${escapeHtml(accent)};"
        type="button"
      >
        <span class="folder-strip-icon" aria-hidden="true">
          <svg width="22" height="18" viewBox="0 0 24 20" fill="none">
            <path d="M2 4.8A2.8 2.8 0 0 1 4.8 2h4.2l1.8 2.2h8.4A2.8 2.8 0 0 1 22 7v8.2A2.8 2.8 0 0 1 19.2 18H4.8A2.8 2.8 0 0 1 2 15.2V4.8Z" fill="var(--folder-accent)" fill-opacity=".22" stroke="var(--folder-accent)" stroke-width="1.4"/>
          </svg>
        </span>
        <span class="folder-strip-title">${escapeHtml(folderLabel(folder))}</span>
        <span class="folder-strip-meta">${escapeHtml(String(count))} ${escapeHtml(translate(state.language, "sidebar.sessionsUnit"))}</span>
      </button>
    `;
  }).join("");

  const metricsHtml = folders.map((folder) => {
    const accent = folderAccentColor(folder);
    const metrics = folderOpsMetrics(folder.id);

    return `
      <article class="folder-ops-card" style="--folder-accent:${escapeHtml(accent)};">
        <div class="folder-ops-title">${escapeHtml(folderLabel(folder))}</div>
        <div class="folder-ops-line">
          <span>${escapeHtml(state.language === "zh-CN" ? "24h 吞吐" : "24h Throughput")}</span>
          <strong>${escapeHtml(String(metrics.throughput24h))}</strong>
        </div>
        <div class="folder-ops-line">
          <span>${escapeHtml(state.language === "zh-CN" ? "失败率" : "Failure rate")}</span>
          <strong>${escapeHtml(String(metrics.failureRate))}%</strong>
        </div>
        <div class="folder-ops-line">
          <span>${escapeHtml(state.language === "zh-CN" ? "平均片段" : "Avg segments")}</span>
          <strong>${escapeHtml(String(metrics.avgSegments))}</strong>
        </div>
      </article>
    `;
  }).join("");

  const stripLabel = state.language === "zh-CN" ? "项目文件夹" : "Project folders";
  const emptyLabel = state.language === "zh-CN" ? "暂无项目文件夹，先新建一个。" : "No project folders yet. Create one to start.";
  const addLabel = state.language === "zh-CN" ? "新增文件夹" : "New folder";
  const metricsLabel = state.language === "zh-CN" ? "运营视图" : "Ops view";

  elements.folderList.innerHTML = `
    <section class="folder-strip-shell">
      <div class="folder-strip-head">
        <div class="status-kicker">${escapeHtml(stripLabel)}</div>
        <div class="folder-strip-controls">
          <button class="folder-add-button" id="createFolderButton" type="button">+ ${escapeHtml(addLabel)}</button>
          <button
            class="folder-scroll-button"
            data-folder-scroll="-1"
            type="button"
            aria-label="${escapeHtml(translate(state.language, "folder.scrollLeft"))}"
          >
            <span aria-hidden="true">&#8592;</span>
          </button>
          <button
            class="folder-scroll-button"
            data-folder-scroll="1"
            type="button"
            aria-label="${escapeHtml(translate(state.language, "folder.scrollRight"))}"
          >
            <span aria-hidden="true">&#8594;</span>
          </button>
        </div>
      </div>
      <div class="folder-strip-track" id="folderStripTrack">
        ${projectsHtml || `<div class="folder-strip-empty">${escapeHtml(emptyLabel)}</div>`}
      </div>
      <div class="folder-ops-wrap">
        <div class="status-kicker">${escapeHtml(metricsLabel)}</div>
        <div class="folder-ops-grid">
          ${metricsHtml || `<div class="folder-strip-empty">${escapeHtml(emptyLabel)}</div>`}
        </div>
      </div>
      <div class="folder-context-menu" id="folderContextMenu" hidden>
        <button class="folder-context-action" data-context-action="rename" type="button">${escapeHtml(translate(state.language, "folder.rename"))}</button>
        <button class="folder-context-action danger" data-context-action="delete" type="button">${escapeHtml(translate(state.language, "folder.delete"))}</button>
        <div class="folder-context-divider"></div>
        <div class="folder-context-color-title">${escapeHtml(translate(state.language, "folder.color"))}</div>
        <div class="folder-context-colors">
          ${FOLDER_COLOR_PALETTE.map((color) => `
            <button
              class="folder-color-dot"
              data-context-color="${color}"
              style="--folder-accent:${color};"
              type="button"
              aria-label="${escapeHtml(translate(state.language, "folder.color"))}"
            ></button>
          `).join("")}
        </div>
      </div>
    </section>
  `;

  elements.folderList.querySelectorAll("button[data-project-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeProjectFolderId = button.dataset.projectId;
      state.folderFilter = "projects";
      state.folderSessionFolderFilter = button.dataset.projectId;
      renderFolderList();
      renderSessionList();
    });

    button.addEventListener("dragover", (event) => {
      if (!state.draggingSessionId) {
        return;
      }

      event.preventDefault();
      button.classList.add("drop-target");
    });

    button.addEventListener("dragleave", (event) => {
      const related = event.relatedTarget;
      if (related instanceof Node && button.contains(related)) {
        return;
      }
      button.classList.remove("drop-target");
    });

    button.addEventListener("drop", (event) => {
      event.preventDefault();
      button.classList.remove("drop-target");

      const draggedId = event.dataTransfer?.getData("text/session-id") || state.draggingSessionId;
      const targetFolderId = button.dataset.projectId;
      if (!draggedId || !targetFolderId) {
        return;
      }

      const sessionIds = isSessionSelected(draggedId) && state.selectedSessionIds.length > 1
        ? state.selectedSessionIds
        : [draggedId];
      moveSessionsToFolder(sessionIds, targetFolderId);
      state.draggingSessionId = "";
    });
  });

  const contextMenu = elements.folderList.querySelector("#folderContextMenu");
  let contextFolderId = "";

  const closeContextMenu = () => {
    if (!(contextMenu instanceof HTMLElement)) {
      return;
    }

    contextMenu.hidden = true;
    contextFolderId = "";

    if (typeof state.folderContextMenuCleanup === "function") {
      state.folderContextMenuCleanup();
      state.folderContextMenuCleanup = null;
    }
  };

  const registerContextDismiss = () => {
    if (typeof state.folderContextMenuCleanup === "function") {
      state.folderContextMenuCleanup();
      state.folderContextMenuCleanup = null;
    }

    const handleDocumentClick = (event) => {
      if (!(contextMenu instanceof HTMLElement) || contextMenu.hidden) {
        return;
      }
      if (event.target instanceof Node && contextMenu.contains(event.target)) {
        return;
      }
      closeContextMenu();
    };

    const handleDocumentKeydown = (event) => {
      if (event.key === "Escape") {
        closeContextMenu();
      }
    };

    const handleWindowBlur = () => {
      closeContextMenu();
    };

    document.addEventListener("click", handleDocumentClick, true);
    document.addEventListener("keydown", handleDocumentKeydown);
    window.addEventListener("blur", handleWindowBlur);

    state.folderContextMenuCleanup = () => {
      document.removeEventListener("click", handleDocumentClick, true);
      document.removeEventListener("keydown", handleDocumentKeydown);
      window.removeEventListener("blur", handleWindowBlur);
    };
  };

  const openContextMenu = (event, folderId) => {
    if (!(contextMenu instanceof HTMLElement)) {
      return;
    }

    contextFolderId = folderId;
    contextMenu.hidden = false;

    const bounds = elements.folderList.getBoundingClientRect();
    const menuWidth = 220;
    const menuHeight = 190;
    const left = Math.max(8, Math.min(event.clientX - bounds.left, bounds.width - menuWidth - 8));
    const top = Math.max(8, Math.min(event.clientY - bounds.top, bounds.height - menuHeight - 8));
    contextMenu.style.left = `${left}px`;
    contextMenu.style.top = `${top}px`;
    registerContextDismiss();
  };

  elements.folderList.querySelectorAll("button[data-project-id]").forEach((button) => {
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openContextMenu(event, button.dataset.projectId);
    });
  });

  contextMenu?.querySelector("button[data-context-action='rename']")?.addEventListener("click", async () => {
    if (!contextFolderId) {
      return;
    }
    await renameProjectFolder(contextFolderId);
    closeContextMenu();
  });

  contextMenu?.querySelector("button[data-context-action='delete']")?.addEventListener("click", () => {
    if (!contextFolderId) {
      return;
    }
    deleteProjectFolder(contextFolderId);
    closeContextMenu();
  });

  contextMenu?.querySelectorAll("button[data-context-color]")?.forEach((button) => {
    button.addEventListener("click", () => {
      if (!contextFolderId) {
        return;
      }
      updateProjectFolderColor(contextFolderId, button.dataset.contextColor);
      closeContextMenu();
    });
  });

  elements.folderList.querySelector("#createFolderButton")?.addEventListener("click", () => {
    createProjectFolder().catch((error) => {
      appendEvent("folder.create_error", {
        message: error instanceof Error ? error.message : String(error)
      });
    });
  });

  const track = elements.folderList.querySelector("#folderStripTrack");
  if (track instanceof HTMLElement) {
    track.addEventListener("wheel", (event) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
        return;
      }

      event.preventDefault();
      track.scrollBy({
        left: event.deltaY,
        behavior: "auto"
      });
    });
  }

  elements.folderList.querySelectorAll("button[data-folder-scroll]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!(track instanceof HTMLElement)) {
        return;
      }

      const direction = Number(button.dataset.folderScroll ?? "0");
      if (!Number.isFinite(direction) || direction === 0) {
        return;
      }

      track.scrollBy({
        left: direction * 280,
        behavior: "smooth"
      });
    });
  });
}

function segmentMatchesQuery(segment, translation, query) {
  const normalized = String(query ?? "").trim().toLowerCase();

  if (!normalized) {
    return true;
  }

  return [
    segment?.text,
    translation?.text
  ].some((value) => String(value ?? "").toLowerCase().includes(normalized));
}

function renderSessionPreviewDrawer() {
  if (!(elements.sessionPreviewDrawer instanceof HTMLElement)) {
    return;
  }

  const panelHost = elements.sessionPreviewDrawer.closest(".library-session-panel");
  const sessionId = state.previewSessionId;
  const previewSession = sessionById(sessionId);
  const replay = sessionId ? state.previewReplayCache.get(sessionId) : null;

  if (panelHost instanceof HTMLElement) {
    panelHost.dataset.previewOpen = sessionId ? "true" : "false";
  }

  if (!sessionId || !previewSession) {
    elements.sessionPreviewDrawer.hidden = true;
    elements.sessionPreviewDrawer.innerHTML = "";
    return;
  }

  elements.sessionPreviewDrawer.hidden = false;

  if (state.previewSessionLoading && !replay) {
    elements.sessionPreviewDrawer.innerHTML = `
      <div class="preview-drawer-head">
        <div>
          <div class="status-kicker">${escapeHtml(state.language === "zh-CN" ? "记录预览" : "Session Preview")}</div>
          <h3 class="preview-drawer-title">${escapeHtml(previewSession.title ?? previewSession.id)}</h3>
        </div>
        <button class="preview-drawer-close" data-preview-close type="button">&times;</button>
      </div>
      <div class="preview-drawer-loading">${escapeHtml(state.language === "zh-CN" ? "正在加载记录内容..." : "Loading session preview...")}</div>
    `;
  } else if (state.previewSessionError) {
    elements.sessionPreviewDrawer.innerHTML = `
      <div class="preview-drawer-head">
        <div>
          <div class="status-kicker">${escapeHtml(state.language === "zh-CN" ? "记录预览" : "Session Preview")}</div>
          <h3 class="preview-drawer-title">${escapeHtml(previewSession.title ?? previewSession.id)}</h3>
        </div>
        <button class="preview-drawer-close" data-preview-close type="button">&times;</button>
      </div>
      <div class="preview-drawer-error">${escapeHtml(state.previewSessionError)}</div>
    `;
  } else {
    const segments = replay?.segments ?? [];
    const translations = new Map((replay?.translations ?? []).map((translation) => [
      `${translation.segmentId}:${normalizeUiLanguageCode(translation.targetLanguage)}`,
      translation
    ]));
    const activeTarget = normalizeUiLanguageCode(previewSession.config?.targetLanguages?.[0] ?? targetLanguages()[0] ?? "en");
    const segmentRows = segments
      .filter((segment) => segment.status === "final")
      .map((segment) => {
        const translation = translations.get(`${segment.segmentId}:${activeTarget}`)
          ?? Array.from(translations.values()).find((item) => item.segmentId === segment.segmentId);
        return {
          segment,
          translation
        };
      })
      .filter(({ segment, translation }) => segmentMatchesQuery(segment, translation, state.previewSessionQuery));
    const keywords = replayKeywordsFromSegments(segmentRows.map(({ segment }) => segment));
    const audioHtml = (replay?.audioClips ?? []).slice(0, 3).map((clip) => `
      <div class="preview-audio-item">
        <div class="preview-audio-meta">#${escapeHtml(clip.sequence)} · ${escapeHtml(audioClipDisplayLabel(clip))}</div>
        <audio controls src="data:${escapeHtml(clip.mimeType)};base64,${escapeHtml(clip.dataBase64)}"></audio>
      </div>
    `).join("");
    const summaryHtml = replay?.summary?.summary
      ? `<p class="preview-summary-copy">${escapeHtml(replay.summary.summary)}</p>`
      : segmentRows.slice(0, 3).map(({ segment, translation }) => `
        <div class="preview-summary-item">
          <strong>${escapeHtml(segment.text)}</strong>
          ${translation?.text ? `<span>${escapeHtml(translation.text)}</span>` : ""}
        </div>
      `).join("");
    const chipList = [
      sessionLanguagePair(previewSession),
      formatDurationLabel(sessionInsight(sessionId).durationMs || durationMsFromSession(previewSession)),
      sessionLatencyChip(previewSession).label,
      sessionStatusMeta(previewSession.status).label
    ];

    elements.sessionPreviewDrawer.innerHTML = `
      <div class="preview-drawer-head">
        <div>
          <div class="status-kicker">${escapeHtml(state.language === "zh-CN" ? "记录预览" : "Session Preview")}</div>
          <h3 class="preview-drawer-title">${escapeHtml(previewSession.title ?? previewSession.id)}</h3>
          <div class="preview-chip-row">
            ${chipList.map((chip) => `<span class="preview-chip">${escapeHtml(chip)}</span>`).join("")}
          </div>
        </div>
        <button class="preview-drawer-close" data-preview-close type="button">&times;</button>
      </div>
      <div class="preview-drawer-actions">
        <button class="preview-primary-action" data-preview-open="${escapeHtml(sessionId)}" type="button">${escapeHtml(state.language === "zh-CN" ? "打开完整回放" : "Open Full Replay")}</button>
        <button class="session-open-button secondary" data-preview-rename="${escapeHtml(sessionId)}" type="button">${escapeHtml(translate(state.language, "session.actionRename"))}</button>
      </div>
      <div class="preview-search-row">
        <input id="previewSearchInput" type="search" value="${escapeHtml(state.previewSessionQuery)}" placeholder="${escapeHtml(state.language === "zh-CN" ? "搜索原文或译文" : "Search source or translation")}" />
      </div>
      ${keywords.length > 0 ? `
        <div class="preview-keyword-row">
          ${keywords.map((keyword) => `<button class="preview-keyword-chip" data-preview-keyword="${escapeHtml(keyword)}" type="button">${escapeHtml(keyword)}</button>`).join("")}
        </div>
      ` : ""}
      <div class="preview-drawer-section">
        <div class="preview-section-title">${escapeHtml(state.language === "zh-CN" ? "摘要" : "Summary")}</div>
        <div class="preview-summary-block">${summaryHtml || `<p class="preview-summary-copy">${escapeHtml(translate(state.language, "summary.empty"))}</p>`}</div>
      </div>
      <div class="preview-drawer-section">
        <div class="preview-section-title">${escapeHtml(state.language === "zh-CN" ? "双语片段" : "Bilingual Snippets")}</div>
        <div class="preview-snippet-list">
          ${segmentRows.slice(0, 8).map(({ segment, translation }) => `
            <button class="preview-snippet" data-preview-open="${escapeHtml(sessionId)}" data-preview-sequence="${escapeHtml(String(segment.sequence))}" type="button">
              <strong>#${escapeHtml(segment.sequence)} · ${escapeHtml(segment.text)}</strong>
              ${translation?.text ? `<span>${escapeHtml(translation.text)}</span>` : ""}
            </button>
          `).join("") || `<div class="preview-empty">${escapeHtml(state.language === "zh-CN" ? "暂无匹配片段" : "No matching snippets")}</div>`}
        </div>
      </div>
      <div class="preview-drawer-section">
        <div class="preview-section-title">${escapeHtml(state.language === "zh-CN" ? "音频" : "Audio")}</div>
        <div class="preview-audio-list">
          ${audioHtml || `<div class="preview-empty">${escapeHtml(translate(state.language, "audio.empty"))}</div>`}
        </div>
      </div>
    `;
  }

  elements.sessionPreviewDrawer.querySelector("[data-preview-close]")?.addEventListener("click", closeSessionPreview);
  elements.sessionPreviewDrawer.querySelectorAll("[data-preview-open]").forEach((button) => {
    button.addEventListener("click", async () => {
      const nextSessionId = button.getAttribute("data-preview-open") ?? "";
      const sequence = Number(button.getAttribute("data-preview-sequence") ?? "0");
      state.pendingReplayFocusSequence = Number.isFinite(sequence) && sequence > 0 ? sequence : 0;
      closeSessionPreview();
      await openSessionFromList(nextSessionId);
    });
  });
  elements.sessionPreviewDrawer.querySelector("[data-preview-rename]")?.addEventListener("click", async () => {
    const nextSessionId = elements.sessionPreviewDrawer.querySelector("[data-preview-rename]")?.getAttribute("data-preview-rename") ?? "";
    await renameSessionFromList(nextSessionId);
    renderSessionPreviewDrawer();
  });
  elements.sessionPreviewDrawer.querySelector("#previewSearchInput")?.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    state.previewSessionQuery = target.value;
    renderSessionPreviewDrawer();
  });
  elements.sessionPreviewDrawer.querySelectorAll("[data-preview-keyword]").forEach((button) => {
    button.addEventListener("click", () => {
      state.previewSessionQuery = button.getAttribute("data-preview-keyword") ?? "";
      renderSessionPreviewDrawer();
    });
  });
}

function renderSessionList() {
  if (!elements.sessionList) {
    return;
  }

  if (typeof state.sessionListCleanup === "function") {
    state.sessionListCleanup();
    state.sessionListCleanup = null;
  }

  setSelectedSessionIds(
    state.selectedSessionIds.filter((sessionId) => state.sessions.some((session) => session.id === sessionId))
  );

  const folderFilterOptions = [
    {
      id: "all",
      label: state.language === "zh-CN" ? "全部文件夹" : "All folders"
    },
    ...state.projectFolders.map((folder) => ({
      id: folder.id,
      label: folderLabel(folder)
    }))
  ];

  if (state.folderSessionFolderFilter !== "all" && !state.projectFolders.some((folder) => folder.id === state.folderSessionFolderFilter)) {
    state.folderSessionFolderFilter = "all";
  }

  if (state.batchMoveTargetFolderId && !state.projectFolders.some((folder) => folder.id === state.batchMoveTargetFolderId)) {
    state.batchMoveTargetFolderId = "";
  }

  const searchTerm = state.folderSessionSearch.trim().toLowerCase();
  const sessions = sortSessionsForList(
    sessionsForActiveFolder().filter((session) => sessionMatchesSearch(session, searchTerm))
  );
  const visibleSessionIds = sessions.map((session) => session.id);
  const selectedVisibleCount = visibleSessionIds.filter((sessionId) => isSessionSelected(sessionId)).length;
  const allVisibleSelected = visibleSessionIds.length > 0 && selectedVisibleCount === visibleSessionIds.length;
  const batchMoveOptions = state.projectFolders.map((folder) => ({
    id: folder.id,
    label: folderLabel(folder)
  }));
  const folderFilterLabel = folderFilterOptions.find((option) => option.id === state.folderSessionFolderFilter)?.label
    ?? (state.language === "zh-CN" ? "全部文件夹" : "All folders");
  const batchMoveLabel = batchMoveOptions.find((option) => option.id === state.batchMoveTargetFolderId)?.label
    ?? (state.language === "zh-CN" ? "移动到文件夹..." : "Move to folder...");
  const sessionRows = sessions.map((session) => {
    const assignedFolder = state.projectFolders.find((folder) => folder.id === state.folderAssignments[session.id]);
    const status = sessionStatusMeta(session.status);
    const latency = sessionLatencyChip(session);
    const title = String(session.title ?? "").trim() || session.id;
    const folderName = assignedFolder ? folderLabel(assignedFolder) : translate(state.language, "session.unsorted");
    const segmentCount = session.segmentCount ?? 0;
    const updatedLabel = formatSessionStamp(session);
    const selected = isSessionSelected(session.id);
    const active = elements.sessionId.value === session.id || state.previewSessionId === session.id;
    const sessionChips = [
      { tone: "neutral", label: sessionLanguagePair(session) },
      { tone: "neutral", label: formatDurationLabel(sessionInsight(session.id).durationMs || durationMsFromSession(session)) },
      { tone: latency.tone, label: latency.label },
      { tone: status.tone, label: status.label }
    ];

    return `
      <div class="session-table-row ${active ? "active" : ""} ${selected ? "selected" : ""}" draggable="true" data-session-row-id="${session.id}">
        <div class="session-table-cell session-table-check">
          <input class="session-select-checkbox" data-session-select-id="${session.id}" type="checkbox" ${selected ? "checked" : ""} />
        </div>
        <button class="session-table-cell session-table-name" data-session-preview-id="${session.id}" type="button">
          <span class="session-table-title">${escapeHtml(title)}</span>
          <span class="session-table-subtitle">${escapeHtml(session.id)}</span>
          <span class="session-inline-chip-row">
            ${sessionChips.map((chip) => `<span class="status-chip tone-${escapeHtml(chip.tone)} compact">${escapeHtml(chip.label)}</span>`).join("")}
          </span>
        </button>
        <div class="session-table-cell session-table-folder">${escapeHtml(folderName)}</div>
        <div class="session-table-cell session-table-segments">${escapeHtml(String(segmentCount))}</div>
        <div class="session-table-cell session-table-updated">${escapeHtml(updatedLabel)}</div>
        <div class="session-table-cell session-table-status">
          <span class="status-chip tone-${status.tone}">${escapeHtml(status.label)}</span>
        </div>
        <div class="session-table-cell session-table-actions">
          <div class="session-action-group">
            <button class="session-open-button" data-session-id="${session.id}" type="button">${escapeHtml(translate(state.language, "session.actionOpen"))}</button>
            <button class="session-open-button secondary" data-session-rename-id="${session.id}" type="button">${escapeHtml(translate(state.language, "session.actionRename"))}</button>
          </div>
        </div>
      </div>
    `;
  }).join("");

  elements.sessionList.innerHTML = `
    <div class="session-list-toolbar">
      <input
        id="sessionSearchInput"
        type="search"
        value="${escapeHtml(state.folderSessionSearch)}"
        placeholder="${escapeHtml(translate(state.language, "session.searchPlaceholder"))}"
      />
      <div class="queue-popdown" data-queue-popdown="filter" data-open="false">
        <button class="queue-popdown-trigger" id="sessionFolderFilterTrigger" type="button" aria-haspopup="listbox" aria-expanded="false">
          <span>${escapeHtml(folderFilterLabel)}</span>
        </button>
        <div class="queue-popdown-panel" id="sessionFolderFilterPanel" role="listbox">
          ${folderFilterOptions.map((option) => `
            <button class="queue-popdown-option ${state.folderSessionFolderFilter === option.id ? "active" : ""}" data-filter-option="${option.id}" type="button" role="option" aria-selected="${state.folderSessionFolderFilter === option.id ? "true" : "false"}">
              ${escapeHtml(option.label)}
            </button>
          `).join("")}
        </div>
      </div>
    </div>
    <div class="session-batch-bar">
      <label class="session-select-all-wrap">
        <input id="sessionSelectAll" type="checkbox" ${allVisibleSelected ? "checked" : ""} />
        <span>${escapeHtml(state.language === "zh-CN" ? "全选当前页" : "Select visible")}</span>
      </label>
      <span class="session-selected-count">
        ${escapeHtml(state.language === "zh-CN" ? `已选 ${state.selectedSessionIds.length}` : `${state.selectedSessionIds.length} selected`)}
      </span>
      <div class="queue-popdown queue-popdown-compact" data-queue-popdown="move" data-open="false">
        <button class="queue-popdown-trigger" id="sessionBatchMoveTrigger" type="button" aria-haspopup="listbox" aria-expanded="false">
          <span>${escapeHtml(batchMoveLabel)}</span>
        </button>
        <div class="queue-popdown-panel" id="sessionBatchMovePanel" role="listbox">
          ${batchMoveOptions.map((option) => `
            <button class="queue-popdown-option ${state.batchMoveTargetFolderId === option.id ? "active" : ""}" data-move-option="${option.id}" type="button" role="option" aria-selected="${state.batchMoveTargetFolderId === option.id ? "true" : "false"}">
              ${escapeHtml(option.label)}
            </button>
          `).join("")}
        </div>
      </div>
      <button id="sessionBatchMoveButton" type="button">${escapeHtml(state.language === "zh-CN" ? "批量移动" : "Move selected")}</button>
      <button id="sessionClearSelectionButton" type="button">${escapeHtml(state.language === "zh-CN" ? "清空选择" : "Clear")}</button>
    </div>
    <div class="session-table-shell">
      <div class="session-table-head">
        <div class="session-table-cell session-table-check"></div>
        <div class="session-table-cell">${escapeHtml(translate(state.language, "session.tableName"))}</div>
        <div class="session-table-cell">${escapeHtml(translate(state.language, "session.tableFolder"))}</div>
        <div class="session-table-cell session-table-segments">${escapeHtml(translate(state.language, "session.tableSegments"))}</div>
        <div class="session-table-cell session-table-updated">${escapeHtml(translate(state.language, "session.tableUpdated"))}</div>
        <div class="session-table-cell">${escapeHtml(translate(state.language, "session.tableStatus"))}</div>
        <div class="session-table-cell session-table-actions">${escapeHtml(translate(state.language, "session.tableActions"))}</div>
      </div>
      <div class="session-table-body">
        ${sessionRows || `<div class="session-table-empty">${escapeHtml(translate(state.language, "sidebar.sessionsEmpty"))}</div>`}
      </div>
    </div>
  `;

  elements.sessionList.querySelectorAll("button[data-session-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      await openSessionFromList(button.dataset.sessionId);
    });
  });

  elements.sessionList.querySelectorAll("button[data-session-preview-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      await openSessionPreview(button.dataset.sessionPreviewId);
    });
  });

  elements.sessionList.querySelectorAll("button[data-session-rename-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      await renameSessionFromList(button.dataset.sessionRenameId);
    });
  });

  elements.sessionList.querySelectorAll("input[data-session-select-id]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      toggleSessionSelection(checkbox.dataset.sessionSelectId, checkbox.checked);
      renderSessionList();
    });
  });

  const selectAll = elements.sessionList.querySelector("#sessionSelectAll");
  if (selectAll instanceof HTMLInputElement) {
    selectAll.addEventListener("change", () => {
      const next = new Set(state.selectedSessionIds);
      for (const sessionId of visibleSessionIds) {
        if (selectAll.checked) {
          next.add(sessionId);
        } else {
          next.delete(sessionId);
        }
      }
      setSelectedSessionIds(Array.from(next));
      renderSessionList();
    });
  }

  const batchMoveButton = elements.sessionList.querySelector("#sessionBatchMoveButton");
  if (batchMoveButton instanceof HTMLButtonElement) {
    batchMoveButton.addEventListener("click", () => {
      const targetFolderId = state.batchMoveTargetFolderId;
      if (!targetFolderId || state.selectedSessionIds.length === 0) {
        return;
      }

      moveSessionsToFolder(state.selectedSessionIds, targetFolderId);
      state.batchMoveTargetFolderId = "";
      clearSessionSelection();
      renderSessionList();
    });
  }

  const clearSelectionButton = elements.sessionList.querySelector("#sessionClearSelectionButton");
  if (clearSelectionButton instanceof HTMLButtonElement) {
    clearSelectionButton.addEventListener("click", () => {
      clearSessionSelection();
      renderSessionList();
    });
  }

  elements.sessionList.querySelectorAll("[data-session-row-id]").forEach((row) => {
    row.addEventListener("dragstart", (event) => {
      const sessionId = row.dataset.sessionRowId ?? "";
      if (!sessionId) {
        return;
      }

      state.draggingSessionId = sessionId;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/session-id", sessionId);
      }
      row.classList.add("dragging");
    });

    row.addEventListener("dragend", () => {
      state.draggingSessionId = "";
      row.classList.remove("dragging");
      document.querySelectorAll(".folder-strip-item.drop-target").forEach((item) => item.classList.remove("drop-target"));
    });
  });

  const searchInput = elements.sessionList.querySelector("#sessionSearchInput");
  if (searchInput instanceof HTMLInputElement) {
    searchInput.addEventListener("input", () => {
      state.folderSessionSearch = searchInput.value;
      renderSessionList();
    });
  }

  const filterPopdown = elements.sessionList.querySelector('[data-queue-popdown="filter"]');
  const movePopdown = elements.sessionList.querySelector('[data-queue-popdown="move"]');
  const filterTrigger = elements.sessionList.querySelector("#sessionFolderFilterTrigger");
  const moveTrigger = elements.sessionList.querySelector("#sessionBatchMoveTrigger");
  const listenerCleanup = [];

  const setQueuePopdownOpen = (name, shouldOpen) => {
    const entries = [
      { name: "filter", node: filterPopdown, trigger: filterTrigger },
      { name: "move", node: movePopdown, trigger: moveTrigger }
    ];

    for (const entry of entries) {
      if (!(entry.node instanceof HTMLElement) || !(entry.trigger instanceof HTMLButtonElement)) {
        continue;
      }

      const open = shouldOpen && entry.name === name;
      entry.node.dataset.open = open ? "true" : "false";
      entry.trigger.setAttribute("aria-expanded", open ? "true" : "false");
    }
  };

  const bindListener = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    listenerCleanup.push(() => target.removeEventListener(type, handler, options));
  };

  if (filterTrigger instanceof HTMLButtonElement && filterPopdown instanceof HTMLElement) {
    bindListener(filterTrigger, "click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setQueuePopdownOpen("filter", filterPopdown.dataset.open !== "true");
    });
  }

  if (moveTrigger instanceof HTMLButtonElement && movePopdown instanceof HTMLElement) {
    bindListener(moveTrigger, "click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setQueuePopdownOpen("move", movePopdown.dataset.open !== "true");
    });
  }

  elements.sessionList.querySelectorAll("button[data-filter-option]").forEach((button) => {
    bindListener(button, "click", () => {
      state.folderSessionFolderFilter = button.dataset.filterOption ?? "all";
      if (state.folderSessionFolderFilter !== "all") {
        state.activeProjectFolderId = state.folderSessionFolderFilter;
        renderFolderList();
      }
      renderSessionList();
    });
  });

  elements.sessionList.querySelectorAll("button[data-move-option]").forEach((button) => {
    bindListener(button, "click", () => {
      state.batchMoveTargetFolderId = button.dataset.moveOption ?? "";
      renderSessionList();
    });
  });

  bindListener(document, "click", (event) => {
    const target = event.target;
    if (!(target instanceof Node)) {
      setQueuePopdownOpen("", false);
      return;
    }

    if ((filterPopdown instanceof Node && filterPopdown.contains(target))
      || (movePopdown instanceof Node && movePopdown.contains(target))) {
      return;
    }

    setQueuePopdownOpen("", false);
  }, true);

  bindListener(document, "keydown", (event) => {
    if (event.key === "Escape") {
      setQueuePopdownOpen("", false);
    }
  });

  state.sessionListCleanup = () => {
    for (const dispose of listenerCleanup) {
      dispose();
    }
  };

  renderSessionPreviewDrawer();
}

async function loadSessions() {
  try {
    const response = await fetch(`${elements.apiBaseUrl.value}/sessions`);
    const payload = await response.json();
    state.sessions = payload.sessions ?? [];
    renderResumeState();
    renderFolderList();
    renderSessionList();
    renderSessionPreviewDrawer();
  } catch (error) {
    appendEvent("sessions.load_error", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function renderTranscriptViews() {
  const visibleSegments = state.historyMode === "replay"
    ? orderedSourceSegments()
    : orderedSourceSegments().slice(-LIVE_TRANSCRIPT_WINDOW);
  if (state.workspaceMode !== "live") {
    const sourceHtml = visibleSegments.map((segment) => `
      <div class="transcript-item">
        <div class="meta">#${escapeHtml(segment.sequence)} - ${escapeHtml(segment.status)}</div>
        <div>${escapeHtml(segment.text)}</div>
      </div>
    `).join("");

    const translationHtml = visibleSegments.map((segment) => {
      const translation = translationBySegmentId(segment.segmentId);

      return `
        <div class="transcript-item">
          <div class="meta">#${escapeHtml(segment.sequence)} - ${escapeHtml(translation?.targetLanguage ?? "pending")}</div>
          <div>${translation?.text
            ? escapeHtml(translation.text)
            : `<em>${escapeHtml(translate(state.language, "workspace.translationPending"))}</em>`}</div>
        </div>
      `;
    }).join("");

    elements.sourceTranscriptList.innerHTML = sourceHtml || `<div class="transcript-item">${translate(state.language, "workspace.sourceEmpty")}</div>`;
    elements.translationTranscriptList.innerHTML = translationHtml || `<div class="transcript-item">${translate(state.language, "workspace.translationEmpty")}</div>`;
  } else {
    elements.sourceTranscriptList.textContent = "";
    elements.translationTranscriptList.textContent = "";
  }

  renderConversationFeed();
  renderCurrentSpeech();
  renderReplayInspector();
}

function renderSummary() {
  const finalSegments = orderedSourceSegments().filter((segment) => segment.status === "final");

  if (finalSegments.length === 0) {
    elements.summaryStatus.textContent = translate(state.language, "summary.waiting");
    elements.summaryList.innerHTML = `<div class="transcript-item">${translate(state.language, "summary.empty")}</div>`;
    return;
  }

  const bullets = finalSegments.slice(-4).map((segment) => {
    const translation = translationBySegmentId(segment.segmentId);

    return `
      <div class="transcript-item">
        <div class="meta">Focus #${escapeHtml(segment.sequence)}</div>
        <div>${escapeHtml(segment.text)}</div>
        ${translation?.text ? `<div class="meta">${escapeHtml(translation.text)}</div>` : ""}
      </div>
    `;
  }).join("");

  elements.summaryStatus.textContent = translate(state.language, "summary.template", {
    count: finalSegments.length
  });
  elements.summaryList.innerHTML = bullets;
}

function renderReplayInspector() {
  if (!(elements.replayInspector instanceof HTMLElement)) {
    return;
  }

  const segments = orderedSourceSegments();
  const sessionId = elements.sessionId?.value.trim() || "";

  if (state.historyMode !== "replay" || segments.length === 0) {
    elements.replayInspector.hidden = true;
    elements.replayInspector.innerHTML = "";
    return;
  }

  const keywords = replayKeywordsFromSegments(segments);
  const minSequence = segments[0]?.sequence ?? 1;
  const maxSequence = segments[segments.length - 1]?.sequence ?? minSequence;
  const focusedSequence = Math.min(
    maxSequence,
    Math.max(minSequence, state.replayFocusedSequence || minSequence)
  );
  const matches = segments.filter((segment) => {
    const translation = translationBySegmentId(segment.segmentId);
    return segmentMatchesQuery(segment, translation, state.replaySearchQuery);
  });
  const matchCount = matches.length;

  elements.replayInspector.hidden = false;
  elements.replayInspector.innerHTML = `
    <div class="replay-inspector-shell">
      <div class="replay-inspector-head">
        <div>
          <div class="status-kicker">${escapeHtml(state.language === "zh-CN" ? "回放导航" : "Replay Navigator")}</div>
          <strong>${escapeHtml(state.language === "zh-CN" ? `共 ${segments.length} 段` : `${segments.length} segments`)}</strong>
        </div>
        <div class="preview-chip-row">
          <span class="preview-chip">${escapeHtml(state.language === "zh-CN" ? `命中 ${matchCount}` : `${matchCount} matches`)}</span>
          ${sessionId ? `<button class="session-open-button secondary" data-replay-rename="${escapeHtml(sessionId)}" type="button">${escapeHtml(translate(state.language, "session.actionRename"))}</button>` : ""}
        </div>
      </div>
      <div class="replay-inspector-grid">
        <div class="replay-search-row">
          <input id="replaySearchInput" type="search" value="${escapeHtml(state.replaySearchQuery)}" placeholder="${escapeHtml(state.language === "zh-CN" ? "关键词跳转原文或译文" : "Jump by source or translation keyword")}" />
          <button id="replaySearchButton" type="button">${escapeHtml(state.language === "zh-CN" ? "跳转" : "Jump")}</button>
        </div>
        <div class="replay-range-row">
          <span>${escapeHtml(state.language === "zh-CN" ? "时间轴" : "Timeline")}</span>
          <input id="replayTimelineRange" type="range" min="${escapeHtml(String(minSequence))}" max="${escapeHtml(String(maxSequence))}" value="${escapeHtml(String(focusedSequence))}" />
          <strong>#${escapeHtml(String(focusedSequence))}</strong>
        </div>
      </div>
      ${keywords.length > 0 ? `
        <div class="replay-keyword-row">
          ${keywords.map((keyword) => `<button class="preview-keyword-chip" data-replay-keyword="${escapeHtml(keyword)}" type="button">${escapeHtml(keyword)}</button>`).join("")}
        </div>
      ` : ""}
    </div>
  `;

  const jumpToSequence = (sequence) => {
    const nextSequence = Number(sequence);
    if (!Number.isFinite(nextSequence)) {
      return;
    }
    state.replayFocusedSequence = nextSequence;
    renderReplayInspector();
    renderConversationFeed();
  };

  const jumpToSearch = () => {
    const firstMatch = matches[0];
    if (!firstMatch) {
      return;
    }
    jumpToSequence(firstMatch.sequence);
  };

  elements.replayInspector.querySelector("#replaySearchInput")?.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    state.replaySearchQuery = target.value;
    renderReplayInspector();
    renderConversationFeed();
  });
  elements.replayInspector.querySelector("#replaySearchButton")?.addEventListener("click", jumpToSearch);
  elements.replayInspector.querySelector("#replayTimelineRange")?.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    jumpToSequence(target.value);
  });
  elements.replayInspector.querySelectorAll("[data-replay-keyword]").forEach((button) => {
    button.addEventListener("click", () => {
      state.replaySearchQuery = button.getAttribute("data-replay-keyword") ?? "";
      renderReplayInspector();
      renderConversationFeed();
      jumpToSearch();
    });
  });
  elements.replayInspector.querySelector("[data-replay-rename]")?.addEventListener("click", async () => {
    await renameSessionFromList(sessionId);
    renderReplayInspector();
  });
}

function renderAudioClips() {
  const html = orderedAudioClips().map((clip) => `
    <div class="audio-item">
      <div class="meta">#${escapeHtml(clip.sequence)} - ${escapeHtml(audioClipDisplayLabel(clip))} - ${escapeHtml(formatBytes(clip.byteLength))}</div>
      <audio controls src="data:${escapeHtml(clip.mimeType)};base64,${escapeHtml(clip.dataBase64)}"></audio>
    </div>
  `).join("");

  elements.audioClipList.innerHTML = html || `<div class="audio-item">${translate(state.language, "audio.empty")}</div>`;
}

function publishOverlayState() {
  publishPreviewState(channel, {
    type: "state",
    payload: {
      sourceSegments: orderedSourceSegments().slice(-4),
      translations: orderedTranslations().slice(-4)
    }
  });
}

function updateFromReplay(replay) {
  resetReplayState();

  for (const segment of replay.segments ?? []) {
    state.sourceSegments.set(segment.segmentId, segment);
  }

  for (const translation of replay.translations ?? []) {
    const segment = state.sourceSegments.get(translation.segmentId);
    const nextTranslation = {
      ...translation,
      sequence: segment?.sequence ?? Number.MAX_SAFE_INTEGER
    };
    state.translations.set(`${translation.segmentId}:${translation.targetLanguage}`, nextTranslation);
  }

  for (const audioClip of replay.audioClips ?? []) {
    state.audioClips.set(audioClip.audioClipId, audioClip);
  }

  markCollectionsDirty();
  rebuildPrimaryTranslations();
  renderTranscriptViews();
  renderSummary();
  renderAudioClips();
  renderReplayInspector();
  if ((replay.segments?.length ?? 0) > 0 || (replay.translations?.length ?? 0) > 0 || (replay.audioClips?.length ?? 0) > 0) {
    enterLiveWorkspace();
  }
  publishOverlayState();
}

function applyLanguage(language) {
  state.language = language;
  document.documentElement.lang = language;
  setStoredLanguage(language);
  applyI18n(document, language);
  syncSessionActionButtons();
  renderLanguageSelectors();
  syncRecordingLanguageChips();
  renderDeviceOptions();
  syncLanguageButton();
  syncSidebarCollapseState();
  if (elements.undoToastUndoButton) {
    elements.undoToastUndoButton.textContent = state.language === "zh-CN" ? "撤销" : "Undo";
  }
  if (elements.undoToastCloseButton) {
    elements.undoToastCloseButton.textContent = state.language === "zh-CN" ? "关闭" : "Close";
  }
  renderResumeState();
  renderLibraryPanel();
  renderFolderList();
  renderSessionList();
  renderTranscriptViews();
  renderSummary();
  renderAudioClips();
  renderReplayInspector();
  syncPauseButton();
  updateLiveLatencyBadge();
  if (!elements.sessionId.value.trim()) {
    elements.sessionInfo.textContent = translate(state.language, "session.empty");
  }
  syncWorkspaceLayout();
  publishPreviewState(channel, {
    type: "language",
    language
  });
}

async function refreshGatewayHealth() {
  try {
    const response = await fetch(`${elements.gatewayBaseUrl.value}/health`);
    const payload = await response.json();
    const configured = payload.asrProvider ?? "unknown";
    const active = payload.activeProvider ?? configured;
    const fallback = payload.fallbackProvider ? ` / fallback ${payload.fallbackProvider}` : "";
    const suffix = active !== configured ? ` / active ${active}` : "";
    setPill(elements.gatewayStatus, `Gateway provider: ${configured}${suffix}${fallback}`);
  } catch (error) {
    setPill(elements.gatewayStatus, "Gateway provider: unavailable", "warn");
    appendEvent("gateway.health_error", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function createSession() {
  const response = await fetch(`${elements.apiBaseUrl.value}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
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
      deviceSelection: {
        sourceKind: "microphone"
      }
    })
  });

  const session = await response.json();
  elements.sessionId.value = session.id;
  elements.sessionInfo.textContent = translate(state.language, "session.created");
  applySessionConfiguration(session);
  syncSessionActionButtons();
  const assignedFolderId = activeProjectFolder()?.id ?? "";
  if (assignedFolderId) {
    state.folderAssignments[session.id] = assignedFolderId;
  } else {
    delete state.folderAssignments[session.id];
  }
  saveFolderAssignments();
  rememberRecentSession(session.id);
  appendEvent("session.created", session);
  resetReplayState();
  await loadSessions();
  return session.id;
}

async function ensureSessionId() {
  return elements.sessionId.value.trim() || createSession();
}

function applyRealtimeEnvelope(envelope) {
  let shouldRenderTranscripts = false;
  let shouldRenderSummary = false;
  let shouldRenderAudio = false;
  let shouldRenderOverlay = false;
  const eventReceivedPerfAt = performance.now();
  const emittedEpochMs = Date.parse(envelope.emittedAt ?? "");
  const hasEmittedEpoch = Number.isFinite(emittedEpochMs);

  if (state.capture) {
    state.capture.performance.eventCount += 1;
  }

  if (envelope.type === "segment.upserted") {
    state.sourceSegments.set(envelope.payload.segmentId, envelope.payload);
    if (typeof envelope.payload.text === "string" && envelope.payload.text.trim().length > 0) {
      state.liveNow.sourceText = envelope.payload.text;
      state.liveNow.sourceEventPerfAt = eventReceivedPerfAt;
      state.liveNow.sourceEventEpochMs = hasEmittedEpoch ? emittedEpochMs : 0;
    }
    markCollectionsDirty();
    shouldRenderTranscripts = true;
    shouldRenderOverlay = true;
    shouldRenderSummary = envelope.payload.status === "final";
  }

  if (envelope.type === "translation.upserted") {
    const segment = state.sourceSegments.get(envelope.payload.segmentId);
    const nextTranslation = {
      ...envelope.payload,
      sequence: segment?.sequence ?? Number.MAX_SAFE_INTEGER
    };
    state.translations.set(`${envelope.payload.segmentId}:${envelope.payload.targetLanguage}`, nextTranslation);
    syncPrimaryTranslation(nextTranslation);
    if (typeof envelope.payload.text === "string" && envelope.payload.text.trim().length > 0) {
      state.liveNow.translationText = envelope.payload.text;
      state.liveNow.translationEventPerfAt = eventReceivedPerfAt;
      state.liveNow.translationEventEpochMs = hasEmittedEpoch ? emittedEpochMs : 0;
    }
    markCollectionsDirty();
    shouldRenderTranscripts = true;
    shouldRenderOverlay = true;
    shouldRenderSummary = segment?.status === "final";
  }

  if (envelope.type === "audio.clip_received") {
    state.audioClips.set(envelope.payload.audioClipId, envelope.payload);
    markCollectionsDirty();
    shouldRenderAudio = true;
  }

  if (shouldRenderTranscripts || shouldRenderSummary || shouldRenderAudio) {
    trimLiveStateMemory();
  }

  if (shouldRenderTranscripts || shouldRenderSummary || shouldRenderAudio || shouldRenderOverlay) {
    scheduleWorkspaceRender({
      transcripts: shouldRenderTranscripts,
      summary: shouldRenderSummary,
      audio: shouldRenderAudio,
      overlay: shouldRenderOverlay
    });
  }
}

function clearStreamRetryTimer() {
  if (state.streamRetryTimerId) {
    window.clearTimeout(state.streamRetryTimerId);
    state.streamRetryTimerId = null;
  }
}

function clearStreamWatchdogTimer() {
  if (state.streamWatchdogTimerId) {
    window.clearInterval(state.streamWatchdogTimerId);
    state.streamWatchdogTimerId = null;
  }
}

function disconnectCurrentStream() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }

  clearStreamRetryTimer();
  clearStreamWatchdogTimer();
  state.streamRetryAttempt = 0;
  state.lastStreamEventAt = 0;
  state.streamSessionId = null;
}

function startStreamWatchdog(sessionId) {
  clearStreamWatchdogTimer();
  state.streamWatchdogTimerId = window.setInterval(() => {
    if (!state.eventSource || state.streamSessionId !== sessionId) {
      return;
    }

    const now = Date.now();
    if (now - state.lastStreamEventAt < STREAM_STALE_RECONNECT_MS) {
      return;
    }

    scheduleStreamReconnect(sessionId);
  }, STREAM_WATCHDOG_INTERVAL_MS);
}

function scheduleStreamReconnect(sessionId) {
  if (!sessionId || elements.sessionId.value.trim() !== sessionId) {
    return;
  }

  if (state.streamRetryTimerId) {
    return;
  }

  const delayMs = Math.min(
    STREAM_RETRY_MAX_MS,
    Math.round(STREAM_RETRY_BASE_MS * (2 ** Math.min(6, state.streamRetryAttempt)))
  );
  state.streamRetryAttempt += 1;
  state.streamRetryTimerId = window.setTimeout(() => {
    state.streamRetryTimerId = null;
    connectStream({ force: true });
  }, delayMs);
}

function connectStream(options = {}) {
  const sessionId = elements.sessionId.value.trim();
  const force = Boolean(options.force);

  if (!sessionId) {
    alert(translate(state.language, "alerts.missingSession"));
    return;
  }

  state.historyMode = "live";
  rememberRecentSession(sessionId);

  if (state.eventSource && state.eventSource.readyState === EventSource.CLOSED) {
    state.eventSource.close();
    state.eventSource = null;
    state.streamSessionId = null;
  }

  if (state.eventSource && state.streamSessionId === sessionId && !force) {
    if (state.eventSource.readyState === EventSource.OPEN) {
      return;
    }

    state.eventSource.close();
    state.eventSource = null;
    state.streamSessionId = null;
  }

  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }

  state.eventSource = new EventSource(`${elements.gatewayBaseUrl.value}/sessions/${sessionId}/stream`);
  state.streamSessionId = sessionId;
  state.lastStreamEventAt = Date.now();
  clearStreamRetryTimer();
  startStreamWatchdog(sessionId);
  enterLiveWorkspace();
  state.eventSource.onopen = () => {
    state.streamRetryAttempt = 0;
    state.lastStreamEventAt = Date.now();
    clearStreamRetryTimer();
  };
  state.eventSource.onmessage = (event) => {
    state.lastStreamEventAt = Date.now();
    const envelope = JSON.parse(event.data);
    appendEvent(envelope.type, envelope.payload);
    applyRealtimeEnvelope(envelope);
  };
  state.eventSource.onerror = () => {
    setPill(elements.gatewayStatus, "Gateway provider: stream disconnected", "warn");

    if (!state.eventSource) {
      return;
    }

    if (state.eventSource.readyState === EventSource.CLOSED) {
      state.eventSource.close();
      state.eventSource = null;
      state.streamSessionId = null;
      scheduleStreamReconnect(sessionId);
      return;
    }

    scheduleStreamReconnect(sessionId);
  };
}

async function sendText() {
  const sessionId = await ensureSessionId();
  state.historyMode = "live";
  rememberRecentSession(sessionId);
  enterLiveWorkspace();
  connectStream();
  const response = await fetch(`${elements.gatewayBaseUrl.value}/sessions/${sessionId}/ingest-text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
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
    alert(translate(state.language, "alerts.missingSession"));
    return;
  }

  const response = await fetch(`${elements.apiBaseUrl.value}/sessions/${sessionId}/replay`);
  const replay = await response.json();
  state.previewReplayCache.set(sessionId, replay);
  applySessionConfiguration(replay.session);
  syncSessionInsightFromReplay(sessionId, replay);
  state.historyMode = "replay";
  rememberRecentSession(sessionId);
  updateFromReplay(replay);
  if (state.pendingReplayFocusSequence > 0) {
    state.replayFocusedSequence = state.pendingReplayFocusSequence;
    state.pendingReplayFocusSequence = 0;
    renderReplayInspector();
    renderConversationFeed();
  }
  syncSessionActionButtons();
  renderSessionList();
}

function renderDeviceOptions() {
  if (!elements.microphoneSelect) {
    return;
  }

  const previousValue = elements.microphoneSelect.value;
  elements.microphoneSelect.innerHTML = "";

  if (state.devices.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = translate(state.language, "device.none");
    elements.microphoneSelect.append(option);
    elements.microphoneSelect.value = "";
    renderMicrophonePopdown();
    return;
  }

  for (const [index, device] of state.devices.entries()) {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || `${translate(state.language, "device.microphone")} ${index + 1}`;
    elements.microphoneSelect.append(option);
  }

  if (previousValue && state.devices.some((device) => device.deviceId === previousValue)) {
    elements.microphoneSelect.value = previousValue;
  } else {
    elements.microphoneSelect.value = state.devices[0]?.deviceId ?? "";
  }

  renderMicrophonePopdown();
}

function setPopdownOpen(name, isOpen) {
  state.activePopdown = isOpen ? name : null;

  const entries = [
    { name: "microphone", popdown: elements.microphonePopdown, trigger: elements.microphonePopdownTrigger },
    { name: "sourceLanguage", popdown: elements.sourceLanguagePopdown, trigger: elements.sourceLanguagePopdownTrigger },
    { name: "targetLanguages", popdown: elements.targetLanguagesPopdown, trigger: elements.targetLanguagesPopdownTrigger }
  ];

  for (const entry of entries) {
    const open = state.activePopdown === entry.name;
    entry.popdown?.setAttribute("data-open", open ? "true" : "false");
    entry.trigger?.setAttribute("aria-expanded", open ? "true" : "false");
  }
}

function renderSelectPopdown({ select, trigger, panel, popdownName, fallbackLabel, canOpenPredicate, metaBuilder, onSelect }) {
  if (!(select instanceof HTMLSelectElement) || !trigger || !panel) {
    return;
  }

  const options = Array.from(select.options).map((option, index) => ({
    value: option.value,
    label: option.textContent ?? "",
    index
  }));

  if (options.length > 0 && !options.some((option) => option.value === select.value)) {
    select.value = options[0].value;
  }

  const selectedValue = select.value;
  const selectedOption = options.find((option) => option.value === selectedValue) ?? options[0] ?? null;
  const label = selectedOption?.label || fallbackLabel;
  const canOpen = canOpenPredicate ? canOpenPredicate(options) : options.length > 0;

  if (!canOpen && state.activePopdown === popdownName) {
    setPopdownOpen(popdownName, false);
  } else {
    setPopdownOpen(popdownName, state.activePopdown === popdownName);
  }

  trigger.innerHTML = `<span>${escapeHtml(label)}</span>`;
  trigger.title = label;
  trigger.disabled = !canOpen;

  panel.innerHTML = options.map((option) => `
    <button class="device-popdown-option ${option.value === selectedValue ? "active" : ""}" data-value="${escapeHtml(option.value)}" role="option" aria-selected="${option.value === selectedValue ? "true" : "false"}" type="button">
      <span class="device-popdown-option-title">${escapeHtml(option.label)}</span>
      <span class="device-popdown-option-meta">${escapeHtml(metaBuilder ? metaBuilder(option) : option.value.toUpperCase())}</span>
    </button>
  `).join("");

  panel.querySelectorAll("button[data-value]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextValue = button.dataset.value ?? "";
      select.value = nextValue;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      onSelect?.(nextValue);
      setPopdownOpen(popdownName, false);
    });
  });
}

function renderMicrophonePopdown() {
  renderSelectPopdown({
    select: elements.microphoneSelect,
    trigger: elements.microphonePopdownTrigger,
    panel: elements.microphonePopdownPanel,
    popdownName: "microphone",
    fallbackLabel: translate(state.language, "device.none"),
    canOpenPredicate: (options) => options.some((option) => Boolean(option.value)),
    metaBuilder: (option) => option.value ? `${translate(state.language, "device.microphone")} ${option.index + 1}` : translate(state.language, "device.none")
  });
}

function renderSourceLanguagePopdown() {
  renderSelectPopdown({
    select: elements.sourceLanguage,
    trigger: elements.sourceLanguagePopdownTrigger,
    panel: elements.sourceLanguagePopdownPanel,
    popdownName: "sourceLanguage",
    fallbackLabel: translate(state.language, "label.sourceLanguage"),
    metaBuilder: (option) => option.value.toUpperCase()
  });
}

function renderTargetLanguagesPopdown() {
  renderSelectPopdown({
    select: elements.targetLanguages,
    trigger: elements.targetLanguagesPopdownTrigger,
    panel: elements.targetLanguagesPopdownPanel,
    popdownName: "targetLanguages",
    fallbackLabel: translate(state.language, "label.targetLanguages"),
    metaBuilder: (option) => option.value.toUpperCase()
  });
}

function normalizeAudioInputLabel(label) {
  return String(label ?? "")
    .trim()
    .replace(/^(default|communications)\s*-\s*/i, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isVirtualAudioInputId(deviceId) {
  const value = String(deviceId ?? "").toLowerCase();
  return value === "default" || value === "communications";
}

function dedupeAudioInputDevices(devices) {
  const audioInputs = devices.filter((device) => device.kind === "audioinput");
  const grouped = new Map();

  for (const device of audioInputs) {
    const cleanLabel = normalizeAudioInputLabel(device.label);
    const groupKey = device.groupId
      ? `group:${device.groupId}`
      : (cleanLabel ? `label:${cleanLabel}` : `id:${device.deviceId}`);
    const bucket = grouped.get(groupKey) ?? [];
    bucket.push(device);
    grouped.set(groupKey, bucket);
  }

  const deduped = [];
  for (const bucket of grouped.values()) {
    const preferred = bucket.find((item) => !isVirtualAudioInputId(item.deviceId) && String(item.label ?? "").trim().length > 0)
      ?? bucket.find((item) => !isVirtualAudioInputId(item.deviceId))
      ?? bucket[0];
    deduped.push(preferred);
  }

  deduped.sort((left, right) => {
    const leftLabel = normalizeAudioInputLabel(left.label);
    const rightLabel = normalizeAudioInputLabel(right.label);
    return leftLabel.localeCompare(rightLabel);
  });

  return deduped;
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    setPill(elements.shellStatus, translate(state.language, "device.unsupported"), "warn");
    return;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  state.devices = dedupeAudioInputDevices(devices);
  renderDeviceOptions();

  if (state.devices.length === 0) {
    setPill(elements.shellStatus, translate(state.language, "device.none"), "warn");
    return;
  }

  setPill(elements.shellStatus, translate(state.language, "device.loaded", {
    count: state.devices.length
  }));
}

async function requestMicrophoneAccess() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setPill(elements.permissionStatus, translate(state.language, "permission.unsupported"), "warn");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    setPill(elements.permissionStatus, translate(state.language, "permission.granted"));
    await refreshDevices();
  } catch (error) {
    setPill(elements.permissionStatus, translate(state.language, "permission.denied"), "warn");
    appendEvent("device.permission_error", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

function chooseMimeType() {
  if (!window.MediaRecorder) {
    return "";
  }

  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus"
  ];

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function encodingFromMimeType(mimeType) {
  return mimeType.includes("opus") ? "opus" : "unknown";
}

function downsampleBuffer(channelData, inputSampleRate, outputSampleRate) {
  if (outputSampleRate >= inputSampleRate) {
    return channelData;
  }

  const ratio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(channelData.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;

    for (let index = offsetBuffer; index < nextOffsetBuffer && index < channelData.length; index += 1) {
      accum += channelData[index];
      count += 1;
    }

    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function floatTo16BitPCM(floatBuffer) {
  const output = new Int16Array(floatBuffer.length);

  for (let index = 0; index < floatBuffer.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, floatBuffer[index]));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return new Uint8Array(output.buffer);
}

function concatUint8Arrays(buffers) {
  const totalLength = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const buffer of buffers) {
    result.set(buffer, offset);
    offset += buffer.length;
  }

  return result;
}

function pcmDurationMsFromByteLength(byteLength) {
  return Math.round((byteLength / (PCM_BYTES_PER_SAMPLE * PCM_CHANNEL_COUNT) / PCM_SAMPLE_RATE_HZ) * 1000);
}

function pcmRmsFromBytes(body) {
  if (!(body instanceof Uint8Array) || body.length < 2) {
    return 0;
  }

  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let sum = 0;
  let count = 0;

  for (let offset = 0; offset + 1 < body.byteLength; offset += 2) {
    const sample = view.getInt16(offset, true) / 0x7fff;
    sum += sample * sample;
    count += 1;
  }

  return count > 0 ? Math.sqrt(sum / count) : 0;
}

function createPendingUploadChunk(body, durationMs = pcmDurationMsFromByteLength(body.length)) {
  const rms = pcmRmsFromBytes(body);
  return {
    body,
    durationMs,
    rms,
    isSpeechLike: rms >= VAD_SPEECH_RMS_THRESHOLD
  };
}

function mergePendingUploadChunks(left, right) {
  const mergedBody = concatUint8Arrays([left.body, right.body]);
  return {
    body: mergedBody,
    durationMs: left.durationMs + right.durationMs,
    rms: Math.max(left.rms ?? 0, right.rms ?? 0),
    isSpeechLike: Boolean(left.isSpeechLike || right.isSpeechLike)
  };
}

function updateVadState(capture, pendingChunk) {
  if (!capture?.vad || !pendingChunk) {
    return pendingChunk;
  }

  const rms = pendingChunk.rms ?? 0;
  const threshold = capture.vad.voiceActive ? VAD_SILENCE_RMS_THRESHOLD : VAD_SPEECH_RMS_THRESHOLD;
  pendingChunk.isSpeechLike = rms >= threshold;

  if (pendingChunk.isSpeechLike) {
    capture.vad.hasDetectedSpeech = true;
    capture.vad.voiceActive = true;
    capture.vad.silentChunkStreak = 0;
  } else {
    capture.vad.silentChunkStreak += 1;
    if (capture.vad.silentChunkStreak > VAD_HANGOVER_CHUNKS) {
      capture.vad.voiceActive = false;
    }
  }

  return pendingChunk;
}

function queueAdaptiveChunk(capture, pendingChunk) {
  const nextChunk = updateVadState(capture, pendingChunk);

  if (!capture.vad.hasDetectedSpeech && !nextChunk.isSpeechLike) {
    capture.vad.leadingSilenceDropped += 1;
    return false;
  }

  capture.pendingChunks.push(nextChunk);
  return true;
}

function archiveCapturedPcm(capture, bytes) {
  if (!capture || !(bytes instanceof Uint8Array) || bytes.length === 0) {
    return;
  }

  capture.recordedPcmChunks.push(bytes);
}

function nextAdaptiveBatchChunkCount(capture, pendingChunk) {
  if (capture.queueState === "protect") {
    return pendingChunk.isSpeechLike ? 2 : 4;
  }

  if (capture.queueState === "warning") {
    return pendingChunk.isSpeechLike ? 1 : 3;
  }

  return pendingChunk.isSpeechLike ? 1 : 2;
}

function shiftAdaptiveUploadChunk(capture) {
  const first = capture.pendingChunks.shift();

  if (!first) {
    return null;
  }

  let merged = first;
  let remainingMergeCount = nextAdaptiveBatchChunkCount(capture, first) - 1;

  while (remainingMergeCount > 0 && capture.pendingChunks.length > 0) {
    const next = capture.pendingChunks[0];

    if (merged.body.length + next.body.length > MAX_MERGED_UPLOAD_CHUNK_BYTES) {
      break;
    }

    if (first.isSpeechLike && next.isSpeechLike && capture.queueState === "steady") {
      break;
    }

    merged = mergePendingUploadChunks(merged, capture.pendingChunks.shift());
    remainingMergeCount -= 1;
  }

  return merged;
}

function compactPendingUploadQueue(capture, targetLength = UPLOAD_QUEUE_TARGET_AFTER_PROTECT) {
  let didCompact = false;

  while (capture.pendingChunks.length > targetLength) {
    let merged = false;

    for (let index = 0; index < capture.pendingChunks.length - 1; index += 1) {
      const left = capture.pendingChunks[index];
      const right = capture.pendingChunks[index + 1];

      if (left.body.length + right.body.length > MAX_MERGED_UPLOAD_CHUNK_BYTES) {
        continue;
      }

      capture.pendingChunks.splice(index, 2, mergePendingUploadChunks(left, right));
      merged = true;
      didCompact = true;
      break;
    }

    if (!merged) {
      break;
    }
  }

  return didCompact;
}

function applyUploadQueuePressure(capture) {
  const queueLength = capture.pendingChunks.length;
  let nextQueueState = "steady";

  if (queueLength >= UPLOAD_QUEUE_PROTECT_THRESHOLD) {
    compactPendingUploadQueue(capture);
    nextQueueState = capture.pendingChunks.length >= UPLOAD_QUEUE_PROTECT_THRESHOLD ? "protect" : "warning";
  } else if (queueLength >= UPLOAD_QUEUE_WARN_THRESHOLD) {
    nextQueueState = "warning";
  }

  if (capture.queueState !== nextQueueState) {
    if (nextQueueState === "warning") {
      appendEvent("capture.queue_warning", {
        queueLength: capture.pendingChunks.length,
        threshold: UPLOAD_QUEUE_WARN_THRESHOLD
      });
    }

    if (nextQueueState === "protect") {
      appendEvent("capture.queue_protect", {
        queueLength: capture.pendingChunks.length,
        threshold: UPLOAD_QUEUE_PROTECT_THRESHOLD
      });
    }

    if (capture.queueState !== "steady" && nextQueueState === "steady") {
      appendEvent("capture.queue_recovered", {
        queueLength: capture.pendingChunks.length
      });
    }
  }

  capture.queueState = nextQueueState;
}

function trimLiveStateMemory() {
  if (state.historyMode !== "live") {
    return;
  }

  const segments = orderedSourceSegments();

  if (segments.length > MAX_LIVE_SEGMENTS_IN_MEMORY) {
    const removedSegments = segments.slice(0, segments.length - MAX_LIVE_SEGMENTS_IN_MEMORY);
    const removedSegmentIds = new Set(removedSegments.map((segment) => segment.segmentId));

    for (const segmentId of removedSegmentIds) {
      state.sourceSegments.delete(segmentId);
      state.primaryTranslations.delete(segmentId);
    }

    for (const [key, translation] of state.translations.entries()) {
      if (removedSegmentIds.has(translation.segmentId)) {
        state.translations.delete(key);
      }
    }

    state.trimmedLiveData.segments += removedSegmentIds.size;
    markCollectionsDirty();
  }

  const audioClips = orderedAudioClips();

  if (audioClips.length > MAX_LIVE_AUDIO_CLIPS_IN_MEMORY) {
    const removedAudioClips = audioClips.slice(0, audioClips.length - MAX_LIVE_AUDIO_CLIPS_IN_MEMORY);

    for (const clip of removedAudioClips) {
      state.audioClips.delete(clip.audioClipId);
    }

    state.trimmedLiveData.audioClips += removedAudioClips.length;
    markCollectionsDirty();
  }
}

function createPcmWorkletModuleSource() {
  return `
class TtsPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options.processorOptions || {};
    this.outputSampleRate = processorOptions.outputSampleRate || 16000;
    this.chunkSizeBytes = processorOptions.chunkSizeBytes || 10240;
    this.levelUpdateIntervalFrames = Math.max(128, Math.round(sampleRate * ((processorOptions.levelUpdateIntervalMs || 80) / 1000)));
    this.nextLevelFrame = this.levelUpdateIntervalFrames;
    this.pendingByteChunks = [];
    this.pendingByteLength = 0;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "flush") {
        const remainder = this.concatUint8Arrays(this.pendingByteChunks);
        this.pendingByteChunks = [];
        this.pendingByteLength = 0;
        this.port.postMessage({ type: "flush", buffer: remainder.buffer }, [remainder.buffer]);
      }
    };
  }

  downsampleBuffer(channelData) {
    if (this.outputSampleRate >= sampleRate) {
      return new Float32Array(channelData);
    }

    const ratio = sampleRate / this.outputSampleRate;
    const newLength = Math.round(channelData.length / ratio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;

      for (let index = offsetBuffer; index < nextOffsetBuffer && index < channelData.length; index += 1) {
        accum += channelData[index];
        count += 1;
      }

      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult += 1;
      offsetBuffer = nextOffsetBuffer;
    }

    return result;
  }

  floatTo16BitPCM(floatBuffer) {
    const output = new Int16Array(floatBuffer.length);

    for (let index = 0; index < floatBuffer.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, floatBuffer[index]));
      output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    return new Uint8Array(output.buffer);
  }

  concatUint8Arrays(buffers) {
    const totalLength = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;

    for (const buffer of buffers) {
      result.set(buffer, offset);
      offset += buffer.length;
    }

    return result;
  }

  emitChunk(chunk) {
    this.port.postMessage({ type: "chunk", buffer: chunk.buffer }, [chunk.buffer]);
  }

  enqueueBytes(pcmBytes) {
    if (!pcmBytes.length) {
      return;
    }

    this.pendingByteChunks.push(pcmBytes);
    this.pendingByteLength += pcmBytes.length;

    while (this.pendingByteLength >= this.chunkSizeBytes) {
      const chunk = new Uint8Array(this.chunkSizeBytes);
      let writeOffset = 0;

      while (writeOffset < chunk.length) {
        const head = this.pendingByteChunks[0];
        const remaining = chunk.length - writeOffset;

        if (head.length <= remaining) {
          chunk.set(head, writeOffset);
          writeOffset += head.length;
          this.pendingByteChunks.shift();
        } else {
          chunk.set(head.subarray(0, remaining), writeOffset);
          this.pendingByteChunks[0] = head.subarray(remaining);
          writeOffset += remaining;
        }
      }

      this.pendingByteLength -= this.chunkSizeBytes;
      this.emitChunk(chunk);
    }
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];

    if (!input || input.length === 0) {
      return true;
    }

    if (currentFrame >= this.nextLevelFrame) {
      let sum = 0;

      for (let index = 0; index < input.length; index += 1) {
        const sample = input[index];
        sum += sample * sample;
      }

      const rms = Math.sqrt(sum / input.length);
      this.port.postMessage({ type: "level", level: Math.min(1, rms * 2.2) });
      this.nextLevelFrame = currentFrame + this.levelUpdateIntervalFrames;
    }

    const downsampled = this.downsampleBuffer(input);
    const pcmBytes = this.floatTo16BitPCM(downsampled);
    this.enqueueBytes(pcmBytes);
    return true;
  }
}

registerProcessor("${PCM_WORKLET_PROCESSOR_NAME}", TtsPcmCaptureProcessor);
`;
}

async function ensurePcmWorkletModule(audioContext) {
  if (!audioContext.audioWorklet) {
    throw new Error("AudioWorklet is not available in this browser.");
  }

  if (!pcmWorkletModuleUrl) {
    const blob = new Blob([createPcmWorkletModuleSource()], {
      type: "application/javascript"
    });
    pcmWorkletModuleUrl = URL.createObjectURL(blob);
  }

  await audioContext.audioWorklet.addModule(pcmWorkletModuleUrl);
}

function updateCaptureLevelFromBuffer(buffer, capture) {
  const now = performance.now();

  if (capture.levelLastPaintAt && now - capture.levelLastPaintAt < LEVEL_UPDATE_INTERVAL_MS) {
    return;
  }

  let sum = 0;

  for (let index = 0; index < buffer.length; index += 1) {
    const sample = buffer[index];
    sum += sample * sample;
  }

  const rms = Math.sqrt(sum / Math.max(1, buffer.length));
  setCaptureLevel(Math.min(1, rms * 2.2));
  capture.levelLastPaintAt = now;
}

function enqueuePcmChunk(capture, chunk) {
  if (!chunk.length) {
    return;
  }

  archiveCapturedPcm(capture, chunk);
  if (!queueAdaptiveChunk(capture, createPendingUploadChunk(chunk))) {
    return;
  }
  applyUploadQueuePressure(capture);
  refreshCapturePerformanceStatus(capture);
  pumpPcmQueue(capture).catch((error) => {
    appendEvent("capture.pcm_pump_error", {
      message: error instanceof Error ? error.message : String(error)
    });
  });
}

async function requestWorkletFlush(capture) {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      capture.resolveFlush = null;
      reject(new Error("AudioWorklet flush timed out."));
    }, PCM_WORKLET_FLUSH_TIMEOUT_MS);

    capture.resolveFlush = (remainder) => {
      window.clearTimeout(timeoutId);
      capture.resolveFlush = null;
      resolve(remainder);
    };

    capture.node.port.postMessage({ type: "flush" });
  });
}

async function pumpPcmQueue(capture) {
  if (capture.sending) {
    return;
  }

  capture.sending = true;

  try {
    while (capture.pendingChunks.length > 0) {
      const pendingChunk = shiftAdaptiveUploadChunk(capture);
      if (!pendingChunk) {
        break;
      }
      applyUploadQueuePressure(capture);
      await uploadChunk(capture.sessionId, pendingChunk.body, {
        chunkId: crypto.randomUUID(),
        sequence: capture.sequence,
        encoding: "pcm_s16le",
        sampleRateHz: PCM_SAMPLE_RATE_HZ,
        channels: PCM_CHANNEL_COUNT,
        durationMs: pendingChunk.durationMs,
        isFinalChunk: false,
        sourceLanguage: elements.sourceLanguage.value,
        targetLanguages: targetLanguages()
      });
      capture.sequence += 1;
      capture.performance.uploadCount += 1;
      refreshCapturePerformanceStatus(capture);
    }
  } finally {
    capture.sending = false;
  }
}

function enqueuePcmBytes(capture, pcmBytes) {
  if (!pcmBytes.length) {
    return;
  }

  archiveCapturedPcm(capture, pcmBytes);
  capture.pendingByteChunks.push(pcmBytes);
  capture.pendingByteLength += pcmBytes.length;

  while (capture.pendingByteLength >= capture.chunkSizeBytes) {
    const chunk = new Uint8Array(capture.chunkSizeBytes);
    let writeOffset = 0;

    while (writeOffset < chunk.length) {
      const head = capture.pendingByteChunks[0];
      const remaining = chunk.length - writeOffset;

      if (head.length <= remaining) {
        chunk.set(head, writeOffset);
        writeOffset += head.length;
        capture.pendingByteChunks.shift();
      } else {
        chunk.set(head.subarray(0, remaining), writeOffset);
        capture.pendingByteChunks[0] = head.subarray(remaining);
        writeOffset += remaining;
      }
    }

    capture.pendingByteLength -= capture.chunkSizeBytes;
    queueAdaptiveChunk(capture, createPendingUploadChunk(chunk));
  }

  applyUploadQueuePressure(capture);
  refreshCapturePerformanceStatus(capture);
  pumpPcmQueue(capture).catch((error) => {
    appendEvent("capture.pcm_pump_error", {
      message: error instanceof Error ? error.message : String(error)
    });
  });
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
    throw new Error(payload.detail ?? "chunk upload failed");
  }

  elements.chunkCount.textContent = String(payload.totalChunksReceived ?? 0);
  elements.byteCount.textContent = formatBytes(payload.totalBytesReceived ?? 0);
  elements.lastAck.textContent = payload.transcriptAccepted ? translate(state.language, "ack.transcript") : translate(state.language, "ack.chunk");
  appendEvent("send.chunk", payload);
  return payload;
}

async function attachAudioWorkletCapture(capture) {
  await ensurePcmWorkletModule(capture.audioContext);
  const node = new AudioWorkletNode(capture.audioContext, PCM_WORKLET_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: PCM_CHANNEL_COUNT,
    processorOptions: {
      outputSampleRate: PCM_SAMPLE_RATE_HZ,
      chunkSizeBytes: PCM_CHUNK_SIZE_BYTES,
      levelUpdateIntervalMs: LEVEL_UPDATE_INTERVAL_MS
    }
  });
  const outputGain = capture.audioContext.createGain();
  outputGain.gain.value = 0;

  node.port.onmessage = (event) => {
    if (!state.capture || state.capture !== capture) {
      return;
    }

    if (event.data?.type === "chunk" && event.data.buffer) {
      enqueuePcmChunk(capture, new Uint8Array(event.data.buffer));
    }

    if (event.data?.type === "level") {
      setCaptureLevel(event.data.level ?? 0);
    }

    if (event.data?.type === "flush") {
      capture.resolveFlush?.(new Uint8Array(event.data.buffer ?? new ArrayBuffer(0)));
    }
  };

  capture.source.connect(node);
  node.connect(outputGain);
  outputGain.connect(capture.audioContext.destination);

  capture.engine = "AudioWorklet";
  capture.node = node;
  capture.outputGain = outputGain;
}

function attachScriptProcessorCapture(capture) {
  const processor = capture.audioContext.createScriptProcessor(4096, PCM_CHANNEL_COUNT, PCM_CHANNEL_COUNT);
  const outputGain = capture.audioContext.createGain();
  outputGain.gain.value = 0;

  processor.onaudioprocess = (event) => {
    if (!state.capture || state.capture !== capture) {
      return;
    }

    const inputData = event.inputBuffer.getChannelData(0);
    updateCaptureLevelFromBuffer(inputData, capture);
    const downsampled = downsampleBuffer(inputData, capture.audioContext.sampleRate, PCM_SAMPLE_RATE_HZ);
    const pcmBytes = floatTo16BitPCM(downsampled);
    enqueuePcmBytes(capture, pcmBytes);
  };

  capture.source.connect(processor);
  processor.connect(outputGain);
  outputGain.connect(capture.audioContext.destination);

  capture.engine = "ScriptProcessor";
  capture.processor = processor;
  capture.outputGain = outputGain;
}

async function startCapture() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setPill(elements.captureStatus, translate(state.language, "capture.unsupported"), "warn");
    return;
  }

  const selectedFolderId = await requestCaptureFolderSelection();
  if (!selectedFolderId) {
    appendEvent("capture.folder_selection_cancelled", { reason: "user_cancelled" });
    return;
  }

  const sessionId = await ensureSessionId();
  connectStream();
  assignSessionToFolder(sessionId, selectedFolderId);
  renderFolderList();
  renderSessionList();
  state.historyMode = "live";
  rememberRecentSession(sessionId);
  const selectedDeviceId = elements.microphoneSelect.value;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: selectedDeviceId
      ? { deviceId: { exact: selectedDeviceId } }
      : true
  });
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;

  if (!AudioContextCtor) {
    throw new Error("AudioContext is required for PCM capture.");
  }

  const audioContext = new AudioContextCtor();
  await audioContext.resume();
  const source = audioContext.createMediaStreamSource(stream);
  const capture = {
    sessionId,
    stream,
    audioContext,
    source,
    engine: "initializing",
    startedAt: performance.now(),
    pausedDurationMs: 0,
    pauseStartedAt: null,
    isPaused: false,
    sequence: 1,
    sampleRateHz: PCM_SAMPLE_RATE_HZ,
    channels: PCM_CHANNEL_COUNT,
    chunkSizeBytes: PCM_CHUNK_SIZE_BYTES,
    pendingChunks: [],
    pendingByteChunks: [],
    pendingByteLength: 0,
    recordedPcmChunks: [],
    sending: false,
    queueState: "steady",
    resolveFlush: null,
    levelLastPaintAt: 0,
    vad: {
      hasDetectedSpeech: false,
      voiceActive: false,
      silentChunkStreak: 0,
      leadingSilenceDropped: 0
    },
    performance: {
      windowStartedAt: performance.now(),
      uploadCount: 0,
      eventCount: 0,
      renderCount: 0,
      renderDurationMs: 0
    }
  };

  state.capture = capture;

  try {
    await attachAudioWorkletCapture(capture);
  } catch (error) {
    appendEvent("capture.audio_worklet_fallback", {
      message: error instanceof Error ? error.message : String(error)
    });

    try {
      attachScriptProcessorCapture(capture);
    } catch (fallbackError) {
      state.capture = null;
      stream.getTracks().forEach((track) => track.stop());
      await audioContext.close();
      throw fallbackError;
    }
  }

  setPill(elements.captureStatus, translate(state.language, "capture.active"));
  setCaptureButtonState(true);
  startRecordingTimer();
  refreshCapturePerformanceStatus(capture);
  enterLiveWorkspace();
  connectStream();
}

async function stopCapture() {
  if (!state.capture) {
    return;
  }

  const capture = state.capture;
  const transcriptHint = elements.captureTranscriptHint.value.trim();
  setPill(elements.captureStatus, translate(state.language, "capture.stopping"));

  try {
    if (capture.isPaused) {
      capture.pausedDurationMs += performance.now() - (capture.pauseStartedAt ?? performance.now());
      capture.pauseStartedAt = null;
      capture.isPaused = false;
      await capture.audioContext.resume().catch(() => {});
    }

    capture.source.disconnect();
    capture.outputGain.disconnect();
    capture.processor?.disconnect();
    capture.node?.disconnect();

    const remainder = capture.node
      ? await requestWorkletFlush(capture)
      : concatUint8Arrays(capture.pendingByteChunks);

    if (capture.node && remainder.length > 0) {
      archiveCapturedPcm(capture, remainder);
    }

    while (capture.sending || capture.pendingChunks.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await uploadChunk(capture.sessionId, remainder, {
      chunkId: crypto.randomUUID(),
      sequence: capture.sequence,
      encoding: "pcm_s16le",
      sampleRateHz: PCM_SAMPLE_RATE_HZ,
      channels: PCM_CHANNEL_COUNT,
      durationMs: remainder.length > 0 ? Math.round((remainder.length / PCM_BYTES_PER_SAMPLE / PCM_SAMPLE_RATE_HZ) * 1000) : 0,
      isFinalChunk: true,
      sourceLanguage: elements.sourceLanguage.value,
      targetLanguages: targetLanguages(),
      transcriptHint: transcriptHint || undefined
    });

    const recordedPcm = concatUint8Arrays(capture.recordedPcmChunks);
    if (recordedPcm.length > 0) {
      const wavBytes = encodeWavFromPcm(recordedPcm, {
        sampleRateHz: PCM_SAMPLE_RATE_HZ,
        channels: PCM_CHANNEL_COUNT
      });

      await persistOriginalAudioClip(capture.sessionId, wavBytes, {
        sequence: 0,
        provider: "desktop-microphone",
        format: "wav",
        mimeType: "audio/wav"
      });
    }
  } finally {
    capture.stream.getTracks().forEach((track) => track.stop());
    if (capture.node) {
      capture.node.port.onmessage = null;
    }
    await capture.audioContext.close();
    state.capture = null;
    setCaptureButtonState(false);
    stopRecordingTimer();
    setPill(elements.captureStatus, translate(state.language, "capture.idle"));
    resetCaptureLevel();
    updatePerformanceStatus("Capture path: idle");
    if (!state.eventSource) {
      clearStreamRetryTimer();
      clearStreamWatchdogTimer();
      state.streamRetryAttempt = 0;
      state.lastStreamEventAt = 0;
    }
    syncWorkspaceLayout();
  }
}

async function sendSelectedFile() {
  const sessionId = await ensureSessionId();
  state.historyMode = "live";
  rememberRecentSession(sessionId);
  enterLiveWorkspace();
  connectStream();
  const file = elements.audioFileInput.files?.[0];

  if (!file) {
    alert(translate(state.language, "alerts.missingFile"));
    return;
  }

  const chunkSize = 32 * 1024;
  const fullBuffer = new Uint8Array(await file.arrayBuffer());
  let offset = 0;
  let sequence = 1;

  while (offset < fullBuffer.length) {
    const buffer = fullBuffer.slice(offset, Math.min(fullBuffer.length, offset + chunkSize));
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

  const originalMimeType = inferAudioMimeTypeFromFile(file);
  await persistOriginalAudioClip(sessionId, fullBuffer, {
    sequence: 0,
    provider: "desktop-file-upload",
    format: inferAudioFormatFromMimeType(originalMimeType),
    mimeType: originalMimeType
  });
  elements.audioFileInput.value = "";
}

function clearCurrentSpeechLines() {
  stopSpeechDraftTimers();
  state.currentSpeechDraft.sourceText = "";
  state.currentSpeechDraft.translationText = "";

  if (elements.currentSourceLine) {
    elements.currentSourceLine.textContent = "";
    elements.currentSourceLine.classList.remove("current-speech-caret");
  }

  if (elements.currentTranslationLine) {
    elements.currentTranslationLine.textContent = "";
    elements.currentTranslationLine.classList.remove("current-speech-caret");
  }
}

function resetToHomeWorkspace() {
  clearCurrentSpeechLines();
  state.pendingReplayFocusSequence = 0;
  elements.sessionId.value = "";
  syncSessionActionButtons();
  resetReplayState();
  state.workspaceMode = "idle";
  state.historyMode = "live";
  syncWorkspaceLayout();
  setSidebarView("dashboard");
}

async function stopSession(sessionIdOverride = null, options = {}) {
  const sessionId = String(sessionIdOverride ?? elements.sessionId.value).trim();
  const refreshSessions = options.refreshSessions ?? true;

  if (!sessionId) {
    alert(translate(state.language, "alerts.missingSession"));
    return;
  }

  await fetch(`${elements.gatewayBaseUrl.value}/sessions/${sessionId}/stop`, {
    method: "POST"
  });

  disconnectCurrentStream();
  appendEvent("session.stopped", { sessionId });
  if (refreshSessions) {
    await loadSessions();
  }
  syncSessionActionButtons();
  syncWorkspaceLayout();
}

async function endRecordingFlow() {
  if (state.isEndingRecordingFlow) {
    return;
  }

  state.isEndingRecordingFlow = true;
  const sessionId = elements.sessionId.value.trim();
  const replaySnapshot = sessionId ? currentReplaySnapshot(sessionId) : null;
  const latencyMs = currentSessionLatencyMs();
  disconnectCurrentStream();
  resetToHomeWorkspace();
  syncPauseButton();

  try {
    if (state.capture) {
      await stopCapture();
    }

    if (sessionId) {
      await stopSession(sessionId, {
        refreshSessions: false
      });
    }

    await loadSessions();

    if (sessionId && replaySnapshot) {
      syncSessionInsightFromReplay(sessionId, replaySnapshot, {
        latencyMs
      });
      await maybeSuggestSessionTitle(sessionId, replaySnapshot);
    }
  } finally {
    state.isEndingRecordingFlow = false;
    setCaptureButtonState(Boolean(state.capture));
    syncPauseButton();
    syncSessionActionButtons();
  }
}

function openOverlayWindow() {
  if (state.overlayWindow && !state.overlayWindow.closed) {
    state.overlayWindow.focus();
    publishOverlayState();
    return;
  }

  state.overlayWindow = window.open("/overlay", "tts-floating-captions", "popup=yes,width=520,height=280,left=80,top=80");
  publishOverlayState();
  window.setTimeout(() => publishOverlayState(), 250);
}

function exportSummaryPdf() {
  const popup = window.open("", "_blank");
  if (!popup) {
    appendEvent("export.summary_blocked", { message: "Popup was blocked by the browser." });
    return;
  }
  const finalSegments = orderedSourceSegments().filter((segment) => segment.status === "final");
  const summaryHtml = finalSegments.slice(-6).map((segment) => {
    const translation = translationBySegmentId(segment.segmentId);
    return `<li><strong>${escapeHtml(segment.text)}</strong><br/>${escapeHtml(translation?.text ?? "")}</li>`;
  }).join("");

  popup.document.write(`
    <html>
      <head><title>Summary Export</title></head>
      <body>
        <h1>${escapeHtml(elements.sessionTitle.value)}</h1>
        <p>${escapeHtml(translate(state.language, "summary.template", { count: finalSegments.length }))}</p>
        <ul>${summaryHtml}</ul>
      </body>
    </html>
  `);
  popup.document.close();
  popup.focus();
  popup.print();
}

async function exportReplayJson() {
  const sessionId = elements.sessionId.value.trim();

  if (!sessionId) {
    alert(translate(state.language, "alerts.missingSession"));
    return;
  }

  const response = await fetch(`${elements.apiBaseUrl.value}/sessions/${sessionId}/replay`);
  const replay = await response.json();
  const blob = new Blob([JSON.stringify(replay, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${sessionId}-replay.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function bindClick(element, handler) {
  element?.addEventListener("click", handler);
}

bindClick(elements.requestMicButton, () => requestMicrophoneAccess().catch((error) => appendEvent("device.permission_error", { message: error instanceof Error ? error.message : String(error) })));
bindClick(elements.refreshDevicesButton, () => refreshDevices().catch((error) => appendEvent("device.refresh_error", { message: error instanceof Error ? error.message : String(error) })));
bindClick(elements.refreshDevicesButtonDuplicate, () => refreshDevicesWithAnimation().catch((error) => appendEvent("device.refresh_error", { message: error instanceof Error ? error.message : String(error) })));
bindClick(elements.createSessionButton, () => createSession().catch((error) => appendEvent("session.create_error", { message: error instanceof Error ? error.message : String(error) })));
bindClick(elements.connectButton, connectStream);
bindClick(elements.loadReplayButton, () => loadReplay().catch((error) => appendEvent("replay.load_error", { message: error instanceof Error ? error.message : String(error) })));
bindClick(elements.sendTextButton, () => sendText().catch((error) => appendEvent("send.text_error", { message: error instanceof Error ? error.message : String(error) })));
bindClick(elements.sendFileButton, () => sendSelectedFile().catch((error) => appendEvent("send.file_error", { message: error instanceof Error ? error.message : String(error) })));
bindClick(elements.startCaptureButton, () => startCapture().catch((error) => {
  setPill(elements.captureStatus, translate(state.language, "capture.failed"), "warn");
  appendEvent("capture.start_error", { message: error instanceof Error ? error.message : String(error) });
}));
bindClick(elements.startCaptureButtonDuplicate, () => startCapture().catch((error) => {
  setPill(elements.captureStatus, translate(state.language, "capture.failed"), "warn");
  appendEvent("capture.start_error", { message: error instanceof Error ? error.message : String(error) });
}));
bindClick(elements.heroStartCaptureButton, () => startCapture().catch((error) => {
  setPill(elements.captureStatus, translate(state.language, "capture.failed"), "warn");
  appendEvent("capture.start_error", { message: error instanceof Error ? error.message : String(error) });
}));
bindClick(elements.stopCaptureButton, () => stopCapture().catch((error) => appendEvent("capture.stop_error", { message: error instanceof Error ? error.message : String(error) })));
bindClick(elements.stopCaptureButtonDuplicate, () => stopCapture().catch((error) => appendEvent("capture.stop_error", { message: error instanceof Error ? error.message : String(error) })));
bindClick(elements.stopButton, () => stopSession().catch((error) => appendEvent("session.stop_error", { message: error instanceof Error ? error.message : String(error) })));
bindClick(elements.stopButtonInline, () => endRecordingFlow().catch((error) => appendEvent("session.stop_error", { message: error instanceof Error ? error.message : String(error) })));
bindClick(elements.stopButtonDuplicate, () => endRecordingFlow().catch((error) => appendEvent("session.stop_error", { message: error instanceof Error ? error.message : String(error) })));
bindClick(elements.pauseCaptureButtonLive, () => togglePauseCapture().catch((error) => appendEvent("capture.pause_error", { message: error instanceof Error ? error.message : String(error) })));
bindClick(elements.openOverlayButton, openOverlayWindow);
bindClick(elements.openOverlayButtonDuplicate, openOverlayWindow);
bindClick(elements.resumeLiveSessionButton, () => resumeLastSessionLive().catch((error) => appendEvent("session.resume_error", { message: error instanceof Error ? error.message : String(error) })));
bindClick(elements.resumeReplaySessionButton, () => resumeLastSessionReplay().catch((error) => appendEvent("session.resume_error", { message: error instanceof Error ? error.message : String(error) })));
bindClick(elements.resumeLiveSessionButtonHero, () => resumeLastSessionLive().catch((error) => appendEvent("session.resume_error", { message: error instanceof Error ? error.message : String(error) })));
bindClick(elements.resumeReplaySessionButtonHero, () => resumeLastSessionReplay().catch((error) => appendEvent("session.resume_error", { message: error instanceof Error ? error.message : String(error) })));
bindClick(elements.resumeLiveSessionButtonLive, () => resumeLastSessionLive().catch((error) => appendEvent("session.resume_error", { message: error instanceof Error ? error.message : String(error) })));
bindClick(elements.resumeReplaySessionButtonLive, () => resumeLastSessionReplay().catch((error) => appendEvent("session.resume_error", { message: error instanceof Error ? error.message : String(error) })));
bindClick(elements.jumpToFoldersButton, () => setSidebarView("folders"));
bindClick(elements.uploadAudioTriggerButton, () => elements.audioFileInput?.click());
bindClick(elements.exportSummaryPdfButton, exportSummaryPdf);
bindClick(elements.exportReplayJsonButton, () => exportReplayJson().catch((error) => appendEvent("export.replay_error", { message: error instanceof Error ? error.message : String(error) })));
bindClick(elements.undoToastUndoButton, undoLastAction);
bindClick(elements.undoToastCloseButton, hideUndoToast);
elements.gatewayBaseUrl?.addEventListener("change", () => refreshGatewayHealth().catch(() => setPill(elements.gatewayStatus, "Gateway provider: unavailable", "warn")));
elements.sessionId?.addEventListener("input", syncSessionActionButtons);
elements.microphoneSelect?.addEventListener("change", () => {
  renderMicrophonePopdown();
});
elements.sourceLanguage?.addEventListener("change", () => {
  renderSourceLanguagePopdown();
});
elements.targetLanguages?.addEventListener("change", () => {
  renderTargetLanguagesPopdown();
  rebuildPrimaryTranslations();
  renderTranscriptViews();
  renderSummary();
  publishOverlayState();
});
elements.microphonePopdownTrigger?.addEventListener("click", (event) => {
  event.preventDefault();
  if (elements.microphonePopdownTrigger?.disabled) {
    return;
  }
  setPopdownOpen("microphone", state.activePopdown !== "microphone");
});
elements.sourceLanguagePopdownTrigger?.addEventListener("click", (event) => {
  event.preventDefault();
  if (elements.sourceLanguagePopdownTrigger?.disabled) {
    return;
  }
  setPopdownOpen("sourceLanguage", state.activePopdown !== "sourceLanguage");
});
elements.targetLanguagesPopdownTrigger?.addEventListener("click", (event) => {
  event.preventDefault();
  if (elements.targetLanguagesPopdownTrigger?.disabled) {
    return;
  }
  setPopdownOpen("targetLanguages", state.activePopdown !== "targetLanguages");
});
document.addEventListener("click", (event) => {
  if (!state.activePopdown) {
    return;
  }

  const target = event.target;
  if (target instanceof Node && (elements.microphonePopdown?.contains(target) || elements.sourceLanguagePopdown?.contains(target) || elements.targetLanguagesPopdown?.contains(target))) {
    return;
  }

  setPopdownOpen(state.activePopdown, false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.activePopdown) {
    setPopdownOpen(state.activePopdown, false);
  }
});
elements.sourceLanguage?.addEventListener("change", syncRecordingLanguageChips);
elements.targetLanguages?.addEventListener("change", syncRecordingLanguageChips);
elements.audioFileInput?.addEventListener("change", () => {
  if (elements.audioFileInput.files?.length) {
    sendSelectedFile().catch((error) => appendEvent("send.file_error", { message: error instanceof Error ? error.message : String(error) }));
  }
});
elements.navDashboardButton?.addEventListener("click", () => setSidebarView("dashboard"));
elements.navFoldersButton?.addEventListener("click", () => setSidebarView("folders"));
elements.sidebarDashboardButton?.addEventListener("click", () => setSidebarView("dashboard"));
elements.sidebarFoldersButton?.addEventListener("click", () => setSidebarView("folders"));
elements.sidebarHistoryButton?.addEventListener("click", () => setSidebarView("history"));
bindClick(elements.toggleLanguageButton, toggleLanguage);
bindClick(elements.toggleSidebarButton, toggleSidebar);

if (elements.languageSelect) {
  initLanguageSelect(elements.languageSelect, state.language, applyLanguage);
}

window.addEventListener("load", async () => {
  if (state.liveLatencyTickerId) {
    window.clearInterval(state.liveLatencyTickerId);
  }
  state.liveLatencyTickerId = window.setInterval(() => {
    updateLiveLatencyBadge();
  }, 600);

  setSidebarView(state.sidebarView);
  syncSidebarCollapseState();
  syncLanguageButton();
  setCaptureButtonState(false);
  stopRecordingTimer();
  syncSessionActionButtons();
  syncRecordingLanguageChips();
  applyLanguage(state.language);
  await Promise.all([
    refreshDevices().catch(() => setPill(elements.shellStatus, translate(state.language, "device.refreshFailed"), "warn")),
    refreshGatewayHealth().catch(() => setPill(elements.gatewayStatus, "Gateway provider: unavailable", "warn")),
    loadSessions()
  ]);
  renderTranscriptViews();
  renderSummary();
  renderAudioClips();
  renderReplayInspector();
  syncWorkspaceLayout();
  publishOverlayState();
});

