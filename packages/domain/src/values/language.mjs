/**
 * Language Value Object & Domain Rules
 */

export const SUPPORTED_SOURCE_LANGUAGES = Object.freeze([
  "auto",
  "en",
  "zh",
  "zh-CN",
  "ja",
  "ko",
  "ru",
  "ar",
  "hi"
]);

export function normalizeSourceLanguage(value, fallback = "en") {
  const normalized = String(value ?? fallback).trim();
  return normalized || fallback;
}

export function normalizeTargetLanguages(rawValue) {
  if (Array.isArray(rawValue)) {
    return rawValue.map((lang) => String(lang).trim()).filter(Boolean);
  }
  return String(rawValue ?? "zh-CN")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function detectLanguageFromText(text) {
  const sample = String(text ?? "").trim();

  if (!sample) {
    return null;
  }

  if (/[\u3040-\u30ff]/.test(sample)) {
    return "ja";
  }

  if (/[\uac00-\ud7af]/.test(sample)) {
    return "ko";
  }

  if (/[\u0400-\u04ff]/.test(sample)) {
    return "ru";
  }

  if (/[\u0600-\u06ff]/.test(sample)) {
    return "ar";
  }

  if (/[\u0900-\u097f]/.test(sample)) {
    return "hi";
  }

  if (/[\u4e00-\u9fff]/.test(sample)) {
    return "zh";
  }

  if (/[A-Za-z]/.test(sample)) {
    return "en";
  }

  return null;
}

export function resolveSegmentSourceLanguage(requestedSourceLanguage, text, fallback = "en") {
  const sourceLanguage = normalizeSourceLanguage(requestedSourceLanguage, fallback);

  if (sourceLanguage !== "auto") {
    return sourceLanguage;
  }

  return detectLanguageFromText(text) ?? fallback;
}

/**
 * Check whether two language tags belong to the same base language family.
 * e.g. "zh" and "zh-CN" are treated as same language.
 */
export function isSameLanguage(langA, langB) {
  if (!langA || !langB) return false;
  const a = String(langA).toLowerCase().split("-")[0];
  const b = String(langB).toLowerCase().split("-")[0];
  return a === b;
}

/**
 * Domain rule: "当前语种默认不转译"
 * When suppressSameLanguage is enabled, if sourceLanguage and targetLanguage
 * are the same language, do not translate.
 */
export function shouldTranslate(sourceLanguage, targetLanguage, options = {}) {
  const suppressSameLanguage = options.suppressSameLanguage ?? false;
  if (suppressSameLanguage && isSameLanguage(sourceLanguage, targetLanguage)) {
    return false;
  }
  return true;
}
