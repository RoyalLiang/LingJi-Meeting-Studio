import { randomUUID } from "node:crypto";
import { normalizeSourceLanguage, normalizeTargetLanguages } from "../values/language.mjs";

export const VALID_SESSION_STATUSES = Object.freeze([
  "created",
  "connecting",
  "live",
  "stopping",
  "completed",
  "failed"
]);

export class SessionAggregate {
  #id;
  #workspaceId;
  #folderId;
  #title;
  #status;
  #deviceSelection;
  #config;
  #createdAt;
  #startedAt;
  #endedAt;

  constructor(params) {
    this.#id = params.id;
    this.#workspaceId = params.workspaceId ?? "default-workspace";
    this.#folderId = params.folderId ?? null;
    this.#title = String(params.title ?? "Untitled Session").trim() || "Untitled Session";
    this.#status = params.status ?? "created";
    this.#deviceSelection = {
      sourceKind: params.deviceSelection?.sourceKind ?? "microphone",
      microphoneDeviceId: params.deviceSelection?.microphoneDeviceId,
      systemDeviceId: params.deviceSelection?.systemDeviceId
    };
    this.#config = {
      sourceLanguage: normalizeSourceLanguage(params.config?.sourceLanguage, "auto"),
      targetLanguages: normalizeTargetLanguages(params.config?.targetLanguages),
      enableAudioStorage: Boolean(params.config?.enableAudioStorage),
      enableLiveShare: params.config?.enableLiveShare ?? true,
      suppressSameLanguageTranslation: Boolean(params.config?.suppressSameLanguageTranslation),
      glossaryIds: Array.isArray(params.config?.glossaryIds) ? params.config.glossaryIds : [],
      referenceDocumentIds: Array.isArray(params.config?.referenceDocumentIds) ? params.config.referenceDocumentIds : []
    };
    this.#createdAt = params.createdAt ?? new Date().toISOString();
    this.#startedAt = params.startedAt ?? null;
    this.#endedAt = params.endedAt ?? null;
  }

  static create(payload = {}) {
    const id = payload.id ?? randomUUID();
    return new SessionAggregate({
      ...payload,
      id,
      status: payload.status ?? "created",
      createdAt: new Date().toISOString()
    });
  }

  static fromSnapshot(snapshot) {
    return new SessionAggregate(snapshot);
  }

  get id() {
    return this.#id;
  }

  get workspaceId() {
    return this.#workspaceId;
  }

  get folderId() {
    return this.#folderId;
  }

  get title() {
    return this.#title;
  }

  get status() {
    return this.#status;
  }

  get deviceSelection() {
    return { ...this.#deviceSelection };
  }

  get config() {
    return { ...this.#config };
  }

  get createdAt() {
    return this.#createdAt;
  }

  get startedAt() {
    return this.#startedAt;
  }

  get endedAt() {
    return this.#endedAt;
  }

  isLive() {
    return this.#status === "live";
  }

  isTerminated() {
    return this.#status === "completed" || this.#status === "failed";
  }

  start() {
    if (this.isTerminated()) {
      throw new Error(`Cannot start session ${this.#id} because it is already in status "${this.#status}".`);
    }
    this.#status = "live";
    if (!this.#startedAt) {
      this.#startedAt = new Date().toISOString();
    }
    return this;
  }

  complete() {
    this.#status = "completed";
    if (!this.#endedAt) {
      this.#endedAt = new Date().toISOString();
    }
    return this;
  }

  fail() {
    this.#status = "failed";
    if (!this.#endedAt) {
      this.#endedAt = new Date().toISOString();
    }
    return this;
  }

  rename(newTitle) {
    const trimmed = String(newTitle ?? "").trim();
    if (!trimmed) {
      throw new Error("Session title cannot be empty.");
    }
    this.#title = trimmed;
    return this;
  }

  moveToFolder(folderId) {
    this.#folderId = folderId ? String(folderId) : null;
    return this;
  }

  updateConfig(updates = {}) {
    this.#config = {
      ...this.#config,
      ...updates,
      sourceLanguage: updates.sourceLanguage !== undefined
        ? normalizeSourceLanguage(updates.sourceLanguage, this.#config.sourceLanguage)
        : this.#config.sourceLanguage,
      targetLanguages: updates.targetLanguages !== undefined
        ? normalizeTargetLanguages(updates.targetLanguages)
        : this.#config.targetLanguages
    };
    return this;
  }

  updateDeviceSelection(deviceSelection = {}) {
    this.#deviceSelection = {
      ...this.#deviceSelection,
      ...deviceSelection
    };
    return this;
  }

  toSnapshot() {
    return {
      id: this.#id,
      workspaceId: this.#workspaceId,
      folderId: this.#folderId,
      title: this.#title,
      status: this.#status,
      deviceSelection: { ...this.#deviceSelection },
      config: { ...this.#config },
      createdAt: this.#createdAt,
      startedAt: this.#startedAt ?? undefined,
      endedAt: this.#endedAt ?? undefined
    };
  }
}
