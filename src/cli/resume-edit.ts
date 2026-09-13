import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createMarkdownExit } from "markdown-exit";
import { DEFAULT_TEMPLATES } from "@/components/templates/registry";
import { normalizeRichTextContent } from "@/lib/richText";
import type { CustomItem, ResumeData } from "@/types/resume";
import { generateUUID } from "@/utils/uuid";
import {
  STANDARD_SECTION_IDS,
  getDefaultSections,
  getSectionLabel,
  type Locale,
} from "./resume-data";

const md = createMarkdownExit({ html: true, breaks: true, linkify: false });

export class EditError extends Error {}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const RICH_TEXT_KEYS = new Set([
  "skillContent",
  "selfEvaluationContent",
  "details",
  "description",
]);

export const isRichTextPath = (path: string): boolean =>
  tokenize(path).some((token) => typeof token === "string" && RICH_TEXT_KEYS.has(token));

export type PathToken = string | number;

/** `experience[0].company` / `menuSections.2.title` -> `["experience", 0, "company"]` */
export const tokenize = (path: string): PathToken[] => {
  const normalized = path.replace(/\[(\d+)\]/g, ".$1");
  return normalized
    .split(".")
    .filter((segment) => segment !== "")
    .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
};

const getParent = (
  root: Record<string, unknown>,
  tokens: PathToken[]
): { container: Record<string, unknown> | unknown[]; key: PathToken } => {
  if (tokens.length === 0) throw new EditError("empty path");

  let current: unknown = root;
  for (const token of tokens.slice(0, -1)) {
    if (Array.isArray(current)) {
      const index = typeof token === "number" ? token : Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new EditError(`index ${token} out of range in path "${tokens.join(".")}"`);
      }
      current = current[index];
      continue;
    }
    if (!isPlainObject(current)) {
      throw new EditError(`cannot descend into "${String(token)}"`);
    }
    if (!(String(token) in current)) {
      throw new EditError(`unknown field "${String(token)}" in path "${tokens.join(".")}"`);
    }
    current = current[String(token)];
  }

  if (!isPlainObject(current) && !Array.isArray(current)) {
    throw new EditError(`path "${tokens.join(".")}" does not point into an object`);
  }

  return { container: current, key: tokens[tokens.length - 1] };
};

export const getByPath = (resume: ResumeData, path: string): unknown => {
  const tokens = tokenize(normalizeAlias(path));
  let current: unknown = resume;

  for (const token of tokens) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = typeof token === "number" ? token : Number(token);
      current = current[index];
      continue;
    }
    if (isPlainObject(current)) {
      current = current[String(token)];
      continue;
    }
    return undefined;
  }

  return current;
};

const normalizeAlias = (path: string): string =>
  path
    .replace(/^settings\./, "globalSettings.")
    .replace(/^settings$/, "globalSettings");

export interface SetOptions {
  /** Force how the value is interpreted. */
  format?: "auto" | "text" | "markdown" | "html" | "json";
  /** Directory used to resolve `@file` references. */
  baseDir: string;
}

const looksLikeMarkdown = (value: string): boolean =>
  /(^|\n)\s*(?:[-*+] |\d+\. |#{1,6} |> )/.test(value) || /\*\*[^*]+\*\*/.test(value);

const looksLikeHtml = (value: string): boolean => /<\/?[a-z][\s\S]*>/i.test(value);

const markdownToHtml = (value: string): string => md.render(value).trim();

const textToHtml = (value: string): string => normalizeRichTextContent(value);

export const convertRichText = (
  value: string,
  format: SetOptions["format"] = "auto"
): string => {
  if (format === "html") return value;
  if (format === "markdown") return markdownToHtml(value);
  if (format === "text") return textToHtml(value);
  if (looksLikeHtml(value)) return value;
  if (looksLikeMarkdown(value)) return markdownToHtml(value);
  return textToHtml(value);
};

export const resolveValue = async (
  raw: string,
  options: SetOptions
): Promise<string> => {
  if (!raw.startsWith("@")) return raw;

  const filePath = raw.slice(1);
  const absolute = filePath.startsWith("/") ? filePath : `${options.baseDir}/${filePath}`;
  const content = await readFile(absolute, "utf8");
  const extension = extname(filePath).toLowerCase();

  if (options.format && options.format !== "auto") return content;
  if (extension === ".html" || extension === ".htm") return content;
  if (extension === ".md" || extension === ".markdown") return markdownToHtml(content);
  return content;
};

const coerceScalar = (
  target: unknown,
  raw: string,
  format: SetOptions["format"]
): unknown => {
  if (format === "json") return JSON.parse(raw);
  if (typeof target === "boolean" || typeof target === "undefined") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (typeof target === "boolean") {
      throw new EditError(`expected true or false, received "${raw}"`);
    }
    return raw;
  }
  if (typeof target === "number") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new EditError(`expected a number, received "${raw}"`);
    return parsed;
  }
  // Unknown targets stay strings: `set basic.phone 13800138000` must not
  // silently become a number.
  return raw;
};

const SETTABLE_OPTIONAL_FIELDS = new Set([
  "globalSettings.autoOnePage",
]);

export interface SetResult {
  path: string;
  previous: unknown;
  value: unknown;
}

/** Applies one `set` operation in place and reports the previous value. */
export const applySet = async (
  resume: ResumeData,
  rawPath: string,
  rawValue: string,
  options: SetOptions
): Promise<SetResult> => {
  const path = normalizeAlias(rawPath);
  const tokens = tokenize(path);
  const { container, key } = getParent(resume as unknown as Record<string, unknown>, tokens);
  const previous = Array.isArray(container)
    ? container[typeof key === "number" ? key : Number(key)]
    : container[String(key)];

  const richText = isRichTextPath(path);
  const resolvedRaw = await resolveValue(rawValue, options);

  let value: unknown;
  if (richText && options.format !== "json") {
    value = convertRichText(resolvedRaw, options.format);
  } else {
    value = coerceScalar(previous, resolvedRaw, options.format);
  }

  if (Array.isArray(container)) {
    const index = typeof key === "number" ? key : Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= container.length) {
      throw new EditError(`index ${key} out of range for path "${path}"`);
    }
    container[index] = value;
  } else {
    if (!(String(key) in container) && !SETTABLE_OPTIONAL_FIELDS.has(path)) {
      throw new EditError(
        `unknown field "${String(key)}" in path "${path}" (use \`add\` or \`section\` to create new entries)`
      );
    }
    container[String(key)] = value;
  }

  return { path, previous, value };
};

export const applyTemplate = (resume: ResumeData, templateId: string): string => {
  const template = DEFAULT_TEMPLATES.find((item) => item.id === templateId);
  if (!template) {
    throw new EditError(
      `unknown template "${templateId}" (available: ${DEFAULT_TEMPLATES.map((item) => item.id).join(", ")})`
    );
  }

  resume.templateId = template.id;
  resume.globalSettings = {
    ...resume.globalSettings,
    themeColor: template.colorScheme.primary,
    sectionSpacing: template.spacing.sectionGap,
    paragraphSpacing: template.spacing.itemGap,
    pagePadding: template.spacing.contentPadding,
  };
  resume.basic.layout = template.basic.layout;

  return template.id;
};

export interface SectionOptions {
  enable?: boolean;
  order?: number;
  title?: string;
  icon?: string;
  locale?: Locale;
}

export const applySection = (
  resume: ResumeData,
  sectionId: string,
  options: SectionOptions
): { section: ResumeData["menuSections"][number]; created: boolean } => {
  let section = resume.menuSections.find((item) => item.id === sectionId);
  let created = false;

  if (!section) {
    const isStandard = STANDARD_SECTION_IDS.includes(
      sectionId as (typeof STANDARD_SECTION_IDS)[number]
    );
    if (!isStandard && !(sectionId in resume.customData)) {
      throw new EditError(
        `unknown section "${sectionId}" (known: ${STANDARD_SECTION_IDS.join(", ")}, or a custom section created with "add custom")`
      );
    }
    // A blank resume only carries the basic section, so standard sections have
    // to be registered the first time they are used.
    const fallback = getDefaultSections(options.locale ?? "zh").find(
      (item) => item.id === sectionId
    );
    const maxOrder = resume.menuSections.reduce((max, item) => Math.max(max, item.order), -1);
    section = {
      id: sectionId,
      title: fallback?.title ?? getSectionLabel(sectionId, options.locale ?? "zh"),
      icon: fallback?.icon ?? "📌",
      enabled: true,
      order: fallback?.order ?? maxOrder + 1,
    };
    resume.menuSections.push(section);
    created = true;
  }

  if (options.enable !== undefined) section.enabled = options.enable;
  if (options.order !== undefined) section.order = options.order;
  if (options.title !== undefined) section.title = options.title;
  if (options.icon !== undefined) section.icon = options.icon;

  return { section, created };
};

const SECTION_ALIASES: Record<string, string> = {
  experience: "experience",
  experiences: "experience",
  education: "education",
  project: "projects",
  projects: "projects",
  certificate: "certificates",
  certificates: "certificates",
  skill: "skills",
  skills: "skills",
  selfevaluation: "selfEvaluation",
  custom: "custom",
};

export type AddableSection = "experience" | "education" | "projects" | "certificates" | "custom";

export const normalizeSectionName = (name: string): AddableSection | null => {
  const key = SECTION_ALIASES[name.toLowerCase()];
  if (!key || key === "skills" || key === "selfEvaluation") return null;
  return key as AddableSection;
};

export const addItem = (
  resume: ResumeData,
  section: AddableSection,
  fields: Record<string, string>,
  options: { sectionId?: string; baseDir: string; locale?: Locale }
): unknown => {
  const requireField = (name: string): string => {
    const value = fields[name];
    if (value === undefined) throw new EditError(`missing --${name} for "${section}" item`);
    return value;
  };

  /** Standard sections are not registered on a blank resume until they are used. */
  const registerSection = (sectionId: string, title?: string, icon?: string) => {
    if (resume.menuSections.some((entry) => entry.id === sectionId)) return;
    const fallback = getDefaultSections(options.locale ?? "zh").find(
      (entry) => entry.id === sectionId
    );
    const maxOrder = resume.menuSections.reduce((max, entry) => Math.max(max, entry.order), -1);
    resume.menuSections.push({
      id: sectionId,
      title: title ?? fallback?.title ?? getSectionLabel(sectionId, options.locale ?? "zh"),
      icon: icon ?? fallback?.icon ?? "📌",
      enabled: true,
      order: fallback?.order ?? maxOrder + 1,
    });
  };

  switch (section) {
    case "experience": {
      const item = {
        id: generateUUID(),
        company: fields.company ?? "",
        position: fields.position ?? "",
        date: fields.date ?? "",
        details: fields.details ? convertRichText(fields.details, "auto") : "",
        visible: fields.visible !== "false",
      };
      resume.experience.push(item);
      registerSection("experience");
      return item;
    }
    case "education": {
      const item = {
        id: generateUUID(),
        school: fields.school ?? "",
        major: fields.major ?? "",
        degree: fields.degree ?? "",
        startDate: fields.startDate ?? "",
        endDate: fields.endDate ?? "",
        gpa: fields.gpa ?? "",
        description: fields.description ? convertRichText(fields.description, "auto") : "",
        visible: fields.visible !== "false",
      };
      resume.education.push(item);
      registerSection("education");
      return item;
    }
    case "projects": {
      const item = {
        id: generateUUID(),
        name: requireField("name"),
        role: fields.role ?? "",
        date: fields.date ?? "",
        description: fields.description ? convertRichText(fields.description, "auto") : "",
        link: fields.link ?? "",
        linkLabel: fields.linkLabel ?? "",
        visible: fields.visible !== "false",
      };
      resume.projects.push(item);
      registerSection("projects");
      return item;
    }
    case "certificates": {
      const item = {
        id: generateUUID(),
        url: requireField("url"),
        width: fields.width ? Number(fields.width) : 50,
      };
      resume.certificates.push(item);
      registerSection("certificates");
      return item;
    }
    case "custom": {
      const sectionId = options.sectionId;
      if (!sectionId) throw new EditError('custom items require a section id: add custom <sectionId> --title "..."');
      if (!resume.customData[sectionId]) resume.customData[sectionId] = [];
      const item: CustomItem = {
        id: generateUUID(),
        title: fields.title ?? "",
        subtitle: fields.subtitle ?? "",
        dateRange: fields.dateRange ?? "",
        description: fields.description ? convertRichText(fields.description, "auto") : "",
        visible: fields.visible !== "false",
      };
      resume.customData[sectionId].push(item);
      registerSection(sectionId, fields.sectionTitle, fields.icon);
      return item;
    }
    default:
      throw new EditError(`cannot add items to "${section}"`);
  }
};

const listFor = (
  resume: ResumeData,
  section: AddableSection,
  sectionId?: string
): { list: { id: string }[]; label: string } | null => {
  switch (section) {
    case "experience":
      return { list: resume.experience, label: "experience" };
    case "education":
      return { list: resume.education, label: "education" };
    case "projects":
      return { list: resume.projects, label: "projects" };
    case "certificates":
      return { list: resume.certificates, label: "certificates" };
    case "custom": {
      if (!sectionId || !resume.customData[sectionId]) {
        throw new EditError(`unknown custom section "${sectionId ?? ""}"`);
      }
      return { list: resume.customData[sectionId], label: `customData.${sectionId}` };
    }
    default:
      return null;
  }
};

export const removeItem = (
  resume: ResumeData,
  section: AddableSection,
  index: number,
  sectionId?: string
): unknown => {
  const target = listFor(resume, section, sectionId);
  if (!target) throw new EditError(`cannot remove items from "${section}"`);
  if (index < 0 || index >= target.list.length) {
    throw new EditError(`${target.label} has ${target.list.length} items; index ${index} is out of range`);
  }
  return target.list.splice(index, 1)[0];
};

export const moveItem = (
  resume: ResumeData,
  section: AddableSection,
  from: number,
  to: number,
  sectionId?: string
): void => {
  const target = listFor(resume, section, sectionId);
  if (!target) throw new EditError(`cannot reorder "${section}"`);
  const { list } = target;
  if (from < 0 || from >= list.length) throw new EditError(`index ${from} is out of range`);
  const clampedTo = Math.max(0, Math.min(to, list.length - 1));
  const [moved] = list.splice(from, 1);
  list.splice(clampedTo, 0, moved);
};

export const ensureSection = (resume: ResumeData, sectionId: string, locale: Locale): void => {
  if (!resume.menuSections.some((entry) => entry.id === sectionId)) {
    resume.menuSections = getDefaultSections(locale);
    return;
  }
  if (!STANDARD_SECTION_IDS.includes(sectionId as (typeof STANDARD_SECTION_IDS)[number])) {
    if (!resume.customData[sectionId]) resume.customData[sectionId] = [];
  }
};
