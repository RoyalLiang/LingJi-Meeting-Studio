import test from "node:test";
import assert from "node:assert/strict";
import {
  createGatewayServer,
  createSession,
  fetchGatewayHealth,
  fetchReplay,
  ingestText,
  runWithStack,
  startDesktopPreviewServer,
  startWebPreviewServer
} from "./helpers/stack.mjs";


test("gateway uses the default provider path when no ASR provider is configured", async () => {
  await runWithStack(
    {
      apiPort: 4720,
      gatewayPort: 4721,
      storageBackend: "memory"
    },
    async ({ apiBaseUrl, gatewayBaseUrl }) => {
      const session = await createSession(apiBaseUrl, {
        title: "Default Provider Flow"
      });

      const accepted = await ingestText(
        gatewayBaseUrl,
        session.id,
        "hello default provider review the roadmap"
      );
      const replay = await fetchReplay(apiBaseUrl, session.id);

      assert.equal(accepted.accepted, true);
      assert.equal(replay.segments.length, 1);
      assert.equal(replay.translations.length, 1);
      assert.equal(replay.segments[0].text, "hello default provider review the roadmap");
    }
  );
});

test("gateway rejects unsupported ASR provider selection", async () => {
  const gateway = await createGatewayServer({
    port: 4731,
    asrProvider: "unsupported-provider"
  });

  await assert.rejects(
    async () => {
      await gateway.start();
    },
    /unsupported|provider/i
  );
});

test("gateway rejects deepgram provider when API key is missing", async () => {
  const previousDeepgramApiKey = process.env.DEEPGRAM_API_KEY;
  const previousAsrApiKey = process.env.ASR_API_KEY;

  delete process.env.DEEPGRAM_API_KEY;
  delete process.env.ASR_API_KEY;

  try {
    const gateway = await createGatewayServer({
      port: 4732,
      asrProvider: "deepgram"
    });

    await assert.rejects(
      async () => {
        await gateway.start();
      },
      /deepgram|DEEPGRAM_API_KEY|ASR_API_KEY/i
    );
  } finally {
    if (previousDeepgramApiKey === undefined) {
      delete process.env.DEEPGRAM_API_KEY;
    } else {
      process.env.DEEPGRAM_API_KEY = previousDeepgramApiKey;
    }

    if (previousAsrApiKey === undefined) {
      delete process.env.ASR_API_KEY;
    } else {
      process.env.ASR_API_KEY = previousAsrApiKey;
    }
  }
});



test("gateway falls back to mock when deepgram is configured but unavailable", async () => {
  const previousDeepgramApiKey = process.env.DEEPGRAM_API_KEY;
  const previousAsrApiKey = process.env.ASR_API_KEY;

  delete process.env.DEEPGRAM_API_KEY;
  delete process.env.ASR_API_KEY;

  try {
    await runWithStack(
      {
        apiPort: 4744,
        gatewayPort: 4745,
        storageBackend: "memory",
        gatewayOptions: {
          asrProvider: "deepgram",
          asrFallbackProvider: "mock"
        }
      },
      async ({ apiBaseUrl, gatewayBaseUrl }) => {
        const gatewayHealth = await fetchGatewayHealth(gatewayBaseUrl);
        const session = await createSession(apiBaseUrl, {
          title: "Deepgram Fallback Flow"
        });

        const accepted = await ingestText(
          gatewayBaseUrl,
          session.id,
          "hello fallback provider review the roadmap"
        );
        const replay = await fetchReplay(apiBaseUrl, session.id);

        assert.equal(gatewayHealth.asrProvider, "deepgram");
        assert.equal(gatewayHealth.fallbackProvider, "mock");
        assert.equal(gatewayHealth.activeProvider, "mock");
        assert.equal(accepted.accepted, true);
        assert.equal(replay.segments.length, 1);
        assert.equal(replay.translations.length, 1);
      }
    );
  } finally {
    if (previousDeepgramApiKey === undefined) {
      delete process.env.DEEPGRAM_API_KEY;
    } else {
      process.env.DEEPGRAM_API_KEY = previousDeepgramApiKey;
    }

    if (previousAsrApiKey === undefined) {
      delete process.env.ASR_API_KEY;
    } else {
      process.env.ASR_API_KEY = previousAsrApiKey;
    }
  }
});


test("desktop shell preview serves an interactive HTML entrypoint", async (t) => {
  const preview = await startDesktopPreviewServer({
    port: 4740
  });

  if (!preview) {
    t.skip("desktop shell preview entrypoint has not been implemented yet");
    return;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${preview.port}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/i);
    assert.match(html, /folderList/i);
    assert.match(html, /sessionList/i);
    assert.match(html, /sourceTranscriptList/i);
    assert.match(html, /translationTranscriptList/i);
    assert.match(html, /summaryList/i);
    assert.match(html, /audioClipList/i);
    assert.match(html, /exportSummaryPdfButton/i);
    assert.match(html, /exportReplayJsonButton/i);
  } finally {
    await preview.stop();
  }
});

test("web main entrypoint serves an interactive HTML entrypoint", async (t) => {
  const preview = await startWebPreviewServer({
    port: 4741
  });

  if (!preview) {
    t.skip("web preview entrypoint has not been implemented yet");
    return;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${preview.port}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/i);
    assert.match(html, /folderList/i);
    assert.match(html, /sessionList/i);
    assert.match(html, /sourceTranscriptList/i);
    assert.match(html, /translationTranscriptList/i);
    assert.match(html, /summaryList/i);
    assert.match(html, /audioClipList/i);
    assert.match(html, /exportSummaryPdfButton/i);
    assert.match(html, /exportReplayJsonButton/i);
  } finally {
    await preview.stop();
  }
});

test("desktop preview exposes an overlay-style HTML route when implemented", async (t) => {
  const preview = await startDesktopPreviewServer({
    port: 4742
  });

  if (!preview) {
    t.skip("desktop preview entrypoint has not been implemented yet");
    return;
  }

  try {
    const candidatePaths = ["/overlay", "/floating", "/subtitle-overlay", "/overlay.html"];
    let matched = null;

    for (const pathname of candidatePaths) {
      const response = await fetch(`http://127.0.0.1:${preview.port}${pathname}`);

      if (response.status === 200) {
        matched = {
          pathname,
          html: await response.text()
        };
        break;
      }
    }

    if (!matched) {
      t.skip("desktop overlay route has not been implemented yet");
      return;
    }

    assert.match(matched.html, /overlay|subtitle|translation|floating/i);
    assert.match(matched.html, /languageSelect/i);
  } finally {
    await preview.stop();
  }
});

test("page language selection UI is present when i18n ships", async (t) => {
  const previews = await Promise.all([
    startWebPreviewServer({
      port: 4743
    }),
    startDesktopPreviewServer({
      port: 4744
    })
  ]);

  try {
    const pages = [];

    if (previews[0]) {
      const response = await fetch(`http://127.0.0.1:${previews[0].port}/`);
      pages.push(await response.text());
    }

    if (previews[1]) {
      const response = await fetch(`http://127.0.0.1:${previews[1].port}/`);
      pages.push(await response.text());
    }

    const html = pages.join("\n");
    const hasLanguageSelector = /pageLanguage|uiLanguage|languageSelect|localeSelect|language-toggle/i.test(html);

    if (!hasLanguageSelector) {
      t.skip("page language selector has not been implemented yet");
      return;
    }

    assert.match(html, /languageSelect/i);
    assert.match(html, /English|zh-CN|简体中文/i);
    assert.match(html, /Open Floating Captions|打开悬浮字幕/i);
  } finally {
    await Promise.all(previews.filter(Boolean).map((preview) => preview.stop()));
  }
});

test("workspace layout exposes three-column product surfaces", async (t) => {
  const previews = await Promise.all([
    startWebPreviewServer({
      port: 4745
    }),
    startDesktopPreviewServer({
      port: 4746
    })
  ]);

  try {
    for (const preview of previews.filter(Boolean)) {
      const response = await fetch(`http://127.0.0.1:${preview.port}/`);
      const html = await response.text();

      assert.match(html, /folderList/i);
      assert.match(html, /Live Transcript Workspace/i);
      assert.match(html, /Progressive Summary/i);
      assert.match(html, /Export Center/i);
    }
  } finally {
    await Promise.all(previews.filter(Boolean).map((preview) => preview.stop()));
  }
});

test('removed AST gateway provider is rejected even with a mock fallback', async () => {
  const gateway = await createGatewayServer({port: 0, asrProvider: 'doubao-ast', asrFallbackProvider: 'mock'});
  await assert.rejects(() => gateway.start(), /Unsupported ASR provider/);
});
