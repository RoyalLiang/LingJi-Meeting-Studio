const LANGUAGE_STORAGE_KEY = "tts.ui.language";

export const translations = {
  en: {
    "hero.eyebrow": "Web Workspace",
    "hero.title": "Realtime Language Workspace",
    "hero.description": "The web workspace now follows the same product direction as the desktop shell: source transcript, translation transcript, progressive summary, and speech output in one place.",
    "hero.note": "Use this page for session orchestration, replay, sharing, and browser-based capture while we keep the desktop shell focused on the eventual Electron workflow.",
    "language.label": "Page language",
    "service.title": "Service Config",
    "service.api": "Transcript API",
    "service.gateway": "Session Gateway",
    "session.title": "Session",
    "session.name": "Title",
    "session.sourceLanguage": "Source Language",
    "session.targetLanguages": "Target Languages (comma separated)",
    "session.id": "Session ID",
    "session.idPlaceholder": "Create a session first or paste an existing session id",
    "session.create": "Create Session",
    "session.connect": "Connect Stream",
    "session.replay": "Load Replay",
    "session.share": "Create Share Link",
    "session.stop": "Stop Session",
    "capture.title": "Capture",
    "capture.requestMic": "Request Microphone",
    "capture.refreshDevices": "Refresh Devices",
    "capture.microphone": "Microphone Device",
    "capture.fallbackHint": "Fallback Transcript Hint",
    "capture.start": "Start Capture",
    "capture.stop": "Stop Capture",
    "capture.chunks": "Chunks Sent",
    "capture.bytes": "Bytes Sent",
    "capture.lastAck": "Last Ack",
    "manual.title": "Manual Send",
    "manual.text": "Text Payload",
    "manual.file": "Local Audio File",
    "manual.fileHint": "File Mode Transcript Hint",
    "manual.sendText": "Send Text",
    "manual.sendFile": "Send File Chunks",
    "source.title": "Source Transcript",
    "translation.title": "Translation Transcript",
    "summary.title": "Progressive Summary",
    "audio.title": "Speech Output",
    "events.title": "Realtime Event Log",
    "status.webReady": "Web workspace ready",
    "status.gatewayPrefix": "Gateway provider",
    "status.gatewayUnavailable": "Gateway provider: unavailable",
    "status.permissionIdle": "Microphone permission: not requested",
    "status.permissionGranted": "Microphone permission: granted",
    "status.permissionDenied": "Microphone permission: denied",
    "status.permissionUnsupported": "Microphone permission: unsupported",
    "status.captureIdle": "Capture state: idle",
    "status.captureActive": "Capture state: microphone active",
    "status.captureStopping": "Capture state: stopping...",
    "status.captureFailed": "Capture state: failed to start",
    "status.captureUnsupported": "Capture state: MediaRecorder unsupported",
    "status.devicesUnsupported": "Workspace: browser does not support device enumeration",
    "status.devicesMissing": "Workspace: no audio input devices found",
    "status.devicesLoaded": "Workspace: loaded {count} audio input devices",
    "status.sessionNone": "No active session yet.",
    "status.shareNone": "No share link generated yet.",
    "status.replayWaiting": "Waiting for transcript events...",
    "status.replaySummary": "Heuristic progressive summary based on {count} finalized source segments.",
    "status.noSource": "No source transcript yet.",
    "status.noTranslation": "No translation transcript yet.",
    "status.noSummary": "Progressive summary will appear here.",
    "status.noAudio": "No TTS audio clips persisted yet.",
    "status.translationPending": "translation pending",
    "status.chunkAccepted": "chunk accepted",
    "status.transcriptAccepted": "transcript accepted",
    "status.selectFile": "Select an audio file first.",
    "status.sessionMissing": "Create a session first or paste an existing session id."
  },
  "zh-CN": {
    "hero.eyebrow": "网页工作台",
    "hero.title": "实时语言工作台",
    "hero.description": "网页入口现在与桌面壳保持同一产品方向：原文转录、译文转录、渐进式总结和语音输出放在同一视图中。",
    "hero.note": "这个页面适合做会话编排、回放、分享和浏览器采集；桌面壳继续承载未来 Electron 工作流的主入口。",
    "language.label": "页面语言",
    "service.title": "服务配置",
    "service.api": "Transcript API",
    "service.gateway": "Session Gateway",
    "session.title": "会话",
    "session.name": "标题",
    "session.sourceLanguage": "源语言",
    "session.targetLanguages": "目标语言（逗号分隔）",
    "session.id": "Session ID",
    "session.idPlaceholder": "先创建会话，或填入已有 session id",
    "session.create": "创建 Session",
    "session.connect": "连接实时流",
    "session.replay": "加载 Replay",
    "session.share": "生成分享链接",
    "session.stop": "停止 Session",
    "capture.title": "采集",
    "capture.requestMic": "申请麦克风",
    "capture.refreshDevices": "刷新设备",
    "capture.microphone": "麦克风设备",
    "capture.fallbackHint": "停止采集时的兜底 Transcript Hint",
    "capture.start": "开始采集",
    "capture.stop": "停止采集",
    "capture.chunks": "已发送 Chunk",
    "capture.bytes": "已发送字节",
    "capture.lastAck": "最后状态",
    "manual.title": "手动发送",
    "manual.text": "文本载荷",
    "manual.file": "本地音频文件",
    "manual.fileHint": "文件模式 Transcript Hint",
    "manual.sendText": "发送文本",
    "manual.sendFile": "发送文件 Chunk",
    "source.title": "原文转录",
    "translation.title": "译文转录",
    "summary.title": "渐进式总结",
    "audio.title": "语音输出",
    "events.title": "实时事件日志",
    "status.webReady": "网页工作台已准备就绪",
    "status.gatewayPrefix": "Gateway Provider",
    "status.gatewayUnavailable": "Gateway Provider：不可达",
    "status.permissionIdle": "麦克风权限：未申请",
    "status.permissionGranted": "麦克风权限：已授权",
    "status.permissionDenied": "麦克风权限：已拒绝",
    "status.permissionUnsupported": "麦克风权限：当前浏览器不支持",
    "status.captureIdle": "采集状态：空闲",
    "status.captureActive": "采集状态：麦克风采集中",
    "status.captureStopping": "采集状态：正在停止…",
    "status.captureFailed": "采集状态：启动失败",
    "status.captureUnsupported": "采集状态：当前浏览器不支持 MediaRecorder",
    "status.devicesUnsupported": "工作台：当前浏览器不支持设备枚举",
    "status.devicesMissing": "工作台：未发现音频输入设备",
    "status.devicesLoaded": "工作台：已加载 {count} 个音频输入设备",
    "status.sessionNone": "当前没有激活会话。",
    "status.shareNone": "尚未生成分享链接。",
    "status.replayWaiting": "正在等待转录事件…",
    "status.replaySummary": "基于 {count} 条已完成原文转录生成的启发式渐进总结。",
    "status.noSource": "暂无原文转录。",
    "status.noTranslation": "暂无译文转录。",
    "status.noSummary": "渐进式总结会显示在这里。",
    "status.noAudio": "暂无已持久化的 TTS 音频片段。",
    "status.translationPending": "译文待生成",
    "status.chunkAccepted": "chunk 已接收",
    "status.transcriptAccepted": "已生成转录",
    "status.selectFile": "请先选择音频文件。",
    "status.sessionMissing": "请先创建会话，或填写已有 session id。"
  }
};

export function getInitialLanguage() {
  const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return saved && translations[saved] ? saved : "en";
}

export function saveLanguage(language) {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
}

export function t(language, key, replacements = {}) {
  const template = translations[language]?.[key] ?? translations.en[key] ?? key;
  return Object.entries(replacements).reduce((value, [name, replacement]) => {
    return value.replace(`{${name}}`, String(replacement));
  }, template);
}

export function applyStaticTranslations(language) {
  document.documentElement.lang = language;

  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = t(language, element.dataset.i18n);
  }

  for (const element of document.querySelectorAll("[data-i18n-placeholder]")) {
    element.placeholder = t(language, element.dataset.i18nPlaceholder);
  }
}
