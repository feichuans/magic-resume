import { createServer as createHttpServer, type Server } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const contentTypeFor = (filePath: string) =>
  MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";

export const MM_TO_PX = 3.78;
export const A4_WIDTH_MM = 210;
export const A4_HEIGHT_MM = 297;
export const A4_HEIGHT_PX = A4_HEIGHT_MM * MM_TO_PX;
/** Mirrors `src/hooks/useAutoOnePage.ts`: never shrink below 90%. */
export const MIN_ONE_PAGE_SCALE = 0.9;

export interface RenderServerOptions {
  html: string;
  /** Virtual path -> absolute file path, e.g. `/avatar.png` -> `/abs/public/avatar.png`. */
  assetRoutes: Map<string, string>;
  publicDir: string;
}

interface RenderServer {
  origin: string;
  close: () => Promise<void>;
}

/** Serves the resume document plus its fonts/photos on localhost. */
const startRenderServer = async (options: RenderServerOptions): Promise<RenderServer> => {
  const { html, assetRoutes, publicDir } = options;

  const server: Server = createHttpServer((request, response) => {
    const requestPath = decodeURIComponent((request.url ?? "/").split("?")[0]);

    if (requestPath === "/" || requestPath === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }

    const candidates: string[] = [];
    const routed = assetRoutes.get(requestPath);
    if (routed) candidates.push(routed);
    candidates.push(resolve(publicDir, requestPath.replace(/^\/+/, "")));

    const filePath = candidates.find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile()
    );

    if (!filePath) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }

    response.writeHead(200, { "content-type": contentTypeFor(filePath) });
    createReadStream(filePath).pipe(response);
  });

  await new Promise<void>((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });

  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
};

/**
 * Real page count of a rendered PDF. Chrome's `zoom`-based shrink does not
 * paginate the way a plain height/usable-height division predicts, so the count
 * is read back from the file instead of estimated.
 */
export const countPdfPages = (pdf: Buffer): number => {
  const text = pdf.toString("latin1");
  const pageObjects = text.match(/\/Type\s*\/Page(?![s])/g)?.length ?? 0;
  if (pageObjects > 0) return pageObjects;

  const countHint = text.match(/\/Count\s+(\d+)/);
  return countHint ? Number(countHint[1]) : 1;
};

export interface OnePageResult {
  scale: number;
  isScaled: boolean;
  cannotFit: boolean;
}

/** Port of the workbench auto-one-page math (see `src/hooks/useAutoOnePage.ts`). */
export const computeOnePageScale = (
  contentHeightPx: number,
  pagePadding: number,
  minScale = MIN_ONE_PAGE_SCALE
): OnePageResult => {
  const availableHeight = A4_HEIGHT_PX - 2 * pagePadding;
  const actualContentHeight = contentHeightPx - 2 * pagePadding;

  if (actualContentHeight <= availableHeight) {
    return { scale: 1, isScaled: false, cannotFit: false };
  }

  const idealScale = availableHeight / actualContentHeight;
  if (idealScale >= minScale) {
    return { scale: idealScale, isScaled: true, cannotFit: false };
  }

  return { scale: minScale, isScaled: true, cannotFit: true };
};

export interface RenderRequest {
  html: string;
  assetRoutes: Map<string, string>;
  publicDir: string;
  elementId: string;
  pagePadding: number;
  title: string;
  /** Emit a PDF. */
  pdf: boolean;
  /** Emit a PNG. */
  png: boolean;
  /** Scale the content down so it fits exactly one A4 page. */
  onePage: boolean;
  /** Lowest scale `--one-page` may use. */
  minOnePageScale?: number;
  /** Screenshot device scale factor for PNG output. */
  imageScale?: number;
  /**
   * Strip URI annotations from the PDF, keeping each URL as plain text. Some
   * parsers discard an anchored run outright, or fail to file it under a link
   * field, so a text-only URL is the more portable form.
   */
  flatLinks?: boolean;
  browserChannel?: string;
}

export interface RenderResult {
  pdf?: Buffer;
  png?: Buffer;
  contentHeightPx: number;
  pageCount: number;
  onePage: OnePageResult;
  /** True when the produced PDF really has a single page. */
  fitsOnePage: boolean;
  warnings: string[];
}

/**
 * Launch candidates, most specific first. The bundled Playwright Chromium build
 * is preferred; an installed Chrome/Edge channel is the fallback so the CLI
 * works when `playwright install` has not been run for this Playwright version.
 */
const launchBrowser = async (
  channel: string | undefined,
  warnings: string[]
): Promise<Browser> => {
  const candidates: ({ channel?: string } | undefined)[] = channel
    ? [{ channel }]
    : [undefined, { channel: "chrome" }, { channel: "msedge" }];

  const failures: string[] = [];

  for (const candidate of candidates) {
    try {
      const browser = await chromium.launch({ headless: true, ...(candidate ?? {}) });
      if (candidate?.channel) {
        warnings.push(`using the "${candidate.channel}" browser channel (bundled Chromium unavailable)`);
      }
      return browser;
    } catch (error) {
      const message = (error as Error).message.split("\n")[0];
      failures.push(`${candidate?.channel ?? "chromium"}: ${message}`);
    }
  }

  throw new Error(
    `could not launch a browser. Run \`pnpm install:playwright\` (playwright install chromium) or pass --browser-channel chrome.\n${failures.join(
      "\n"
    )}`
  );
};

const waitForAssets = async (page: import("playwright").Page, elementId: string) => {
  await page.evaluate(async (id: string) => {
    const root = document.getElementById(id);
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
    const images = root ? Array.from(root.querySelectorAll("img")) : [];
    await Promise.all(
      images.map(
        (image) =>
          new Promise<void>((resolvePromise) => {
            if (image.complete) {
              resolvePromise();
              return;
            }
            image.addEventListener("load", () => resolvePromise(), { once: true });
            image.addEventListener("error", () => resolvePromise(), { once: true });
          })
      )
    );
  }, elementId);

  // Two animation frames plus a small settle window for layout/font reflow.
  await page.evaluate(
    () =>
      new Promise<void>((resolvePromise) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolvePromise()))
      )
  );
  await page.waitForTimeout(150);
};

export const renderResume = async (request: RenderRequest): Promise<RenderResult> => {
  const warnings: string[] = [];
  const server = await startRenderServer({
    html: request.html,
    assetRoutes: request.assetRoutes,
    publicDir: request.publicDir,
  });

  let browser: Browser | null = null;

  try {
    browser = await launchBrowser(request.browserChannel, warnings);

    const context = await browser.newContext({
      viewport: { width: 794, height: 1123 },
      // Raster exports re-render at a higher device scale factor, which keeps
      // text and images crisp without any post-processing upscale.
      deviceScaleFactor: request.png ? (request.imageScale ?? 2) : 1,
    });
    const page = await context.newPage();

    const missingAssets: string[] = [];
    page.on("response", (response) => {
      if (response.status() === 404) missingAssets.push(response.url());
    });
    page.on("requestfailed", (failed) => {
      const url = failed.url();
      if (url.startsWith(server.origin)) missingAssets.push(url);
    });

    await page.goto(`${server.origin}/index.html`, { waitUntil: "load" });
    await waitForAssets(page, request.elementId);

    // The page gives #resume-preview an A4 min-height so the preview canvas
    // always looks like paper. Pagination and the fit-to-one-page decision need
    // the natural content height instead, so it is dropped before measuring.
    const contentHeightPx = await page.evaluate((id: string) => {
      const root = document.getElementById(id);
      if (!root) throw new Error(`element #${id} not found`);
      root.style.setProperty("min-height", "0", "important");
      return Math.max(root.scrollHeight, root.getBoundingClientRect().height);
    }, request.elementId);

    const onePage = request.onePage
      ? computeOnePageScale(
          contentHeightPx,
          request.pagePadding,
          request.minOnePageScale ?? MIN_ONE_PAGE_SCALE
        )
      : { scale: 1, isScaled: false, cannotFit: false };

    const usableHeight = A4_HEIGHT_PX - 2 * request.pagePadding;
    const actualContentHeight = contentHeightPx - 2 * request.pagePadding;
    const idealScale = usableHeight / actualContentHeight;

    const estimatedPages =
      actualContentHeight <= usableHeight
        ? 1
        : Math.ceil(actualContentHeight / usableHeight);

    let pdf: Buffer | undefined;
    let pageCount = estimatedPages;
    if (request.pdf) {
      // Padding moves into the @page margin so every page keeps the same gutter.
      await page.evaluate(
        ({ id, padding, scale, scaled, flatLinks }) => {
          const root = document.getElementById(id);
          if (!root) return;
          root.style.setProperty("padding", "0", "important");
          if (scaled) {
            // `zoom` (unlike `transform`) participates in pagination math.
            root.style.setProperty("zoom", String(scale));
            root.style.setProperty("width", "100%", "important");
          }
          if (flatLinks) {
            // Chrome turns every <a href> into a URI annotation. A parser that
            // strips anchors loses the URL, so drop the href and keep the text.
            root.querySelectorAll("a[href]").forEach((anchor) => {
              anchor.removeAttribute("href");
              anchor.removeAttribute("target");
              anchor.removeAttribute("rel");
            });
          }
        },
        {
          id: request.elementId,
          padding: request.pagePadding,
          scale: onePage.scale,
          scaled: onePage.isScaled,
          flatLinks: request.flatLinks === true,
        }
      );
      await page.waitForTimeout(120);

      pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: {
          top: `${request.pagePadding}px`,
          bottom: `${request.pagePadding}px`,
          left: `${request.pagePadding}px`,
          right: `${request.pagePadding}px`,
        },
      });

      pageCount = countPdfPages(pdf);

      // Chrome's zoom shrink does not paginate the way the height arithmetic
      // predicts, so the outcome is judged against the produced file rather
      // than against `onePage.cannotFit`.
      if (pageCount > 1 && onePage.isScaled) {
        warnings.push(
          `still ${pageCount} A4 pages at ${(onePage.scale * 100).toFixed(0)}% scale (the raw ratio suggested ${(idealScale * 100).toFixed(1)}%): trim content or lower --min-scale`
        );
      } else if (pageCount > 1) {
        warnings.push(`content spans ${pageCount} A4 pages`);
      }
    }

    let png: Buffer | undefined;
    if (request.png) {
      await page.evaluate(
        ({ id, padding }) => {
          const root = document.getElementById(id);
          if (!root) return;
          root.style.removeProperty("zoom");
          root.style.setProperty("padding", `${padding}px`, "important");
          root.style.setProperty("width", "210mm", "important");
          root.style.setProperty("min-height", "0", "important");
        },
        { id: request.elementId, padding: request.pagePadding }
      );
      await page.waitForTimeout(120);

      png = await page.locator(`#${request.elementId}`).screenshot({ type: "png" });
    }

    for (const url of Array.from(new Set(missingAssets))) {
      warnings.push(`asset failed to load: ${url.replace(server.origin, "")}`);
    }

    return { pdf, png, contentHeightPx, pageCount, onePage, fitsOnePage: pageCount === 1, warnings };
  } finally {
    await browser?.close();
    await server.close();
  }
};
