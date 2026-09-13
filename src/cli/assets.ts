import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export const getMimeType = (filePath: string): string =>
  MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";

export const fileToDataUrl = async (filePath: string): Promise<string> => {
  const buffer = await readFile(filePath);
  return `data:${getMimeType(filePath)};base64,${buffer.toString("base64")}`;
};

export const isRemoteUrl = (value: string): boolean =>
  /^(?:https?:|data:|file:)/i.test(value.trim());

export const resolveLocalPath = (
  value: string,
  baseDir: string,
  publicDir: string
): string | null => {
  const raw = value.trim();
  if (!raw) return null;

  const candidates: string[] = [];
  if (raw.startsWith("/")) {
    candidates.push(resolve(publicDir, raw.replace(/^\/+/, "")));
  }
  candidates.push(isAbsolute(raw) ? raw : resolve(baseDir, raw));

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

export interface ResolveImageOptions {
  baseDir: string;
  publicDir: string;
  /** Used when the referenced file cannot be found. */
  fallbackUrl?: string;
}

/**
 * Resolves a photo/certificate reference (absolute path, project-relative path,
 * `/public` path, remote URL or data URL) into a self-contained data URL so the
 * headless browser never needs to load a local file.
 */
export const resolveImageToDataUrl = async (
  value: string | undefined,
  options: ResolveImageOptions
): Promise<string> => {
  const raw = (value ?? "").trim();
  if (!raw) return "";

  if (/^data:/i.test(raw)) return raw;
  if (/^https?:/i.test(raw)) return raw;

  const localPath = resolveLocalPath(raw, options.baseDir, options.publicDir);
  if (!localPath) {
    return options.fallbackUrl ?? raw;
  }

  return fileToDataUrl(localPath);
};

export interface LocalAsset {
  url: string;
  path: string;
  mime: string;
}

/**
 * Collects every local asset referenced by a resume so the renderer can serve
 * them through a virtual `file://`-free HTTP route.
 */
export const collectResumeAssets = (
  resume: {
    basic?: { photo?: string };
    certificates?: { url?: string }[];
  },
  options: { baseDir: string; publicDir: string }
): LocalAsset[] => {
  const values = [
    resume.basic?.photo,
    ...(resume.certificates ?? []).map((certificate) => certificate.url),
  ].filter((value): value is string => typeof value === "string" && value.trim() !== "");

  const assets: LocalAsset[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (isRemoteUrl(value)) continue;
    const localPath = resolveLocalPath(value, options.baseDir, options.publicDir);
    if (!localPath || seen.has(localPath)) continue;
    seen.add(localPath);
    assets.push({
      url: value,
      path: localPath,
      mime: getMimeType(localPath),
    });
  }

  return assets;
};
