import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { normalizeFontFamily } from "@/utils/fonts";
import type { ResumeData } from "@/types/resume";
import { collectResumeAssets } from "./assets";
import { renderResume, type OnePageResult } from "./browser-render";
import { buildResumeHtml, PREVIEW_ELEMENT_ID } from "./render-page";
import type { Locale } from "./resume-data";

const GLOBAL_CSS_ENTRY = "/src/app/globals.css?direct";
const FONT_CSS_ENTRY = "/src/app/font.css?direct";
const TIPTAP_CSS_ENTRY = "/src/styles/tiptap.scss?direct";

export interface RendererPaths {
  projectRoot: string;
  publicDir: string;
  cacheDir: string;
}

export interface RenderOptions {
  format: "pdf" | "png";
  locale?: Locale;
  onePage?: boolean;
  /** Lowest scale `--one-page` may use (default 0.9, matching the web app). */
  minOnePageScale?: number;
  imageScale?: number;
  /**
   * Emit URLs as plain text instead of link annotations. Some parsers drop an
   * anchored run, so the text-only form is the more portable one.
   */
  flatLinks?: boolean;
  browserChannel?: string;
  /** Also write the intermediate HTML next to the output file. */
  saveHtml?: boolean;
  outputPath: string;
  onProgress?: (message: string) => void;
}

export interface RenderOutput {
  outputPath: string;
  htmlPath?: string;
  bytes: number;
  contentHeightPx: number;
  pageCount: number;
  onePage: OnePageResult;
  /** True when the produced PDF really has a single page. */
  fitsOnePage: boolean;
  warnings: string[];
  durationMs: number;
}

export interface PreviewServer {
  origin: string;
  close: () => Promise<void>;
}

/**
 * Owns the Vite instance used to (1) build the project's Tailwind + component
 * CSS on demand and (2) load the TSX template tree for server-side rendering.
 */
export class ResumeRenderer {
  private server: ViteDevServer | null = null;
  private cssCache: string | null = null;
  private moduleCache = new Map<string, unknown>();

  constructor(private readonly paths: RendererPaths) {}

  private getServer = async (): Promise<ViteDevServer> => {
    if (this.server) return this.server;

    this.server = await createServer({
      root: this.paths.projectRoot,
      configFile: false,
      appType: "custom",
      logLevel: "warn",
      mode: "development",
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [tsconfigPaths(), react()],
    });

    return this.server;
  };

  /** Tailwind (scanned from the repo sources) plus the font-face and tiptap rules. */
  getCss = async (): Promise<string> => {
    if (this.cssCache) return this.cssCache;

    const server = await this.getServer();
    const [globals, fonts, tiptap] = await Promise.all([
      server.transformRequest(GLOBAL_CSS_ENTRY),
      server.transformRequest(FONT_CSS_ENTRY),
      server.transformRequest(TIPTAP_CSS_ENTRY),
    ]);

    for (const [label, result] of [
      ["globals.css", globals],
      ["font.css", fonts],
      ["tiptap.scss", tiptap],
    ] as const) {
      if (!result) throw new Error(`failed to build ${label}`);
    }

    this.cssCache = [globals!.code, fonts!.code, tiptap!.code].join("\n");
    return this.cssCache;
  };

  loadModule = async <T>(modulePath: string): Promise<T> => {
    const cached = this.moduleCache.get(modulePath);
    if (cached) return cached as T;

    const server = await this.getServer();
    const loaded = (await server.ssrLoadModule(modulePath)) as T;
    this.moduleCache.set(modulePath, loaded);
    return loaded;
  };

  /** Resolves photo/certificate paths to data URLs and maps the virtual routes. */
  prepareResume = async (resume: ResumeData) => {
    const assetRoutes = new Map<string, string>();

    for (const asset of collectResumeAssets(resume, {
      baseDir: this.paths.projectRoot,
      publicDir: this.paths.publicDir,
    })) {
      assetRoutes.set(asset.url.startsWith("/") ? asset.url : `/${asset.url}`, asset.path);
    }

    const { resolveImageToDataUrl } = await import("./assets");
    const fallback = existsSync(join(this.paths.publicDir, "avatar.png"))
      ? await resolveImageToDataUrl("/avatar.png", {
          baseDir: this.paths.projectRoot,
          publicDir: this.paths.publicDir,
        })
      : "";

    const prepared: ResumeData = {
      ...resume,
      basic: {
        ...resume.basic,
        photo: await resolveImageToDataUrl(resume.basic?.photo, {
          baseDir: this.paths.projectRoot,
          publicDir: this.paths.publicDir,
          fallbackUrl: fallback,
        }),
      },
      certificates: resume.certificates.map((certificate) => ({
        ...certificate,
        url: certificate.url,
      })),
    };

    return { resume: prepared, assetRoutes };
  };

  buildHtml = async (
    resume: ResumeData,
    locale: Locale
  ): Promise<{ html: string; assetRoutes: Map<string, string> }> => {
    const [{ resume: prepared, assetRoutes }, css] = await Promise.all([
      this.prepareResume(resume),
      this.getCss(),
    ]);

    const html = buildResumeHtml(prepared, {
      css,
      locale,
      fontFamily: normalizeFontFamily(resume.globalSettings?.fontFamily),
      title: resume.title,
    });

    return { html, assetRoutes };
  };

  render = async (resume: ResumeData, options: RenderOptions): Promise<RenderOutput> => {
    const started = Date.now();
    const locale = options.locale ?? "zh";
    const { html, assetRoutes } = await this.buildHtml(resume, locale);

    options.onProgress?.(`rendering ${options.format.toUpperCase()}`);

    const result = await renderResume({
      html,
      assetRoutes,
      publicDir: this.paths.publicDir,
      elementId: PREVIEW_ELEMENT_ID,
      pagePadding: resume.globalSettings?.pagePadding ?? 32,
      title: resume.title,
      pdf: options.format === "pdf",
      png: options.format === "png",
      onePage: options.onePage ?? true,
      minOnePageScale: options.minOnePageScale,
      imageScale: options.imageScale,
      flatLinks: options.flatLinks,
      browserChannel: options.browserChannel,
    });

    const payload = options.format === "pdf" ? result.pdf : result.png;
    if (!payload) throw new Error(`renderer produced no ${options.format} output`);

    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, payload);

    let htmlPath: string | undefined;
    if (options.saveHtml) {
      htmlPath = options.outputPath.replace(/\.[^.]+$/, "") + ".html";
      await writeFile(htmlPath, html, "utf8");
    }

    return {
      outputPath: options.outputPath,
      htmlPath,
      bytes: payload.length,
      contentHeightPx: result.contentHeightPx,
      pageCount: result.pageCount,
      onePage: result.onePage,
      fitsOnePage: result.fitsOnePage,
      warnings: result.warnings,
      durationMs: Date.now() - started,
    };
  };

  /** Serves the rendered resume in a browser (same markup as the exports). */
  serve = async (resume: ResumeData, locale: Locale): Promise<PreviewServer> => {
    const { html, assetRoutes } = await this.buildHtml(resume, locale);
    const { createServer: createHttpServer } = await import("node:http");
    const { createReadStream, statSync } = await import("node:fs");
    const { extname } = await import("node:path");

    const mime: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".ttf": "font/ttf",
      ".otf": "font/otf",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    };

    const server = createHttpServer((request, response) => {
      const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
      if (path === "/" || path === "/index.html") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }

      const candidates = [
        assetRoutes.get(path),
        resolve(this.paths.publicDir, path.replace(/^\/+/, "")),
      ].filter((value): value is string => Boolean(value));

      const file = candidates.find(
        (candidate) => existsSync(candidate) && statSync(candidate).isFile()
      );

      if (!file) {
        response.writeHead(404);
        response.end("not found");
        return;
      }

      response.writeHead(200, {
        "content-type": mime[extname(file).toLowerCase()] ?? "application/octet-stream",
      });
      createReadStream(file).pipe(response);
    });

    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    return {
      origin: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((done) => {
          server.close(() => done());
        }),
    };
  };

  dispose = async () => {
    await this.server?.close();
    this.server = null;
    this.cssCache = null;
    this.moduleCache.clear();
  };
}

export const resolveRendererPaths = (projectRoot: string, cacheDir: string): RendererPaths => ({
  projectRoot,
  publicDir: resolve(projectRoot, "public"),
  cacheDir,
});

export const readResumeFile = async (filePath: string): Promise<unknown> => {
  const raw = await readFile(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`failed to parse ${filePath}: ${(error as Error).message}`);
  }
};

export const importTsModule = async <T>(absolutePath: string): Promise<T> =>
  (await import(pathToFileURL(absolutePath).href)) as T;
