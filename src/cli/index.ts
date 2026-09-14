import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TEMPLATES } from "@/components/templates/registry";
import { normalizeFontFamily } from "@/utils/fonts";
import { generateResumeMarkdown } from "@/utils/markdown";
import {
  EditError,
  addItem,
  applySection,
  applySet,
  applyTemplate,
  getByPath,
  moveItem,
  normalizeSectionName,
  removeItem,
  resolveValue,
  type SetResult,
} from "./resume-edit";
import {
  detectLocale,
  getBlankResume,
  getSampleResume,
  normalizeResume,
  type Locale,
} from "./resume-data";
import {
  OpsError,
  applyOps,
  clearSection,
  type OpsDocument,
  type ResumeOp,
} from "./resume-ops";
import {
  buildSchema,
  countItems,
  diffResumes,
  formatDiffValue,
  renderResumeText,
} from "./resume-read";
import { ResumeRenderer, readResumeFile } from "./renderer";

const VERSION = "0.1.0";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Vite and PostCSS resolve plugins relative to `process.cwd()`, so rendering a
 * resume from another directory would miss Tailwind. The CLI works from the
 * package root while user paths keep resolving against the invoking directory.
 */
const INVOKE_DIR = process.cwd();

const pinWorkingDirectory = () => {
  if (process.cwd() !== PACKAGE_ROOT) {
    process.chdir(PACKAGE_ROOT);
  }
};

/** Resolves a user-supplied path against the directory the CLI was invoked from. */
const userPath = (filePath: string): string =>
  isAbsolute(filePath) ? filePath : resolve(INVOKE_DIR, filePath);

const SHORT_FLAGS: Record<string, string> = {
  o: "output",
  f: "format",
  t: "template",
  l: "locale",
  s: "set",
  h: "help",
  v: "version",
};

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
  repeated: Record<string, string[]>;
  passthrough: string[];
}

const parseArgs = (argv: string[]): ParsedArgs => {
  const flags: Record<string, string | boolean> = {};
  const repeated: Record<string, string[]> = {};
  const positionals: string[] = [];
  const passthrough: string[] = [];
  const command = argv[0] ?? "help";

  const args = argv.slice(1);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") {
      passthrough.push(...args.slice(index + 1));
      break;
    }

    const isLong = token.startsWith("--");
    const isShort = !isLong && /^-[a-z]$/i.test(token);

    if (isLong || isShort) {
      const [rawKey, inlineValue] = (isLong ? token.slice(2) : token.slice(1)).split("=");
      const key = isLong
        ? rawKey.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
        : SHORT_FLAGS[rawKey] ?? rawKey;
      const next = args[index + 1];
      const consumeNext =
        inlineValue === undefined && next !== undefined && !next.startsWith("--") && !/^-[a-z]$/i.test(next);
      const value =
        inlineValue !== undefined
          ? inlineValue
          : consumeNext && (key !== "set" || next.includes("="))
            ? (index += 1, next)
            : true;

      if (key === "set") {
        if (typeof value !== "string") {
          throw new CliError("--set expects <path>=<value> (write it as one argument, e.g. --set basic.email=a@b.com)");
        }
        repeated.set = [...(repeated.set ?? []), value];
        continue;
      }

      if (flags[key] === undefined) {
        flags[key] = value;
      } else {
        repeated[key] = [...(repeated[key] ?? [String(flags[key])]), String(value)];
      }
      continue;
    }

    positionals.push(token);
  }

  return { command, positionals, flags, repeated, passthrough };
};

const flagString = (
  args: ParsedArgs,
  name: string,
  fallback?: string
): string | undefined => {
  const value = args.flags[name];
  if (value === undefined) return fallback;
  return typeof value === "string" ? value : fallback;
};

const flagBool = (args: ParsedArgs, name: string, fallback = false): boolean => {
  const value = args.flags[name];
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  return value !== "false" && value !== "0";
};

const flagNumber = (args: ParsedArgs, name: string): number | undefined => {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const c = {
  bold: (value: string) => `\u001b[1m${value}\u001b[22m`,
  dim: (value: string) => `\u001b[2m${value}\u001b[22m`,
  red: (value: string) => `\u001b[31m${value}\u001b[39m`,
  green: (value: string) => `\u001b[32m${value}\u001b[39m`,
  yellow: (value: string) => `\u001b[33m${value}\u001b[39m`,
};

const log = (message = "") => process.stdout.write(`${message}\n`);
const warn = (message: string) => process.stderr.write(`${c.yellow("warning")} ${message}\n`);
const readFileText = (filePath: string) => readFile(filePath, "utf8");

/**
 * `--json` switches a command's output to a single machine-readable object, so
 * an agent never has to parse coloured tables.
 */
const emit = (json: boolean, payload: unknown, human: () => void) => {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  human();
};

class CliError extends Error {}

const requireFile = (filePath: string | undefined, hint: string): string => {
  if (!filePath) throw new CliError(hint);
  const absolute = userPath(filePath);
  if (!existsSync(absolute)) throw new CliError(`file not found: ${absolute}`);
  return absolute;
};

const loadResume = async (
  filePath: string,
  options: { locale?: Locale; templateId?: string | null } = {}
) => {
  const raw = await readResumeFile(filePath);
  return normalizeResume(raw, options);
};

const saveResume = async (filePath: string, resume: { updatedAt?: string }) => {
  resume.updatedAt = new Date().toISOString();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(resume, null, 2)}\n`, "utf8");
};

const resolveLocale = (
  args: ParsedArgs,
  resume?: { menuSections?: { title: string }[]; basic?: { name?: string; title?: string } }
): Locale => {
  const explicit = flagString(args, "locale");
  if (explicit === "en" || explicit === "zh") return explicit;
  if (resume) return detectLocale(resume);
  return "zh";
};

const createRenderer = () =>
  new ResumeRenderer({
    projectRoot: PACKAGE_ROOT,
    publicDir: join(PACKAGE_ROOT, "public"),
    cacheDir: join(PACKAGE_ROOT, "node_modules", ".cache", "magic-resume-cli"),
  });

const withRenderer = async <T>(fn: (renderer: ResumeRenderer) => Promise<T>): Promise<T> => {
  const renderer = createRenderer();
  try {
    return await fn(renderer);
  } finally {
    await renderer.dispose();
  }
};

// ---------------------------------------------------------------- commands --

const commands: Record<string, { summary: string; run: (args: ParsedArgs) => Promise<number> }> = {};

const defineCommand = (
  name: string,
  summary: string,
  run: (args: ParsedArgs) => Promise<number>
) => {
  commands[name] = { summary, run };
};

defineCommand("init", "Create a resume JSON file (sample content or empty)", async (args) => {
  const output = userPath(args.positionals[0] ?? "resume.json");
  if (existsSync(output) && !flagBool(args, "force")) {
    throw new CliError(`${output} already exists (use --force to overwrite)`);
  }

  const locale = (flagString(args, "locale", "zh") as Locale) ?? "zh";
  const resume = flagBool(args, "blank")
    ? getBlankResume(locale)
    : getSampleResume(locale);
  const templateId = flagString(args, "template");
  if (templateId) applyTemplate(resume, templateId);

  await saveResume(output, resume);
  emit(
    flagBool(args, "json"),
    {
      output,
      templateId: resume.templateId,
      blank: flagBool(args, "blank"),
      locale,
      sections: resume.menuSections.map((section) => section.id),
    },
    () => {
      log(`${c.green("created")} ${output}`);
      log(`  template: ${resume.templateId}`);
      log(`  sections: ${resume.menuSections.map((section) => section.id).join(", ")}`);
    }
  );
  return 0;
});

defineCommand("templates", "List available templates", async () => {
  const rows: [string, string, string][] = DEFAULT_TEMPLATES.map((template) => [
    template.id,
    template.name,
    template.basic.layout ?? "left",
  ]);
  const widths = [10, 18, 8];
  const pad = (value: string, index: number) => value.padEnd(widths[index]);
  log(c.bold(`${pad("ID", 0)} ${pad("NAME", 1)} LAYOUT`));
  for (const [id, name, layout] of rows) {
    log(`${pad(id, 0)} ${pad(name, 1)} ${layout}`);
  }
  return 0;
});

defineCommand("fonts", "List font families", async () => {
  const { getFontOptions } = await import("@/utils/fonts");
  const options = getFontOptions((key) => key);
  for (const option of options) {
    log(`${option.value.padEnd(46)} ${c.dim(option.label)}`);
  }
  return 0;
});

defineCommand("show", "Print a resume field, or the whole resume as JSON", async (args) => {
  const file = requireFile(args.positionals[0], "usage: magic-resume show <resume.json> [path]");
  const resume = await loadResume(file);
  const path = args.positionals[1];

  if (!path) {
    emit(flagBool(args, "json"), resume, () => log(JSON.stringify(resume, null, 2)));
    return 0;
  }

  const value = getByPath(resume, path);
  if (value === undefined) throw new CliError(`no value at "${path}"`);
  emit(flagBool(args, "json"), { path, value }, () =>
    log(typeof value === "string" ? value : JSON.stringify(value, null, 2))
  );
  return 0;
});

/**
 * `read` is the agent's entry point: a compact text view with list indices,
 * rich text flattened to Markdown, and none of the JSON bookkeeping noise.
 */
defineCommand("read", "Print a compact, index-bearing view of a resume (for agents)", async (args) => {
  const file = requireFile(args.positionals[0], "usage: magic-resume read <resume.json>");
  const resume = await loadResume(file);
  emit(flagBool(args, "json"), resume, () => log(renderResumeText(resume, { file })));
  return 0;
});

defineCommand("schema", "Print the editable surface: paths, item fields, enums", async (args) => {
  const schema = buildSchema();
  emit(flagBool(args, "json"), schema, () => log(JSON.stringify(schema, null, 2)));
  return 0;
});

defineCommand("diff", "Compare two resume files field by field", async (args) => {
  const leftFile = requireFile(args.positionals[0], "usage: magic-resume diff <a.json> <b.json>");
  const rightFile = requireFile(args.positionals[1], "usage: magic-resume diff <a.json> <b.json>");
  const left = await loadResume(leftFile);
  const right = await loadResume(rightFile);
  const entries = diffResumes(left, right);

  emit(flagBool(args, "json"), { changed: entries.length, entries }, () => {
    if (entries.length === 0) {
      log("no differences");
      return;
    }
    for (const entry of entries) {
      log(c.yellow(entry.path));
      log(`  - ${formatDiffValue(entry.from)}`);
      log(`  + ${formatDiffValue(entry.to)}`);
    }
    log(`${entries.length} field${entries.length === 1 ? "" : "s"} changed`);
  });
  return 0;
});

/**
 * `ops` applies a whole batch of edits in one process start, atomically: the
 * agent writes one JSON file describing the new resume instead of running a
 * dozen `set` commands.
 */
/**
 * Reads an ops document from a file, or from stdin when the argument is `-`,
 * which is how a calling agent usually pipes a generated batch.
 */
const readOpsDocument = async (source: string): Promise<ResumeOp[]> => {
  const raw =
    source === "-"
      ? await new Promise<string>((done, fail) => {
          let buffer = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk) => (buffer += chunk));
          process.stdin.on("end", () => done(buffer));
          process.stdin.on("error", fail);
        })
      : await readFileText(requireFile(source, "missing --ops <ops.json>"));

  let document: OpsDocument | ResumeOp[];
  try {
    document = JSON.parse(raw) as OpsDocument | ResumeOp[];
  } catch (error) {
    throw new CliError(`--ops is not valid JSON: ${(error as Error).message}`);
  }

  const ops = Array.isArray(document) ? document : document.ops;
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new CliError(`--ops contains no ops (expected {"ops": [...]} or a bare array)`);
  }

  return ops;
};

defineCommand("ops", "Apply a batch of edits from a JSON file, atomically", async (args) => {
  const file = requireFile(args.positionals[0], "usage: magic-resume ops <resume.json> --ops <ops.json|->");
  const opsSource = flagString(args, "ops");
  if (!opsSource) throw new CliError("missing --ops <ops.json|-> (use - to read stdin)");
  const ops = await readOpsDocument(opsSource);

  const resume = await loadResume(file);
  const locale = resolveLocale(args, resume);
  const { resume: next, applied } = await applyOps(resume, ops, {
    baseDir: dirname(file),
    locale,
  });

  const dryRun = flagBool(args, "dryRun");
  for (const entry of applied) log(`${dryRun ? c.dim("would ") : c.green("applied ")}${entry}`);

  if (dryRun) {
    log(c.dim("(dry run — nothing written)"));
    return 0;
  }

  await saveResume(file, next);
  log(`${c.green("wrote")} ${file}`);
  return 0;
});

/**
 * `variant` is the variant-generation workhorse: read a source resume, apply a
 * batch of ops, write the result to a new file, and optionally render it.
 */
defineCommand("variant", "Generate a tailored copy of a resume from a batch of ops", async (args) => {
  const source = requireFile(args.positionals[0], "usage: magic-resume variant <base.json> <out.json> --ops <ops.json|->");
  const target = args.positionals[1];
  if (!target) throw new CliError("missing <out.json>");
  const targetPath = userPath(target);

  if (existsSync(targetPath) && !flagBool(args, "force")) {
    throw new CliError(`${targetPath} already exists (use --force to overwrite)`);
  }

  const opsFile = flagString(args, "ops");
  const resume = await loadResume(source);
  const locale = resolveLocale(args, resume);

  const ops: ResumeOp[] = opsFile ? await readOpsDocument(opsFile) : [];

  const templateId = flagString(args, "template");
  const { resume: next, applied } = await applyOps(resume, ops, {
    baseDir: dirname(source),
    locale,
    defaults: { templateId },
  });

  next.id = (await import("@/utils/uuid")).generateUUID();
  next.createdAt = new Date().toISOString();
  const title = flagString(args, "title");
  if (title) next.title = title;

  await saveResume(targetPath, next);

  const renderFormat = flagString(args, "format");
  const json = flagBool(args, "json");

  // Without --format there is nothing to render, so the JSON report can be
  // emitted right away.
  if (!renderFormat) {
    emit(json, { source, output: targetPath, title: next.title, templateId: next.templateId, applied }, () => {
      log(`${c.green("created")} ${targetPath} from ${basename(source)}`);
      for (const entry of applied) log(`  ${entry}`);
      log(`  template ${next.templateId}, title ${next.title}`);
    });
    return 0;
  }

  if (renderFormat !== "pdf" && renderFormat !== "png") {
    throw new CliError(`unsupported --format "${renderFormat}" (use pdf or png)`);
  }

  const output = userPath(
    flagString(args, "output") ?? targetPath.replace(/\.json$/i, `.${renderFormat}`)
  );

  return withRenderer(async (renderer) => {
    const result = await renderer.render(next, {
      format: renderFormat,
      locale,
      onePage: flagBool(args, "noOnePage")
        ? false
        : flagBool(args, "onePage") || Boolean(next.globalSettings.autoOnePage),
      minOnePageScale: flagNumber(args, "minScale"),
      imageScale: flagNumber(args, "imageScale"),
      browserChannel: flagString(args, "browserChannel"),
      saveHtml: flagBool(args, "html"),
      outputPath: output,
      onProgress: (message) => process.stderr.write(`${c.dim(message)}\n`),
    });

    emit(
      json,
      {
        source,
        output: targetPath,
        title: next.title,
        templateId: next.templateId,
        applied,
        render: {
          output: result.outputPath,
          format: renderFormat,
          bytes: result.bytes,
          contentHeightPx: result.contentHeightPx,
          pageCount: result.pageCount,
          fitsOnePage: result.fitsOnePage,
          onePage: result.onePage,
          warnings: result.warnings,
        },
      },
      () => {
        log(`${c.green("created")} ${targetPath} from ${basename(source)}`);
        for (const entry of applied) log(`  ${entry}`);
        log(`  template ${next.templateId}, title ${next.title}`);
        log(
          `${c.green("rendered")} ${result.outputPath} (${formatBytes(result.bytes)}, ${result.pageCount} page${result.pageCount > 1 ? "s" : ""})`
        );
      }
    );

    for (const message of result.warnings) warn(message);
    return 0;
  });
});

defineCommand("set", "Set a field (dot/bracket paths, markdown or plain text for rich text)", async (args) => {
  const file = requireFile(args.positionals[0], "usage: magic-resume set <resume.json> <path> <value>");
  const path = args.positionals[1];
  if (!path) throw new CliError("missing <path>");

  const operations = args.repeated.set ?? [];
  const inline = args.positionals.slice(2).join(" ");
  if (inline) operations.push(`${path}=${inline}`);
  if (operations.length === 0) throw new CliError("missing <value>");

  const resume = await loadResume(file);
  const format = flagString(args, "format", "auto") as "auto" | "text" | "markdown" | "html" | "json";
  const baseDir = dirname(file);
  const results: SetResult[] = [];

  for (const operation of operations) {
    const separator = operation.indexOf("=");
    if (separator === -1) {
      throw new CliError(
        `--set expects <path>=<value> as one argument, received "${operation}" (for a single field use: set <file> <path> <value>)`
      );
    }
    const targetPath = operation.slice(0, separator);
    const value = operation.slice(separator + 1);
    results.push(await applySet(resume, targetPath, value, { format, baseDir }));
  }

  await saveResume(file, resume);
  emit(flagBool(args, "json"), { file, changed: results.map((r) => r.path) }, () => {
    for (const result of results) {
      const preview = typeof result.value === "string" && result.value.length > 60
        ? `${result.value.slice(0, 57)}...`
        : String(result.value);
      log(`${c.green("set")} ${result.path} = ${preview}`);
    }
  });
  return 0;
});

defineCommand("add", "Append an item to a section", async (args) => {
  const file = requireFile(args.positionals[0], 'usage: magic-resume add <resume.json> <section> --company "..."');
  const sectionName = args.positionals[1];
  if (!sectionName) throw new CliError("missing <section>");

  const resume = await loadResume(file);
  const section = normalizeSectionName(sectionName);
  if (!section) {
    throw new CliError(
      `"${sectionName}" is not an item section (use experience, education, projects, certificates or custom)`
    );
  }

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.flags)) {
    if (typeof value !== "string") continue;
    fields[key] = value;
  }

  // `@file` works for item fields too, not just for `set`. Only the path-like
  // fields (url/photo) keep their literal value.
  const literalFields = new Set(["url", "photo"]);
  for (const [key, value] of Object.entries(fields)) {
    if (literalFields.has(key)) continue;
    fields[key] = await resolveValue(value, { baseDir: dirname(file) });
  }

  const item = addItem(resume, section, fields, {
    sectionId: args.positionals[2],
    baseDir: dirname(file),
    locale: resolveLocale(args, resume),
  });

  await saveResume(file, resume);
  const addedId = (item as { id: string }).id;
  const index = countItems(resume, section === "custom" ? args.positionals[2] ?? "" : section) - 1;
  emit(flagBool(args, "json"), { file, section, index, id: addedId }, () => {
    log(`${c.green("added")} ${section}[${index}] (${addedId})`);
  });
  return 0;
});

defineCommand("remove", "Delete an item from a section by index", async (args) => {
  const file = requireFile(args.positionals[0], "usage: magic-resume remove <resume.json> <section> <index>");
  const sectionName = args.positionals[1];
  const index = Number(args.positionals[2]);
  if (!sectionName || !Number.isInteger(index)) {
    throw new CliError("usage: magic-resume remove <resume.json> <section> <index>");
  }

  const section = normalizeSectionName(sectionName);
  if (!section) throw new CliError(`unknown section "${sectionName}"`);

  const resume = await loadResume(file);
  const removed = removeItem(resume, section, index, args.positionals[3]);
  await saveResume(file, resume);
  emit(
    flagBool(args, "json"),
    { file, section, index, removed },
    () => log(`${c.green("removed")} ${section}[${index}]: ${JSON.stringify(removed).slice(0, 100)}`)
  );
  return 0;
});

defineCommand("move", "Reorder an item inside a section", async (args) => {
  const file = requireFile(args.positionals[0], "usage: magic-resume move <resume.json> <section> <from> <to>");
  const sectionName = args.positionals[1];
  const from = Number(args.positionals[2]);
  const to = Number(args.positionals[3]);
  if (!sectionName || !Number.isInteger(from) || !Number.isInteger(to)) {
    throw new CliError("usage: magic-resume move <resume.json> <section> <from> <to>");
  }

  const section = normalizeSectionName(sectionName);
  if (!section) throw new CliError(`unknown section "${sectionName}"`);

  const resume = await loadResume(file);
  moveItem(resume, section, from, to, args.positionals[4]);
  await saveResume(file, resume);
  emit(flagBool(args, "json"), { file, section, from, to }, () =>
    log(`${c.green("moved")} ${section}[${from}] -> ${to}`)
  );
  return 0;
});

defineCommand("template", "Switch template (also updates theme colour and spacing)", async (args) => {
  const file = requireFile(args.positionals[0], "usage: magic-resume template <resume.json> <templateId>");
  const templateId = args.positionals[1];
  if (!templateId) throw new CliError("missing <templateId>");

  const resume = await loadResume(file);
  applyTemplate(resume, templateId);
  await saveResume(file, resume);
  emit(
    flagBool(args, "json"),
    { file, templateId: resume.templateId, globalSettings: resume.globalSettings, layout: resume.basic.layout },
    () => log(`${c.green("template")} ${templateId}`)
  );
  return 0;
});

defineCommand("clear", "Empty a section (keep the section, drop its items)", async (args) => {
  const file = requireFile(args.positionals[0], "usage: magic-resume clear <resume.json> <section>");
  const sectionId = args.positionals[1];
  if (!sectionId) throw new CliError("missing <section>");

  const resume = await loadResume(file);
  const before = countItems(resume, sectionId);
  clearSection(resume, sectionId, args.positionals[2]);
  await saveResume(file, resume);
  emit(flagBool(args, "json"), { file, section: sectionId, removed: before }, () =>
    log(`${c.green("cleared")} ${sectionId} (${before} items removed)`)
  );
  return 0;
});

defineCommand("section", "Enable, disable, rename or reorder a section", async (args) => {
  const file = requireFile(args.positionals[0], "usage: magic-resume section <resume.json> <sectionId> [--enable|--disable]");
  const sectionId = args.positionals[1];
  if (!sectionId) throw new CliError("missing <sectionId>");

  const resume = await loadResume(file);
  const enableFlag = args.flags.enable;
  const disableFlag = args.flags.disable;

  const result = applySection(resume, sectionId, {
    enable:
      enableFlag !== undefined ? true : disableFlag !== undefined ? false : undefined,
    order: flagNumber(args, "order"),
    title: flagString(args, "title"),
    icon: flagString(args, "icon"),
    locale: resolveLocale(args, resume),
  });

  await saveResume(file, resume);
  emit(
    flagBool(args, "json"),
    { file, created: result.created, section: result.section },
    () =>
      log(
        `${c.green(result.created ? "created" : "updated")} section ${result.section.id}: ${JSON.stringify(
          result.section
        )}`
      )
  );
  return 0;
});

defineCommand("ls", "Summarise the resume: sections, items and settings", async (args) => {
  const file = requireFile(args.positionals[0], "usage: magic-resume ls <resume.json>");
  const resume = await loadResume(file);
  const template = DEFAULT_TEMPLATES.find((item) => item.id === resume.templateId);
  const ordered = [...resume.menuSections].sort((a, b) => a.order - b.order);

  emit(
    flagBool(args, "json"),
    {
      file,
      title: resume.title,
      templateId: resume.templateId,
      templateName: template?.name ?? null,
      font: normalizeFontFamily(resume.globalSettings.fontFamily),
      settings: resume.globalSettings,
      basic: { name: resume.basic.name, title: resume.basic.title },
      sections: ordered.map((section, index) => ({
        index,
        id: section.id,
        title: section.title,
        enabled: section.enabled,
        order: section.order,
        items: countItems(resume, section.id),
      })),
    },
    () => {
      log(`${c.bold(resume.title)} ${c.dim(`(${basename(file)})`)}`);
      log(`  template  ${resume.templateId} — ${template?.name ?? "unknown"}`);
      log(`  font      ${normalizeFontFamily(resume.globalSettings.fontFamily)}`);
      log(`  settings  pagePadding=${resume.globalSettings.pagePadding} fontSize=${resume.globalSettings.baseFontSize} lineHeight=${resume.globalSettings.lineHeight} autoOnePage=${resume.globalSettings.autoOnePage ?? false}`);
      log(`  basics    ${resume.basic.name || "(empty)"} / ${resume.basic.title || "(empty)"}`);
      log("  sections");

      for (const section of ordered) {
        const count = countItems(resume, section.id);
        const state = section.enabled ? c.green("on ") : c.dim("off");
        log(`    ${state} ${section.id.padEnd(16)} ${String(count).padStart(2)} items  ${c.dim(section.title)}`);
      }

      const orphans = Object.keys(resume.customData).filter(
        (id) => !resume.menuSections.some((section) => section.id === id)
      );
      for (const id of orphans) {
        log(`    ${c.dim("off")} ${id.padEnd(16)} ${String(resume.customData[id].length).padStart(2)} items  ${c.dim("(not in menu)")}`);
      }
    }
  );

  return 0;
});

defineCommand("render", "Render a resume to PDF or PNG in a headless browser", async (args) => {
  const file = requireFile(args.positionals[0], "usage: magic-resume render <resume.json> [-o out.pdf]");
  const formatFlag = flagString(args, "format");
  const explicitOutput = flagString(args, "output") ?? flagString(args, "o");
  const inferredFormat = (explicitOutput?.toLowerCase().endsWith(".png") ? "png" : "pdf") as
    | "pdf"
    | "png";
  const format = (formatFlag as "pdf" | "png" | undefined) ?? inferredFormat;

  if (format !== "pdf" && format !== "png") {
    throw new CliError(`unsupported --format "${formatFlag}" (use pdf or png)`);
  }

  const resume = await loadResume(file);
  const locale = resolveLocale(args, resume);
  // An explicit -o is used verbatim; only the default derives from --format.
  const output = userPath(explicitOutput ?? defaultOutputName(file, format));

  return withRenderer(async (renderer) => {
    const started = Date.now();
    // `--one-page` forces the fit-to-one-page shrink, `--no-one-page` disables
    // it, and without either flag the resume's own autoOnePage setting decides.
    const onePage = flagBool(args, "noOnePage")
      ? false
      : flagBool(args, "onePage") || Boolean(resume.globalSettings.autoOnePage);

    const result = await renderer.render(resume, {
      format,
      locale,
      onePage,
      minOnePageScale: flagNumber(args, "minScale"),
      imageScale: flagNumber(args, "imageScale"),
      browserChannel: flagString(args, "browserChannel"),
      saveHtml: flagBool(args, "html"),
      outputPath: output,
      onProgress: (message) => process.stderr.write(`${c.dim(message)}\n`),
    });

    emit(
      flagBool(args, "json"),
      {
        output: result.outputPath,
        format,
        bytes: result.bytes,
        contentHeightPx: result.contentHeightPx,
        pageCount: result.pageCount,
        fitsOnePage: result.fitsOnePage,
        onePage: result.onePage,
        durationMs: Date.now() - started,
        htmlPath: result.htmlPath ?? null,
        warnings: result.warnings,
      },
      () => {
        log(`${c.green("rendered")} ${result.outputPath}`);
        log(`  size          ${formatBytes(result.bytes)}`);
        log(`  content       ${result.contentHeightPx}px (~${result.pageCount} A4 page${result.pageCount > 1 ? "s" : ""})`);
        log(`  one page      ${
          result.onePage.isScaled
            ? `${(result.onePage.scale * 100).toFixed(1)}% scale${result.onePage.cannotFit ? " (cannot fit)" : ""}`
            : "not needed"
        }`);
        log(`  duration      ${Date.now() - started}ms`);
        if (result.htmlPath) log(`  html          ${result.htmlPath}`);
      }
    );

    for (const message of result.warnings) warn(message);
    return 0;
  });
});

defineCommand("preview", "Serve the rendered resume on localhost", async (args) => {
  const file = requireFile(args.positionals[0], "usage: magic-resume preview <resume.json>");
  const resume = await loadResume(file);
  const locale = resolveLocale(args, resume);

  return withRenderer(async (renderer) => {
    const server = await renderer.serve(resume, locale);
    log(`${c.green("preview")} ${server.origin}`);
    log(c.dim("press Ctrl+C to stop"));

    await new Promise<void>((done) => {
      process.on("SIGINT", () => done());
      process.on("SIGTERM", () => done());
    });

    await server.close();
    return 0;
  });
});

defineCommand("export-md", "Export the resume as Markdown", async (args) => {
  const file = requireFile(args.positionals[0], "usage: magic-resume export-md <resume.json> [-o out.md]");
  const resume = await loadResume(file);
  const markdown = generateResumeMarkdown(resume);
  const output = userPath(
    flagString(args, "output") ?? flagString(args, "o") ?? defaultOutputName(file, "md")
  );

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${markdown}\n`, "utf8");
  log(`${c.green("exported")} ${output} (${formatBytes(Buffer.byteLength(markdown))})`);
  return 0;
});

defineCommand("validate", "Check that a resume file parses and normalises", async (args) => {
  const file = requireFile(args.positionals[0], "usage: magic-resume validate <resume.json>");
  const resume = await loadResume(file);
  const notes: string[] = [];

  if (!resume.basic.name) notes.push("basic.name is empty");
  if (!resume.menuSections.some((section) => section.enabled)) notes.push("no enabled sections");
  for (const section of resume.menuSections.filter((item) => item.enabled)) {
    if (countItems(resume, section.id) === 0) {
      notes.push(`section "${section.id}" is enabled but has no content`);
    }
  }

  emit(
    flagBool(args, "json"),
    {
      file,
      valid: true,
      sections: resume.menuSections.length,
      experience: resume.experience.length,
      projects: resume.projects.length,
      education: resume.education.length,
      notes,
    },
    () => {
      log(`${c.green("valid")} ${file}`);
      log(`  ${resume.menuSections.length} sections, ${resume.experience.length} experience, ${resume.projects.length} projects, ${resume.education.length} education`);
      for (const note of notes) warn(note);
    }
  );
  return 0;
});

const defaultOutputName = (input: string, extension: string): string => {
  const base = basename(input).replace(/\.[^.]+$/, "");
  return join(dirname(userPath(input)), `${base}.${extension}`);
};

const formatBytes = (bytes: number): string =>
  bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;

defineCommand("help", "Show this help", async () => {
  log(`${c.bold("magic-resume")} ${c.dim(`v${VERSION}`)} — resume editing and rendering from the command line`);
  log("");
  log(c.bold("Usage"));
  log("  magic-resume <command> [options]");
  log("");
  log(c.bold("Commands"));
  const groups: [string, string[]][] = [
    ["read", ["read", "schema", "ls", "show", "validate", "diff", "templates", "fonts"]],
    ["edit", ["init", "set", "add", "remove", "move", "clear", "template", "section"]],
    ["generate", ["ops", "variant"]],
    ["render", ["render", "preview", "export-md"]],
    ["help", ["help"]],
  ];
  const width = Math.max(...Object.keys(commands).map((name) => name.length));
  const listed = new Set<string>();
  for (const [group, names] of groups) {
    log(`  ${c.dim(group)}`);
    for (const name of names) {
      const command = commands[name];
      if (!command) continue;
      listed.add(name);
      log(`    ${name.padEnd(width + 2)}${command.summary}`);
    }
  }
  for (const [name, command] of Object.entries(commands)) {
    if (listed.has(name)) continue;
    log(`    ${name.padEnd(width + 2)}${command.summary}`);
  }
  log("");
  log(c.bold("Agent workflow"));
  log("  1. magic-resume read resume.json            # indexed text view");
  log("  2. magic-resume schema                      # paths, ops, enums");
  log("  3. write ops.json describing the changes");
  log("  4. magic-resume variant resume.json tailored.json --ops ops.json -f pdf");
  log(c.dim("  docs/agent-workflow.md has the full guide; add --json for machine output."));
  log("");
  log(c.bold("Examples"));
  log("  magic-resume init resume.json --blank");
  log('  magic-resume set resume.json basic.name "宋哈娜"');
  log('  magic-resume set resume.json --set globalSettings.lineHeight=1.6 --set basic.email=a@b.com');
  log('  magic-resume set resume.json experience.0.details @details.md');
  log('  magic-resume add resume.json experience --company "字节跳动" --position "前端" --date "2021.07 - 2024.12"');
  log("  magic-resume clear resume.json projects");
  log("  magic-resume template resume.json swiss");
  log("  magic-resume render resume.json -o out.pdf");
  log("  magic-resume preview resume.json");
  log("");
  log(c.dim("Rich-text fields (skillContent, selfEvaluationContent, details, description) accept"));
  log(c.dim("plain text, Markdown or HTML; use @file to read the value from a file."));
  log(c.dim("Every command supports --json for machine-readable output."));
  return 0;
});

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.version !== undefined) {
    log(VERSION);
    return 0;
  }

  const command = commands[args.command];
  if (!command) {
    if (args.command !== "help") {
      warn(`unknown command "${args.command}"`);
    }
    return commands.help.run(args);
  }

  pinWorkingDirectory();
  return command.run(args);
};

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof CliError || error instanceof EditError || error instanceof OpsError) {
      process.stderr.write(`${c.red("error")} ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${c.red("error")} ${(error as Error)?.stack ?? String(error)}\n`);
    process.exitCode = 1;
  });
