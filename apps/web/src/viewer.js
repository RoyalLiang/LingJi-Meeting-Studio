const params = new URLSearchParams(location.search);
const token = params.get("token");
const apiBaseUrl = params.get("api") || "http://127.0.0.1:3020";
const gatewayBaseUrl = params.get("gateway") || "http://127.0.0.1:3010";
const titleElement = document.querySelector("#title");
const statusElement = document.querySelector("#status");
const segmentsElement = document.querySelector("#segments");
const translations = new Map();
const segments = new Map();

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function render() {
  const ordered = Array.from(segments.values()).sort((left, right) => left.sequence - right.sequence);
  segmentsElement.innerHTML = ordered
    .map((segment) => {
      const translated = Array.from(translations.values())
        .filter((item) => item.segmentId === segment.segmentId)
        .map((item) => `<div class="translation">[${escapeHtml(item.targetLanguage)}] ${escapeHtml(item.text)}</div>`)
        .join("");

      return `<div class="segment"><div><strong>#${escapeHtml(segment.sequence)}</strong> ${escapeHtml(segment.text)}</div>${translated}</div>`;
    })
    .join("") || '<div class="segment">暂无内容</div>';
}

async function bootstrap() {
  if (!token) {
    statusElement.textContent = "缺少 token";
    return;
  }

  const response = await fetch(`${apiBaseUrl}/share/${token}/bootstrap`);
  if (!response.ok) {
    throw new Error(`Unable to load share bootstrap: ${response.status}`);
  }
  const payload = await response.json();
  titleElement.textContent = payload.session.title;
  statusElement.textContent = `Session: ${payload.session.id} | 状态: ${payload.session.status}`;

  for (const segment of payload.segments) {
    segments.set(segment.segmentId, segment);
  }

  for (const translation of payload.translations) {
    translations.set(`${translation.segmentId}:${translation.targetLanguage}`, translation);
  }

  render();
  const stream = new EventSource(`${gatewayBaseUrl}/sessions/${payload.session.id}/stream`);
  stream.onmessage = (event) => {
    const envelope = JSON.parse(event.data);

    if (envelope.type === "segment.upserted" && envelope.payload.status === "final") {
      segments.set(envelope.payload.segmentId, envelope.payload);
    }

    if (envelope.type === "translation.upserted") {
      translations.set(`${envelope.payload.segmentId}:${envelope.payload.targetLanguage}`, envelope.payload);
    }

    if (envelope.type === "session.status_changed") {
      statusElement.textContent = `Session: ${payload.session.id} | 状态: ${envelope.payload.status}`;
    }

    render();
  };
}

bootstrap().catch((error) => {
  statusElement.textContent = error instanceof Error ? error.message : String(error);
});
