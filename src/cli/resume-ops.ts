import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ResumeData } from "@/types/resume";
import {
  EditError,
  addItem,
  applySection,
  applySet,
  applyTemplate,
  moveItem,
  normalizeSectionName,
  removeItem,
} from "./resume-edit";
import { renormalizeResume, type Locale } from "./resume-data";

export class OpsError extends Error {}

export interface ResumeOp {
  op: string;
  [key: string]: unknown;
}

export interface OpsDocument {
  ops: ResumeOp[];
}

export interface ApplyOpsOptions {
  baseDir: string;
  locale?: Locale;
  /** Applied after the operations, e.g. `{ templateId: "swiss" }`. */
  defaults?: { templateId?: string };
}

export interface ApplyOpsResult {
  applied: string[];
  warnings: string[];
}

const asString = (value: unknown, field: string): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  throw new OpsError(`"${field}" must be a string`);
};

const optionalString = (value: unknown): string | undefined =>
  value === undefined || value === null ? undefined : asString(value, "value");

const asIndex = (value: unknown, field: string): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) throw new OpsError(`"${field}" must be an integer index`);
  return parsed;
};

const asFields = (value: unknown, op: string): Record<string, string> => {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpsError(`"fields" of op "${op}" must be an object`);
  }
  const fields: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined || entry === null) continue;
    fields[key] = typeof entry === "string" ? entry : JSON.stringify(entry);
  }
  return fields;
};

/** `add` writes item fields directly, so `@file` is resolved here as well. */
const resolveFieldFiles = async (
  fields: Record<string, string>,
  baseDir: string
): Promise<Record<string, string>> => {
  const literalFields = new Set(["url", "photo"]);
  const resolved: Record<string, string> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (literalFields.has(key) || !value.startsWith("@")) {
      resolved[key] = value;
      continue;
    }
    const target = value.slice(1);
    const absolute = isAbsolute(target) ? target : resolve(baseDir, target);
    resolved[key] = await readFile(absolute, "utf8");
  }

  return resolved;
};

const runOp = async (
  resume: ResumeData,
  op: ResumeOp,
  options: ApplyOpsOptions
): Promise<string> => {
  const baseDir = options.baseDir;
  const locale = options.locale ?? "zh";

  switch (op.op) {
    case "set": {
      const path = asString(op.path, "path");
      const rawValue = op.value;
      if (rawValue === undefined) throw new OpsError(`op "set" requires "value" (path ${path})`);
      const format = optionalString(op.format) as "auto" | "text" | "markdown" | "html" | "json" | undefined;
      const value =
        typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue);
      const result = await applySet(resume, path, value, { format, baseDir });
      return `set ${result.path}`;
    }

    case "add": {
      const rawSection = asString(op.section ?? op.sectionId, "section");
      const section = normalizeSectionName(rawSection);
      if (!section) {
        throw new OpsError(
          `op "add": "${rawSection}" is not an item section (experience, education, projects, certificates, custom)`
        );
      }
      const fields = await resolveFieldFiles(asFields(op.fields ?? op.values, "add"), baseDir);
      addItem(resume, section, fields, {
        sectionId: op.sectionId !== undefined ? asString(op.sectionId, "sectionId") : undefined,
        baseDir,
        locale,
      });
      return `add ${section}${op.sectionId ? ` (${String(op.sectionId)})` : ""}`;
    }

    case "remove": {
      const section = normalizeSectionName(asString(op.section, "section"));
      if (!section) throw new OpsError(`op "remove": unknown section "${String(op.section)}"`);
      const index = asIndex(op.index, "index");
      removeItem(resume, section, index, optionalString(op.sectionId));
      return `remove ${section}[${index}]`;
    }

    case "move": {
      const section = normalizeSectionName(asString(op.section, "section"));
      if (!section) throw new OpsError(`op "move": unknown section "${String(op.section)}"`);
      const from = asIndex(op.from, "from");
      const to = asIndex(op.to, "to");
      moveItem(resume, section, from, to, optionalString(op.sectionId));
      return `move ${section}[${from}] -> ${to}`;
    }

    case "clear": {
      const section = asString(op.section, "section");
      const before = countSection(resume, section);
      clearSection(resume, section, optionalString(op.sectionId));
      return `clear ${section} (${before} items)`;
    }

    case "template": {
      const templateId = asString(op.templateId ?? op.id ?? op.template, "templateId");
      applyTemplate(resume, templateId);
      return `template ${templateId}`;
    }

    case "section": {
      const sectionId = asString(op.sectionId ?? op.section ?? op.id, "sectionId");
      const result = applySection(resume, sectionId, {
        enable:
          op.enabled !== undefined
            ? Boolean(op.enabled)
            : op.enable !== undefined
              ? Boolean(op.enable)
              : undefined,
        order: op.order !== undefined ? asIndex(op.order, "order") : undefined,
        title: optionalString(op.title),
        icon: optionalString(op.icon),
        locale,
      });
      return `${result.created ? "register" : "update"} section ${sectionId}`;
    }

    case "copy": {
      // Variant generation is handled by the command layer, which writes to a
      // different file; the op itself changes nothing.
      return "copy";
    }

    default:
      throw new OpsError(`unknown op "${op.op}"`);
  }
};

export const clearSection = (
  resume: ResumeData,
  sectionId: string,
  customSectionId?: string
): void => {
  switch (sectionId) {
    case "experience":
      resume.experience = [];
      return;
    case "education":
      resume.education = [];
      return;
    case "projects":
      resume.projects = [];
      return;
    case "certificates":
      resume.certificates = [];
      return;
    case "skills":
      resume.skillContent = "";
      return;
    case "selfEvaluation":
      resume.selfEvaluationContent = "";
      return;
    case "basic": {
      resume.basic = {
        ...resume.basic,
        name: "",
        title: "",
        email: "",
        phone: "",
        location: "",
        birthDate: "",
        employementStatus: "",
        customFields: [],
      };
      return;
    }
    default: {
      const target = customSectionId ?? sectionId;
      if (!(target in resume.customData)) {
        throw new OpsError(`unknown section "${sectionId}"`);
      }
      resume.customData[target] = [];
    }
  }
};

export const countSection = (resume: ResumeData, sectionId: string): number => {
  switch (sectionId) {
    case "experience":
      return resume.experience.length;
    case "education":
      return resume.education.length;
    case "projects":
      return resume.projects.length;
    case "certificates":
      return resume.certificates.length;
    default:
      return resume.customData[sectionId]?.length ?? 0;
  }
};

/**
 * Applies a list of operations atomically: every operation runs against a copy
 * and the copy is only written back when all of them succeed.
 */
export const applyOps = async (
  resume: ResumeData,
  ops: ResumeOp[],
  options: ApplyOpsOptions
): Promise<{ resume: ResumeData; applied: string[] }> => {
  const draft = JSON.parse(JSON.stringify(resume)) as ResumeData;
  const applied: string[] = [];

  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index];
    if (typeof op !== "object" || op === null || typeof op.op !== "string") {
      throw new OpsError(`op #${index} is missing an "op" name`);
    }
    try {
      applied.push(await runOp(draft, op, options));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof OpsError || error instanceof EditError) {
        throw new OpsError(`op #${index} (${op.op}): ${detail}`);
      }
      throw error;
    }
  }

  const normalized = renormalizeResume(draft);
  if (options.defaults?.templateId) {
    applyTemplate(normalized, options.defaults.templateId);
  }

  return { resume: normalized, applied };
};
