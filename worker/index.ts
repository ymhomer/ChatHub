/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import { cleanTransfers } from "../lib/server/transfers";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  CHATHUB_FRONTEND_ORIGIN?: string;
  DB: D1Database;
  BUCKET: R2Bucket;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

let nextTransferCleanup = 0;

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const frontend = env.CHATHUB_FRONTEND_ORIGIN;
    const origin = request.headers.get("Origin");
    const api = url.pathname.startsWith("/api/");
    const allowed = Boolean(frontend && origin === frontend);

    if (frontend) {
      // Sites dispatch injects these headers. An independent Worker receives
      // untrusted client headers and only accepts its own application sessions.
      const headers = new Headers(request.headers);
      for (const key of [...headers.keys()]) {
        if (key.startsWith("oai-authenticated-user-")) headers.delete(key);
      }
      request = new Request(request, { headers });

      if (request.method === "OPTIONS" && api) {
        if (!allowed) return new Response(null, { status: 403 });
        return new Response(null, { status: 204, headers: {
          "Access-Control-Allow-Origin": frontend,
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE",
          "Access-Control-Allow-Headers": "Content-Type, Range, If-Match",
          "Vary": "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
        } });
      }
      if (api && !["GET", "HEAD"].includes(request.method) && !allowed && origin !== url.origin) {
        return new Response(null, { status: 403 });
      }
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/api/transfers" ||
      url.pathname.startsWith("/transfer/")) && Date.now() >= nextTransferCleanup) {
      nextTransferCleanup = Date.now() + 5 * 60000;
      ctx.waitUntil(cleanTransfers().catch(() => {}));
    }

    const response = await handler.fetch(request, env, ctx);
    if (!frontend || !api) return response;
    const headers = new Headers(response.headers);
    headers.append("Vary", "Origin");
    if (allowed) {
      headers.set("Access-Control-Allow-Origin", frontend);
      headers.set("Access-Control-Allow-Credentials", "true");
      headers.set("Access-Control-Expose-Headers", "ETag, Content-Range, Accept-Ranges, Content-Disposition");
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};

export default worker;
