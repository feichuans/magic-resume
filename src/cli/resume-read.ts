import TurndownService from "turndown";
import { DEFAULT_TEMPLATES } from "@/components/templates/registry";
import { getFontOptions, normalizeFontFamily } from "@/utils/fonts";
import type { CustomItem, ResumeData } from "@/types/resume";
import type { Locale } from "./resume-data";

const HTML_TAG_REGEX = /<\/?[a-z][\s\S]*>/i;

const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });

/** Rich text -> Markdown lines, so the agent reads bullets instead of `<ul><li>`. */
export const richTextToLines = (value?: string): string[] => {
  const raw = (value ?? "").trim();
  if (!raw) return [];
  if (!HTML_TAG_REGEX.test(raw)) {
    return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  const markdown = turndown.turndown(raw).trim();
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
};

const indent = (lines: string[], prefix = "    "): string[] =>
  lines.map((line) => `${prefix}${line}`);

export interface ResumeReadOptions {
  locale?: Locale;
  file?: string;
}

/**
 * A compact, index-bearing view of a resume for a language model: section order,
 * every item with its list index, and rich text flattened to Markdown. Noise
 * such as `fieldOrder`, `icons`, `photoConfig` and ids is left out.
 */
export const renderResumeText = (
  resume: ResumeData,
  options: ResumeReadOptions = {}
): string => {
  const lines: string[] = [];
  const template = DEFAULT_TEMPLATES.find((item) => item.id === resume.templateId);
  const settings = resume.globalSettings ?? {};

  lines.push(`resume: ${resume.title}`);
  if (options.file) lines.push(`file: ${options.file}`);
  lines.push(`template: ${resume.templateId} (${template?.name ?? "unknown"})`);
  lines.push(
    `settings: pagePadding=${settings.pagePadding} baseFontSize=${settings.baseFontSize} lineHeight=${settings.lineHeight} themeColor=${settings.themeColor} autoOnePage=${settings.autoOnePage ?? false}`
  );
  lines.push(`font: ${normalizeFontFamily(settings.fontFamily)}`);
  lines.push("");

  const ordered = [...resume.menuSections].sort((a, b) => a.order - b.order);
  lines.push("sections (render order, [off] = hidden):");
  ordered.forEach((section, index) => {
    const flag = section.enabled ? "on " : "off";
    const count = countItems(resume, section.id);
    lines.push(
      `  ${String(index).padStart(2)} [${flag}] ${section.id.padEnd(15)} ${String(count).padStart(2)} items  ${section.title}`
    );
  });
  const orphans = Object.keys(resume.customData).filter(
    (id) => !resume.menuSections.some((section) => section.id === id)
  );
  for (const id of orphans) {
    lines.push(
      `     [off] ${id.padEnd(15)} ${String(resume.customData[id].length).padStart(2)} items  (not in menu)`
    );
  }
  lines.push("");

  for (const section of ordered) {
    const body = renderSection(resume, section.id, section.title);
    if (!body) continue;
    lines.push(...body);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
};

export const countItems = (resume: ResumeData, sectionId: string): number => {
  switch (sectionId) {
    case "basic":
      return 1;
    case "skills":
      return resume.skillContent ? 1 : 0;
    case "experience":
      return resume.experience.length;
    case "education":
      return resume.education.length;
    case "projects":
      return resume.projects.length;
    case "certificates":
      return resume.certificates.length;
    case "selfEvaluation":
      return resume.selfEvaluationContent ? 1 : 0;
    default:
      return resume.customData[sectionId]?.length ?? 0;
  }
};

const itemHeader = (index: number, visible: boolean | undefined, parts: string[]): string => {
  const flag = visible === false ? "[off] " : "";
  const body = parts.filter((part) => part && part.trim() !== "").join(" | ");
  return `[${index}] ${flag}${body}`;
};

const renderCustomItems = (items: CustomItem[]): string[] =>
  items.flatMap((item, index) => {
    const header = itemHeader(index, item.visible, [item.title, item.subtitle, item.dateRange]);
    const body = richTextToLines(item.description);
    return [header, ...indent(body)];
  });

const renderSection = (resume: ResumeData, sectionId: string, title: string): string[] => {
  switch (sectionId) {
    case "basic": {
      const basic = resume.basic;
      const lines = [`== basic (${title}) ==`];
      if (basic.name) lines.push(`name: ${basic.name}`);
      if (basic.title) lines.push(`title: ${basic.title}`);

      // Contact fields follow the resume's own fieldOrder, so the agent sees the
      // same order the template renders.
      for (const field of basic.fieldOrder ?? []) {
        if (field.key === "name" || field.key === "title") continue;
        if (field.visible === false) continue;
        const value = (basic as unknown as Record<string, unknown>)[field.key as string];
        if (typeof value !== "string" || !value.trim()) continue;
        lines.push(`${field.key as string}: ${value}`);
      }

      (basic.customFields ?? []).forEach((field, index) => {
        if (field.visible === false) return;
        if (!field.value.trim()) return;
        lines.push(`custom[${index}]: ${field.label} = ${field.value}`);
      });

      if (basic.photo) lines.push(`photo: ${basic.photo}`);
      lines.push(`layout: ${basic.layout ?? "left"}`);
      return lines;
    }
    case "skills": {
      const body = richTextToLines(resume.skillContent);
      if (!body.length) return [];
      return [`== skills (${title}) ==`, ...body];
    }
    case "selfEvaluation": {
      const body = richTextToLines(resume.selfEvaluationContent);
      if (!body.length) return [];
      return [`== selfEvaluation (${title}) ==`, ...body];
    }
    case "experience": {
      if (!resume.experience.length) return [];
      const lines = [`== experience (${title}) ==`];
      resume.experience.forEach((item, index) => {
        lines.push(itemHeader(index, item.visible, [item.company, item.position, item.date]));
        lines.push(...indent(richTextToLines(item.details)));
      });
      return lines;
    }
    case "education": {
      if (!resume.education.length) return [];
      const lines = [`== education (${title}) ==`];
      resume.education.forEach((item, index) => {
        const range = [item.startDate, item.endDate].filter(Boolean).join(" - ");
        lines.push(
          itemHeader(index, item.visible, [item.school, item.major, item.degree, range, item.gpa ? `GPA ${item.gpa}` : ""])
        );
        lines.push(...indent(richTextToLines(item.description)));
      });
      return lines;
    }
    case "projects": {
      if (!resume.projects.length) return [];
      const lines = [`== projects (${title}) ==`];
      resume.projects.forEach((item, index) => {
        lines.push(
          itemHeader(index, item.visible, [item.name, item.role, item.date, item.link ?? ""])
        );
        lines.push(...indent(richTextToLines(item.description)));
      });
      return lines;
    }
    case "certificates": {
      if (!resume.certificates.length) return [];
      const lines = [`== certificates (${title}) ==`];
      resume.certificates.forEach((item, index) => {
        lines.push(`[${index}] ${item.url} (width ${item.width}%)`);
      });
      return lines;
    }
    default: {
      const items = resume.customData[sectionId];
      if (!items?.length) return [];
      return [`== ${sectionId} (${title}) ==`, ...renderCustomItems(items)];
    }
  }
};

// ------------------------------------------------------------------ schema --

export interface ResumeSchema {
  paths: string[];
  items: Record<string, { path: string; fields: string[]; required: string[] }>;
  ops: Record<string, { fields: Record<string, string>; example: Record<string, unknown> }>;
  enums: Record<string, string[]>;
  settings: Record<string, string>;
  richTextFields: string[];
  notes: string[];
}

/**
 * The contract an agent needs before editing: which paths exist, which fields
 * each item section accepts, and which values are enumerated.
 */
export const buildSchema = (): ResumeSchema => ({
  paths: [
    "title",
    "templateId",
    "basic.name",
    "basic.title",
    "basic.email",
    "basic.phone",
    "basic.location",
    "basic.birthDate",
    "basic.employementStatus",
    "basic.photo",
    "basic.photoConfig.visible",
    "basic.photoConfig.width",
    "basic.photoConfig.height",
    "basic.layout",
    "basic.customFields[].label",
    "basic.customFields[].value",
    "skillContent",
    "selfEvaluationContent",
    "experience[i].company",
    "experience[i].position",
    "experience[i].date",
    "experience[i].details",
    "experience[i].visible",
    "education[i].school",
    "education[i].major",
    "education[i].degree",
    "education[i].startDate",
    "education[i].endDate",
    "education[i].gpa",
    "education[i].description",
    "education[i].visible",
    "projects[i].name",
    "projects[i].role",
    "projects[i].date",
    "projects[i].description",
    "projects[i].link",
    "projects[i].linkLabel",
    "projects[i].visible",
    "certificates[i].url",
    "certificates[i].width",
    "menuSections[i].enabled",
    "menuSections[i].order",
    "menuSections[i].title",
    "globalSettings.themeColor",
    "globalSettings.fontFamily",
    "globalSettings.baseFontSize",
    "globalSettings.pagePadding",
    "globalSettings.paragraphSpacing",
    "globalSettings.lineHeight",
    "globalSettings.sectionSpacing",
    "globalSettings.headerSize",
    "globalSettings.subheaderSize",
    "globalSettings.useIconMode",
    "globalSettings.centerSubtitle",
    "globalSettings.flexibleHeaderLayout",
    "globalSettings.autoOnePage",
  ],
  items: {
    experience: {
      path: "experience[i]",
      fields: ["company", "position", "date", "details", "visible"],
      required: [],
    },
    education: {
      path: "education[i]",
      fields: ["school", "major", "degree", "startDate", "endDate", "gpa", "description", "visible"],
      required: [],
    },
    projects: {
      path: "projects[i]",
      fields: ["name", "role", "date", "description", "link", "linkLabel", "visible"],
      required: ["name"],
    },
    certificates: {
      path: "certificates[i]",
      fields: ["url", "width"],
      required: ["url"],
    },
    custom: {
      path: "customData.<sectionId>[i]",
      fields: ["title", "subtitle", "dateRange", "description", "visible"],
      required: [],
    },
  },
  enums: {
    templateId: DEFAULT_TEMPLATES.map((template) => template.id),
    fontFamily: getFontOptions((key) => key).map((option) => option.value),
    layout: ["left", "center", "right"],
    locale: ["zh", "en"],
    format: ["auto", "text", "markdown", "html", "json"],
  },
  ops: {
    set: {
      fields: {
        path: "dot/bracket path from `paths`",
        value: "string, number or boolean matching the target type",
        format: "optional: auto|text|markdown|html|json (rich-text fields only)",
      },
      example: { op: "set", path: "basic.email", value: "a@b.com" },
    },
    add: {
      fields: {
        section: "experience|education|projects|certificates|custom",
        sectionId: "required for custom, e.g. awards",
        fields: "object of item fields; `@file` is resolved for text fields",
      },
      example: {
        op: "add",
        section: "experience",
        fields: { company: "Acme", position: "Dev", date: "2020 - 2024", details: "- shipped x" },
      },
    },
    remove: {
      fields: { section: "item section", index: "0-based index shown by `read`", sectionId: "for custom" },
      example: { op: "remove", section: "projects", index: 2 },
    },
    move: {
      fields: { section: "item section", from: "0-based", to: "0-based", sectionId: "for custom" },
      example: { op: "move", section: "experience", from: 0, to: 1 },
    },
    clear: {
      fields: { section: "any section id, incl. skills/selfEvaluation/basic" },
      example: { op: "clear", section: "projects" },
    },
    template: {
      fields: { templateId: "from enums.templateId; also resets theme colour and spacing" },
      example: { op: "template", templateId: "swiss" },
    },
    section: {
      fields: {
        sectionId: "any section id",
        enabled: "boolean",
        order: "integer, controls render order",
        title: "override the section heading",
        icon: "emoji",
      },
      example: { op: "section", sectionId: "selfEvaluation", enabled: true, order: 3 },
    },
  },
  settings: {
    themeColor: "hex colour, e.g. #1B1B18",
    fontFamily: "one of enums.fontFamily",
    baseFontSize: "number (px), default 16",
    pagePadding: "number (px), default 32",
    paragraphSpacing: "number (px), default 12",
    lineHeight: "number, default 1.5",
    sectionSpacing: "number (px), default 10",
    headerSize: "number (px), default 18",
    subheaderSize: "number (px), default 16",
    useIconMode: "boolean",
    centerSubtitle: "boolean",
    flexibleHeaderLayout: "boolean",
    autoOnePage: "boolean — shrink the render so it fits one A4 page",
  },
  richTextFields: ["skillContent", "selfEvaluationContent", "experience[i].details", "education[i].description", "projects[i].description", "customData.*[i].description"],
  notes: [
    "List indices are 0-based and shown in `read` output as [i].",
    "Sections not present in menuSections can be registered with the `section` op; standard ids are basic, skills, experience, projects, education, selfEvaluation, certificates.",
    "Order of menuSections controls render order; use the `section` op with `order`.",
    "Batch edits go through `variant` (new file) or `ops` (in place) so the whole change set is atomic.",
  ],
});

// -------------------------------------------------------------------- diff --

export const flattenResume = (
  value: unknown,
  prefix = "",
  output: Map<string, unknown> = new Map()
): Map<string, unknown> => {
  if (Array.isArray(value)) {
    output.set(prefix || "$", `[${value.length} items]`);
    value.forEach((entry, index) => flattenResume(entry, `${prefix}[${index}]`, output));
    return output;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      flattenResume(entry, prefix ? `${prefix}.${key}` : key, output);
    }
    return output;
  }
  output.set(prefix || "$", value);
  return output;
};

export interface ResumeDiffEntry {
  path: string;
  from: unknown;
  to: unknown;
}

/** Field-level diff between two resumes, ignoring bookkeeping timestamps. */
export const diffResumes = (before: ResumeData, after: ResumeData): ResumeDiffEntry[] => {
  const skip = /^(id|createdAt|updatedAt|activeSection|draggingProjectId)$/;
  const left = flattenResume(before);
  const right = flattenResume(after);
  const paths = Array.from(new Set([...Array.from(left.keys()), ...Array.from(right.keys())]));
  const entries: ResumeDiffEntry[] = [];

  for (const path of Array.from(paths).sort()) {
    if (skip.test(path)) continue;
    const a = left.get(path);
    const b = right.get(path);
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    entries.push({ path, from: a, to: b });
  }

  return entries;
};

export const formatDiffValue = (value: unknown): string => {
  if (value === undefined) return "(absent)";
  if (typeof value === "string") {
    const flat = value.replace(/\s+/g, " ").trim();
    return flat.length > 90 ? `${flat.slice(0, 87)}...` : flat;
  }
  return JSON.stringify(value);
};
