import { applyI18n, getStoredLanguage, initLanguageSelect, translate } from "./i18n.js";
import { createPreviewChannel } from "./preview-channel.js";

const elements = {
  languageSelect: document.querySelector("#languageSelect"),
  sourceLine: document.querySelector("#sourceLine"),
  translationLine: document.querySelector("#translationLine"),
  overlayMeta: document.querySelector("#overlayMeta")
};

const state = {
  language: getStoredLanguage()
};

function applyLanguage(language) {
  state.language = language;
  document.documentElement.lang = language;
  applyI18n(document, language);

  if (!elements.sourceLine.dataset.hasContent) {
    elements.sourceLine.textContent = translate(language, "overlay.empty");
  }
}

function renderState(payload) {
  const sourceSegments = payload.sourceSegments ?? [];
  const translations = payload.translations ?? [];
  const lastSource = sourceSegments[sourceSegments.length - 1];
  const lastTranslation = translations[translations.length - 1];

  if (!lastSource) {
    elements.sourceLine.dataset.hasContent = "";
    elements.sourceLine.textContent = translate(state.language, "overlay.empty");
    elements.translationLine.textContent = "";
    elements.overlayMeta.textContent = "";
    return;
  }

  elements.sourceLine.dataset.hasContent = "true";
  elements.sourceLine.textContent = lastSource.text;
  elements.translationLine.textContent = lastTranslation?.text ?? "";
  elements.overlayMeta.textContent = `#${lastSource.sequence} · ${lastSource.status}`;
}

const channel = createPreviewChannel();
channel.onmessage = (event) => {
  if (event.data?.type === "language") {
    applyLanguage(event.data.language);
    return;
  }

  if (event.data?.type === "state") {
    renderState(event.data.payload);
  }
};

initLanguageSelect(elements.languageSelect, state.language, applyLanguage);
applyLanguage(state.language);
