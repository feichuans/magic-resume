import { DEFAULT_TEMPLATES } from "@/components/templates/registry";
import { DEFAULT_FIELD_ORDER } from "@/config/constants";
import {
  blankResumeState,
  blankResumeStateEn,
  initialResumeState,
  initialResumeStateEn,
} from "@/config/initialResumeData";
import enMessages from "@/i18n/locales/en.json";
import zhMessages from "@/i18n/locales/zh.json";
import { DEFAULT_CONFIG } from "@/types/resume";
import type {
  BasicInfo,
  Certificate,
  CustomItem,
  Education,
  Experience,
  GlobalSettings,
  MenuSection,
  PhotoConfig,
  Project,
  ResumeData,
} from "@/types/resume";
import { generateUUID } from "@/utils/uuid";

export type Locale = "zh" | "en";

export const STANDARD_SECTION_IDS = [
  "basic",
  "skills",
  "experience",
  "projects",
  "education",
  "selfEvaluation",
  "certificates",
] as const;

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const asString = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
};

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asString(item)).filter(Boolean);
};

const ensureId = (value: unknown, fallback: string): string =>
  asString(value) || fallback;

const deepMerge = (base: unknown, override: unknown): unknown => {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    result[key] = key in result ? deepMerge(result[key], value) : value;
  }
  return result;
};

export const getDefaultSections = (locale: Locale): MenuSection[] =>
  clone((locale === "en" ? initialResumeStateEn : initialResumeState).menuSections);

/**
 * Section titles come from the app's own locale files, so a section registered
 * by the CLI reads the same as one created in the web workbench.
 */
export const getSectionLabel = (sectionId: string, locale: Locale = "zh"): string => {
  const messages = (locale === "en" ? enMessages : zhMessages) as {
    workbench: { sidePanel: { layout: { standardSections: Record<string, string> } } };
  };

  return messages.workbench.sidePanel.layout.standardSections[sectionId] ?? sectionId;
};

/**
 * Guesses the document language from its section titles, which the web app
 * stores per locale. Falls back to a CJK check on the resume contents.
 */
export const detectLocale = (resume: {
  menuSections?: { title: string }[];
  basic?: { name?: string; title?: string };
}): Locale => {
  const zhTitles = new Set(initialResumeState.menuSections.map((section) => section.title));
  const enTitles = new Set(initialResumeStateEn.menuSections.map((section) => section.title));

  let zhHits = 0;
  let enHits = 0;
  for (const section of resume.menuSections ?? []) {
    if (zhTitles.has(section.title)) zhHits += 1;
    if (enTitles.has(section.title)) enHits += 1;
  }

  if (enHits > zhHits) return "en";
  if (zhHits > enHits) return "zh";

  const probe = `${resume.basic?.name ?? ""}${resume.basic?.title ?? ""}`;
  return /[\u4e00-\u9fff]/.test(probe) ? "zh" : "en";
};

/** A resume with the sample content of the web app (used by `init`). */
export const getSampleResume = (locale: Locale = "zh"): ResumeData => {
  const source = locale === "en" ? initialResumeStateEn : initialResumeState;
  const now = new Date().toISOString();
  return {
    ...clone(source),
    id: generateUUID(),
    createdAt: now,
    updatedAt: now,
    templateId: DEFAULT_TEMPLATES[0]?.id ?? "classic",
  } as ResumeData;
};

/** An empty resume skeleton: standard sections, no content. */
export const getBlankResume = (locale: Locale = "zh"): ResumeData => {
  const source = locale === "en" ? blankResumeStateEn : blankResumeState;
  const now = new Date().toISOString();
  return {
    ...clone(source),
    id: generateUUID(),
    createdAt: now,
    updatedAt: now,
    templateId: DEFAULT_TEMPLATES[0]?.id ?? "classic",
    menuSections: getDefaultSections(locale),
  } as ResumeData;
};

/**
 * Accepts a plain resume object, an app JSON export, or a raw localStorage dump
 * (`{ state: { resumes, activeResumeId } }`) and returns a single resume object.
 */
export const unwrapResume = (raw: unknown): Record<string, unknown> => {
  if (!isPlainObject(raw)) {
    throw new Error("resume JSON must be an object");
  }

  if (isPlainObject(raw.resumes)) {
    const resumes = raw.resumes as Record<string, unknown>;
    const activeId = asString(raw.activeResumeId);
    const picked = (activeId && resumes[activeId]) || Object.values(resumes)[0];
    if (picked) return unwrapResume(picked);
  }

  if (isPlainObject(raw.state)) {
    return unwrapResume(raw.state);
  }

  return raw;
};

const normalizePhotoConfig = (value: unknown): PhotoConfig => {
  const input = isPlainObject(value) ? value : {};
  const merged = { ...DEFAULT_CONFIG, ...input } as PhotoConfig;
  merged.width = asNumber(input.width) ?? DEFAULT_CONFIG.width;
  merged.height = asNumber(input.height) ?? DEFAULT_CONFIG.height;
  merged.customBorderRadius =
    asNumber(input.customBorderRadius) ?? DEFAULT_CONFIG.customBorderRadius;
  merged.visible = asBoolean(input.visible, DEFAULT_CONFIG.visible ?? true);
  return merged;
};

const normalizeBasic = (value: unknown, fallback: BasicInfo): BasicInfo => {
  const input = isPlainObject(value) ? value : {};
  const fieldOrderSource = Array.isArray(input.fieldOrder)
    ? input.fieldOrder
    : fallback.fieldOrder ?? DEFAULT_FIELD_ORDER;

  return {
    birthDate: asString(input.birthDate),
    name: asString(input.name),
    title: asString(input.title),
    email: asString(input.email),
    phone: asString(input.phone),
    location: asString(input.location),
    icons: isPlainObject(input.icons)
      ? Object.fromEntries(
          Object.entries(input.icons).map(([key, icon]) => [key, asString(icon)])
        )
      : {},
    employementStatus: asString(input.employementStatus),
    photo: asString(input.photo),
    photoConfig: normalizePhotoConfig(input.photoConfig),
    fieldOrder: fieldOrderSource.map((field, index) => {
      const item = isPlainObject(field) ? field : {};
      return {
        id: ensureId(item.id, `field-${index + 1}`),
        key: (asString(item.key) || "name") as keyof BasicInfo,
        label: asString(item.label),
        type: (asString(item.type) || "text") as "date" | "textarea" | "text" | "editor",
        visible: asBoolean(item.visible, true),
        custom: item.custom === true ? true : undefined,
      };
    }),
    customFields: asArray(input.customFields).map((field, index) => {
      const item = isPlainObject(field) ? field : {};
      return {
        id: ensureId(item.id, `custom-field-${index + 1}`),
        label: asString(item.label),
        value: asString(item.value),
        icon: asString(item.icon) || undefined,
        visible: asBoolean(item.visible, true),
        displayLabel: item.displayLabel === true ? true : undefined,
      };
    }),
    githubKey: asString(input.githubKey),
    githubUseName: asString(input.githubUseName),
    githubContributionsVisible: asBoolean(input.githubContributionsVisible, false),
    layout:
      input.layout === "left" || input.layout === "center" || input.layout === "right"
        ? input.layout
        : fallback.layout ?? "left",
  };
};

const normalizeGlobalSettings = (value: unknown, fallback: GlobalSettings): GlobalSettings => {
  const input = isPlainObject(value) ? value : {};
  const merged: GlobalSettings = { ...fallback };

  for (const key of Object.keys(fallback) as (keyof GlobalSettings)[]) {
    if (!(key in input)) continue;
    const raw = input[key];
    if (key === "themeColor" || key === "fontFamily") {
      merged[key] = asString(raw) || undefined;
      continue;
    }
    if (key === "useIconMode" || key === "centerSubtitle" || key === "flexibleHeaderLayout" || key === "autoOnePage" || key === "pageBreakLinesVisible") {
      merged[key] = asBoolean(raw, Boolean(fallback[key]));
      continue;
    }
    const numeric = asNumber(raw);
    if (numeric !== undefined) {
      (merged[key] as number) = numeric;
    }
  }

  return merged;
};

const normalizeEducation = (value: unknown): Education[] =>
  asArray(value).map((entry, index) => {
    const item = isPlainObject(entry) ? entry : {};
    return {
      id: ensureId(item.id, `education-${index + 1}`),
      school: asString(item.school),
      major: asString(item.major),
      degree: asString(item.degree),
      startDate: asString(item.startDate),
      endDate: asString(item.endDate),
      gpa: asString(item.gpa),
      description: asString(item.description),
      visible: asBoolean(item.visible, true),
    };
  });

const normalizeExperience = (value: unknown): Experience[] =>
  asArray(value).map((entry, index) => {
    const item = isPlainObject(entry) ? entry : {};
    return {
      id: ensureId(item.id, `experience-${index + 1}`),
      company: asString(item.company),
      position: asString(item.position),
      date: asString(item.date),
      details: asString(item.details ?? item.description),
      visible: asBoolean(item.visible, true),
    };
  });

const normalizeProjects = (value: unknown): Project[] =>
  asArray(value).map((entry, index) => {
    const item = isPlainObject(entry) ? entry : {};
    return {
      id: ensureId(item.id, `project-${index + 1}`),
      name: asString(item.name),
      role: asString(item.role),
      date: asString(item.date),
      description: asString(item.description ?? item.details),
      visible: asBoolean(item.visible, true),
      link: asString(item.link) || undefined,
      linkLabel: asString(item.linkLabel) || undefined,
    };
  });

const normalizeCertificates = (value: unknown): Certificate[] =>
  asArray(value).map((entry, index) => {
    const item = isPlainObject(entry) ? entry : {};
    const width = asNumber(item.width);
    return {
      id: ensureId(item.id, `certificate-${index + 1}`),
      url: asString(item.url),
      width: width !== undefined ? width : 50,
    };
  });

const normalizeCustomData = (value: unknown): Record<string, CustomItem[]> => {
  if (!isPlainObject(value)) return {};

  const result: Record<string, CustomItem[]> = {};
  for (const [sectionId, items] of Object.entries(value)) {
    result[sectionId] = asArray(items).map((entry, index) => {
      const item = isPlainObject(entry) ? entry : {};
      return {
        id: ensureId(item.id, `${sectionId}-${index + 1}`),
        title: asString(item.title),
        subtitle: asString(item.subtitle),
        dateRange: asString(item.dateRange),
        description: asString(item.description),
        visible: asBoolean(item.visible, true),
      };
    });
  }
  return result;
};

const normalizeMenuSections = (value: unknown, locale: Locale): MenuSection[] => {
  const items = asArray(value);
  if (items.length === 0) return getDefaultSections(locale);

  return items.map((entry, index) => {
    const item = isPlainObject(entry) ? entry : {};
    const order = asNumber(item.order);
    return {
      id: asString(item.id) || `section-${index + 1}`,
      title: asString(item.title),
      icon: asString(item.icon),
      enabled: asBoolean(item.enabled, true),
      order: order !== undefined ? order : index,
    };
  });
};

export interface NormalizeOptions {
  locale?: Locale;
  templateId?: string | null;
}

/**
 * Turns loosely-typed JSON into a resume object the templates can render:
 * defaults filled in, ids assigned, `visible` flags materialised, sections registered.
 */
export const normalizeResume = (raw: unknown, options: NormalizeOptions = {}): ResumeData => {
  const locale = options.locale ?? "zh";
  const base = getBlankResume(locale);
  const input = unwrapResume(raw);
  const merged = deepMerge(base, input) as Record<string, unknown>;

  const resume: ResumeData = {
    id: asString(merged.id) || generateUUID(),
    title: asString(merged.title) || "Resume",
    createdAt: asString(merged.createdAt) || new Date().toISOString(),
    updatedAt: asString(merged.updatedAt) || new Date().toISOString(),
    templateId: options.templateId ?? asString(merged.templateId) ?? null,
    basic: normalizeBasic(merged.basic, base.basic),
    education: normalizeEducation(merged.education),
    experience: normalizeExperience(merged.experience),
    projects: normalizeProjects(merged.projects),
    certificates: normalizeCertificates(merged.certificates),
    customData: normalizeCustomData(merged.customData),
    skillContent: asString(merged.skillContent),
    selfEvaluationContent: asString(merged.selfEvaluationContent),
    activeSection: asString(merged.activeSection) || "basic",
    draggingProjectId: null,
    menuSections: normalizeMenuSections(merged.menuSections, locale),
    globalSettings: normalizeGlobalSettings(merged.globalSettings, base.globalSettings),
  };

  const template = DEFAULT_TEMPLATES.find((item) => item.id === resume.templateId);
  resume.templateId = template?.id ?? DEFAULT_TEMPLATES[0]?.id ?? "classic";

  for (const section of resume.menuSections) {
    if (STANDARD_SECTION_IDS.includes(section.id as (typeof STANDARD_SECTION_IDS)[number])) {
      continue;
    }
    if (!resume.customData[section.id]) {
      resume.customData[section.id] = [];
    }
  }

  return resume;
};

/** Re-normalises a resume that was mutated in memory, keeping its identity. */
export const renormalizeResume = (resume: ResumeData): ResumeData => normalizeResume(resume, {
  templateId: resume.templateId,
});

export const normalizeRichText = (value: unknown): string => asString(value);
export const toStringArray = asStringArray;
