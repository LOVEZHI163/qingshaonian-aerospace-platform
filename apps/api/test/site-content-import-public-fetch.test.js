import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { fetchPublicResource } from "../src/services/site-content-import/public-fetch.js";

async function withHttpServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  try {
    return await callback(port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function localPinnedResolver(port, calls = []) {
  return async (rawUrl) => {
    const url = new URL(rawUrl);
    calls.push(url.href);
    url.port = String(port);
    return {
      url,
      hostname: url.hostname,
      addresses: [{ address: "127.0.0.1", family: 4 }],
      selectedAddress: { address: "127.0.0.1", family: 4 }
    };
  };
}

test("connects to the validated address while preserving the original host header", async () => {
  await withHttpServer((request, response) => {
    assert.equal(request.headers.host, `article.public.test:${request.socket.localPort}`);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<html><body>article</body></html>");
  }, async (port) => {
    const result = await fetchPublicResource(`http://article.public.test:${port}/news?id=1`, {
      expected: "html",
      resolveTarget: localPinnedResolver(port)
    });

    assert.equal(result.status, 200);
    assert.equal(result.finalUrl, `http://article.public.test:${port}/news?id=1`);
    assert.equal(result.buffer.toString(), "<html><body>article</body></html>");
  });
});

test("revalidates every redirect target before making the next request", async () => {
  const calls = [];
  await withHttpServer((request, response) => {
    if (request.url === "/start") {
      response.writeHead(302, { Location: "/middle" });
      response.end();
      return;
    }
    if (request.url === "/middle") {
      response.writeHead(307, { Location: `http://cdn.public.test:${request.socket.localPort}/final` });
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<article>done</article>");
  }, async (port) => {
    const result = await fetchPublicResource(`http://article.public.test:${port}/start`, {
      expected: "html",
      resolveTarget: localPinnedResolver(port, calls)
    });

    assert.deepEqual(calls, [
      `http://article.public.test:${port}/start`,
      `http://article.public.test:${port}/middle`,
      `http://cdn.public.test:${port}/final`
    ]);
    assert.equal(result.finalUrl, `http://cdn.public.test:${port}/final`);
  });
});

test("stops after three redirects", async () => {
  await withHttpServer((request, response) => {
    const current = Number(request.url.slice(1) || 0);
    response.writeHead(302, { Location: `/${current + 1}` });
    response.end();
  }, async (port) => {
    await assert.rejects(
      fetchPublicResource(`http://loop.public.test:${port}/0`, {
        expected: "html",
        maxRedirects: 3,
        resolveTarget: localPinnedResolver(port)
      }),
      (error) => error?.status === 422 && error?.code === "IMPORT_URL_BLOCKED"
    );
  });
});

test("applies one timeout budget to the resource request", async () => {
  await withHttpServer((_request, response) => {
    setTimeout(() => {
      if (!response.destroyed) {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("late");
      }
    }, 200);
  }, async (port) => {
    await assert.rejects(
      fetchPublicResource(`http://slow.public.test:${port}/article`, {
        expected: "html",
        timeoutMs: 30,
        resolveTarget: localPinnedResolver(port)
      }),
      (error) => error?.status === 504 && error?.code === "IMPORT_FETCH_TIMEOUT"
    );
  });
});

test("enforces the byte limit after decompressing html", async () => {
  const compressed = gzipSync(Buffer.alloc(32_000, "a"));
  await withHttpServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/html",
      "Content-Encoding": "gzip",
      "Content-Length": compressed.length
    });
    response.end(compressed);
  }, async (port) => {
    await assert.rejects(
      fetchPublicResource(`http://large.public.test:${port}/article`, {
        expected: "html",
        maxBytes: 1_024,
        resolveTarget: localPinnedResolver(port)
      }),
      (error) => error?.status === 413 && error?.code === "IMPORT_RESPONSE_TOO_LARGE"
    );
  });
});

test("rejects content types that do not match the requested resource", async () => {
  await withHttpServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{}");
  }, async (port) => {
    await assert.rejects(
      fetchPublicResource(`http://json.public.test:${port}/article`, {
        expected: "html",
        resolveTarget: localPinnedResolver(port)
      }),
      (error) => error?.status === 422 && error?.code === "IMPORT_UNSUPPORTED_CONTENT"
    );
  });
});

test("returns supported images and applies their own byte limit", async () => {
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await withHttpServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "image/jpeg" });
    response.end(image);
  }, async (port) => {
    const result = await fetchPublicResource(`http://image.public.test:${port}/photo.jpg`, {
      expected: "image",
      maxBytes: image.length,
      resolveTarget: localPinnedResolver(port)
    });
    assert.equal(result.headers["content-type"], "image/jpeg");
    assert.deepEqual(result.buffer, image);

    await assert.rejects(
      fetchPublicResource(`http://image.public.test:${port}/photo.jpg`, {
        expected: "image",
        maxBytes: image.length - 1,
        resolveTarget: localPinnedResolver(port)
      }),
      (error) => error?.code === "IMPORT_RESPONSE_TOO_LARGE"
    );
  });
});
