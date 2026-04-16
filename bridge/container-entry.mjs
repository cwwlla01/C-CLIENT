import http from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";

const UI_HOST = process.env.UI_HOST || "0.0.0.0";
const UI_PORT = Number(process.env.UI_PORT || 4273);
const DIST_DIR = path.join(process.cwd(), "dist");
const INDEX_FILE = path.join(DIST_DIR, "index.html");

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const bridgeProcess = spawn(process.execPath, ["./bridge/server.mjs"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

let shuttingDown = false;

function resolveRequestPath(urlPathname) {
  const decodedPath = decodeURIComponent(urlPathname);
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const absolutePath = path.resolve(DIST_DIR, relativePath);
  const distRoot = `${path.resolve(DIST_DIR)}${path.sep}`;

  if (absolutePath !== path.resolve(DIST_DIR) && !absolutePath.startsWith(distRoot)) {
    return null;
  }

  return absolutePath;
}

async function resolveStaticAsset(urlPathname) {
  const requestedPath = resolveRequestPath(urlPathname);
  if (!requestedPath) {
    return { filePath: null, statusCode: 403 };
  }

  try {
    const requestedStat = await stat(requestedPath);
    if (requestedStat.isFile()) {
      return { filePath: requestedPath, statusCode: 200 };
    }
  } catch {
    // Fall through to SPA index fallback.
  }

  await access(INDEX_FILE);
  return { filePath: INDEX_FILE, statusCode: 200 };
}

function writeText(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(body);
}

const uiServer = http.createServer(async (request, response) => {
  if (!request.url) {
    writeText(response, 400, "Bad Request");
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    writeText(response, 405, "Method Not Allowed");
    return;
  }

  try {
    const { pathname } = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const asset = await resolveStaticAsset(pathname);

    if (!asset.filePath) {
      writeText(response, asset.statusCode, "Forbidden");
      return;
    }

    const extension = path.extname(asset.filePath).toLowerCase();
    const contentType = MIME_TYPES.get(extension) || "application/octet-stream";

    response.writeHead(asset.statusCode, {
      "Cache-Control": asset.filePath === INDEX_FILE ? "no-cache" : "public, max-age=31536000, immutable",
      "Content-Type": contentType,
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    createReadStream(asset.filePath).pipe(response);
  } catch (error) {
    writeText(response, 500, error instanceof Error ? error.message : "UI server failed");
  }
});

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  uiServer.close(() => {
    process.exit(exitCode);
  });

  if (!bridgeProcess.killed) {
    bridgeProcess.kill("SIGTERM");
  }

  setTimeout(() => {
    process.exit(exitCode);
  }, 5000).unref();
}

bridgeProcess.on("exit", (code, signal) => {
  if (shuttingDown) {
    return;
  }

  shutdown(code ?? (signal ? 1 : 0));
});

bridgeProcess.on("error", (error) => {
  console.error("[container-entry] failed to start bridge", error);
  shutdown(1);
});

uiServer.on("error", (error) => {
  console.error("[container-entry] failed to start UI server", error);
  shutdown(1);
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

uiServer.listen(UI_PORT, UI_HOST, () => {
  console.log(`[container-entry] UI listening on http://${UI_HOST}:${UI_PORT}`);
});
