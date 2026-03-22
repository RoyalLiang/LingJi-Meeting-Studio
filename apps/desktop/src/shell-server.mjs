import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const baseDir = path.dirname(fileURLToPath(import.meta.url));

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

async function sendFile(response, filePath) {
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] ?? "text/plain; charset=utf-8"
    });
    response.end(content);
  } catch {
    response.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8"
    });
    response.end("not found");
  }
}

function createHandler() {
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/" || url.pathname === "/index.html") {
      await sendFile(response, path.join(baseDir, "shell.html"));
      return;
    }

    if (url.pathname === "/overlay" || url.pathname === "/overlay.html") {
      await sendFile(response, path.join(baseDir, "overlay.html"));
      return;
    }

    if (url.pathname === "/shell.js") {
      await sendFile(response, path.join(baseDir, "shell.js"));
      return;
    }

    if (url.pathname === "/shell.generated.css") {
      await sendFile(response, path.join(baseDir, "shell.generated.css"));
      return;
    }

    if (url.pathname === "/overlay.js") {
      await sendFile(response, path.join(baseDir, "overlay.js"));
      return;
    }

    if (url.pathname === "/i18n.js") {
      await sendFile(response, path.join(baseDir, "i18n.js"));
      return;
    }

    if (url.pathname === "/preview-channel.js") {
      await sendFile(response, path.join(baseDir, "preview-channel.js"));
      return;
    }

    response.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8"
    });
    response.end("not found");
  };
}

export function createDesktopShellPreviewServer(options = {}) {
  const host = options.host ?? process.env.DESKTOP_PREVIEW_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.DESKTOP_PREVIEW_PORT ?? 3040);
  const server = http.createServer(createHandler());

  return {
    server,
    start() {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          resolve({
            host,
            port
          });
        });
      });
    },
    stop() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  const app = createDesktopShellPreviewServer();
  const { host, port } = await app.start();
  console.log(`[desktop-preview] listening on http://${host}:${port}`);
}
