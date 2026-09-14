import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface AtsFinding {
  id: string;
  severity: "error" | "warn" | "info";
  message: string;
}

export interface AtsEntry {
  name: string;
  role?: string;
  date?: string;
  url?: string;
  body: string;
}

export interface AtsCard {
  name: string;
  title: string;
  email: string;
  phone: string;
  urls: string[];
  education: string[];
  skills: string;
  experience: AtsEntry[];
  projects: AtsEntry[];
}

export interface AtsReport {
  pages: number;
  chars: number;
  findings: AtsFinding[];
  text: string;
  parsed: AtsCard;
  score: number;
}

const STANDARD_HEADINGS = [
  "教育经历",
  "专业技能",
  "实习经历",
  "工作经历",
  "工作经验",
  "项目经历",
  "自我评价",
] as const;

const HEADING_SET = new Set<string>(STANDARD_HEADINGS);
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /1[3-9]\d{9}/;
const URL_RE = /https?:\/\/[^\s)）]+/gi;
const LIGATURE_RE = /[ﬁﬂﬀﬃﬄ]/;
const DATE_RE =
  /\d{4}\s*[./年-]\s*\d{1,2}(?:\s*[-–—~至到]\s*(?:\d{4}\s*[./年-]\s*\d{1,2}|至今|现在|present))?/i;

type PdfTextItem = {
  str?: string;
  transform?: number[];
  width?: number;
  hasEOL?: boolean;
};

const lineKey = (y: number): number => Math.round(y * 2) / 2;

const extractPdfText = async (pdfPath: string): Promise<{ pages: number; text: string }> => {
  const data = new Uint8Array(await readFile(pdfPath));
  const pdf = await getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const pages: string[] = [];
  for (let index = 1; index <= pdf.numPages; index += 1) {
    const page = await pdf.getPage(index);
    const content = await page.getTextContent();
    const rows = new Map<number, Array<{ x: number; str: string }>>();

    for (const raw of content.items as PdfTextItem[]) {
      const str = raw.str ?? "";
      if (!str) continue;
      const transform = raw.transform ?? [1, 0, 0, 1, 0, 0];
      const x = transform[4] ?? 0;
      const y = lineKey(transform[5] ?? 0);
      const row = rows.get(y) ?? [];
      row.push({ x, str });
      rows.set(y, row);
    }

    const lines = [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, parts]) =>
        parts
          .sort((a, b) => a.x - b.x)
          .map((part) => part.str)
          .join("")
          .replace(/[ \t]+/g, " ")
          .trim()
      )
      .filter(Boolean);

    pages.push(lines.join("\n"));
  }

  return { pages: pdf.numPages, text: pages.join("\n") };
};

const linesOf = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);

const takeDate = (line: string): { name: string; date?: string } => {
  const match = line.match(DATE_RE);
  if (!match || match.index === undefined) return { name: line };
  const date = match[0].replace(/\s+/g, " ").trim();
  const name = `${line.slice(0, match.index)} ${line.slice(match.index + match[0].length)}`
    .replace(/\s+/g, " ")
    .trim();
  return { name, date };
};

const splitEntries = (body: string): AtsEntry[] => {
  const lines = linesOf(body);
  if (lines.length === 0) return [];

  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (DATE_RE.test(lines[index])) starts.push(index);
  }
  if (starts.length === 0) {
    return [{ name: lines[0], body: lines.slice(1).join("\n") }];
  }

  const entries: AtsEntry[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index];
    const to = starts[index + 1] ?? lines.length;
    const chunk = lines.slice(from, to);
    const { name, date } = takeDate(chunk[0] ?? "");
    const rest = chunk.slice(1);
    const urlLine = rest.find((line) => URL_RE.test(line));
    const url = urlLine?.match(URL_RE)?.[0];
    const first = rest[0] ?? "";
    const role =
      first &&
      !URL_RE.test(first) &&
      !first.startsWith("项目地址") &&
      first.length <= 40 &&
      !first.includes("：") &&
      !first.includes(":")
        ? first
        : undefined;
    const bodyLines = rest.filter((line) => line !== urlLine && line !== role);
    entries.push({
      name: name || chunk[0] || "",
      role,
      date,
      url,
      body: bodyLines.join("\n"),
    });
  }
  return entries;
};

const sectionBodies = (lines: string[]): Record<string, string> => {
  const bodies: Record<string, string> = {};
  let current: string | undefined;
  const bucket: string[] = [];

  const flush = () => {
    if (current) bodies[current] = bucket.join("\n");
    bucket.length = 0;
  };

  for (const line of lines) {
    if (HEADING_SET.has(line)) {
      flush();
      current = line;
      continue;
    }
    if (current) bucket.push(line);
  }
  flush();
  return bodies;
};

/**
 * Field-level card a Beisen / Feishu / Moka-style parser would fill
 * from a newline-preserving text layer.
 */
export const parseAtsCard = (text: string): AtsCard => {
  const lines = linesOf(text);
  const firstHeading = lines.findIndex((line) => HEADING_SET.has(line));
  const header = firstHeading === -1 ? lines : lines.slice(0, firstHeading);
  const bodies = sectionBodies(lines);

  const headerText = header.join("\n");
  const email = headerText.match(EMAIL_RE)?.[0] ?? text.match(EMAIL_RE)?.[0] ?? "";
  const phone = headerText.match(PHONE_RE)?.[0] ?? text.match(PHONE_RE)?.[0] ?? "";
  const urls = [...new Set(text.match(URL_RE) ?? [])];

  const name = header[0] ?? "";
  const titleLine =
    header.find((line) => line !== name && !/^https?:/i.test(line) && !EMAIL_RE.test(line) && !PHONE_RE.test(line)) ??
    header.find((line) => line !== name && /(邮箱|电话|手机)[:：]/.test(line)) ??
    "";
  const glued = titleLine.match(/^(.*?)(邮箱|电话|手机|个人网站|Github)/);
  const title = (glued ? glued[1] : titleLine).replace(/[:：]\s*$/, "").trim();

  const educationRaw = bodies["教育经历"] ?? "";
  const experienceRaw = bodies["实习经历"] || bodies["工作经历"] || bodies["工作经验"] || "";
  const projectRaw = bodies["项目经历"] ?? "";

  return {
    name,
    title,
    email,
    phone,
    urls,
    education: educationRaw ? [educationRaw] : [],
    skills: bodies["专业技能"] ?? "",
    experience: splitEntries(experienceRaw),
    projects: splitEntries(projectRaw),
  };
};

const findGluedContact = (text: string): string | undefined => {
  const match = text.match(/([^\s:：]{2,20})(邮箱|电话|手机)[:：]/);
  if (!match) return undefined;
  if (EMAIL_RE.test(match[1]) || PHONE_RE.test(match[1])) return undefined;
  return match[0];
};

/**
 * Heuristic ATS parse of a rendered PDF: contact tokens, standard headings,
 * visible URLs, and common text-layer traps (ligatures, icon-only labels).
 */
export const evaluateAtsText = (text: string, pages: number, parsed: AtsCard = parseAtsCard(text)): AtsFinding[] => {
  const findings: AtsFinding[] = [];

  if (!EMAIL_RE.test(text)) {
    findings.push({ id: "email", severity: "error", message: "text layer has no email address" });
  }
  if (!PHONE_RE.test(text)) {
    findings.push({ id: "phone", severity: "error", message: "text layer has no 11-digit mainland phone number" });
  }

  const urls = text.match(URL_RE) ?? [];
  if (urls.length === 0) {
    findings.push({
      id: "url",
      severity: "error",
      message: "text layer has no visible https:// URL (icon-only or displayLabel-only links are invisible to ATS)",
    });
  }

  const headingHits = STANDARD_HEADINGS.filter((heading) => text.includes(heading));
  if (headingHits.length < 3) {
    findings.push({
      id: "headings",
      severity: "error",
      message: `found ${headingHits.length} standard headings (${headingHits.join(", ") || "none"}); ATS parsers look for 教育经历 / 专业技能 / 实习经历|工作经历 / 项目经历`,
    });
  }

  if (/个人网站(?!\s*[：:]\s*https?:)/.test(text) && !/个人网站[：:]\s*https?:\/\//.test(text)) {
    findings.push({
      id: "website-label",
      severity: "error",
      message: "parsed \"个人网站\" without a following URL — the link is likely icon-only or displayLabel-only",
    });
  }
  if (/\bGithub\b/i.test(text) && !/github\.com/i.test(text)) {
    findings.push({
      id: "github-label",
      severity: "error",
      message: "parsed \"Github\" without github.com — the profile URL is not in the text layer",
    });
  }

  const glued = findGluedContact(text);
  if (glued) {
    findings.push({
      id: "glued-contact",
      severity: "error",
      message: `title and contact label share a line (${JSON.stringify(glued.trim())}); parsers fill 职位 as "…邮箱"`,
    });
  }

  const urlNamed = parsed.projects.filter((item) => /^https?:/i.test(item.name));
  if (urlNamed.length > 0) {
    findings.push({
      id: "project-url-as-name",
      severity: "error",
      message: `${urlNamed.length} project(s) start with a bare URL — the previous title likely split across a page and merged into the next item`,
    });
  }

  const unlabeledUrls = parsed.projects.filter(
    (item) => item.url && !new RegExp(`项目地址[：:]\\s*${item.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(text)
  );
  if (unlabeledUrls.length > 0 && parsed.projects.length > 1) {
    findings.push({
      id: "project-unlabeled-url",
      severity: "warn",
      message: `${unlabeledUrls.length} project URL(s) have no "项目地址:" label; a bare URL between titles is a common merge point`,
    });
  }

  const dateLinesInProjects = linesOf(text.slice(text.indexOf("项目经历") === -1 ? 0 : text.indexOf("项目经历"))).filter(
    (line) => DATE_RE.test(line) && !HEADING_SET.has(line)
  );
  if (text.includes("项目经历") && dateLinesInProjects.length >= 2 && parsed.projects.length === 1) {
    findings.push({
      id: "project-merged",
      severity: "error",
      message: `project section has ${dateLinesInProjects.length} date lines but parsed as 1 entry — items were merged`,
    });
  }

  if (LIGATURE_RE.test(text)) {
    findings.push({
      id: "ligature",
      severity: "warn",
      message: "text layer contains typographic ligatures (ﬁ/ﬂ/ﬀ); keywords like flash / Diff may not match",
    });
  }

  if (pages > 2) {
    findings.push({
      id: "pages",
      severity: "warn",
      message: `${pages} pages — campus-recruit ATS and recruiters usually expect 1–2`,
    });
  }

  if (findings.length === 0) {
    findings.push({
      id: "ok",
      severity: "info",
      message: `contact tokens, URLs and standard headings are present; parsed ${parsed.experience.length} experience / ${parsed.projects.length} project entries`,
    });
  }

  return findings;
};

export const scoreAtsFindings = (findings: AtsFinding[]): number => {
  const errors = findings.filter((item) => item.severity === "error").length;
  const warns = findings.filter((item) => item.severity === "warn").length;
  return Math.max(0, 100 - errors * 25 - warns * 10);
};

export const inspectResumePdf = async (pdfPath: string): Promise<AtsReport> => {
  const { pages, text } = await extractPdfText(pdfPath);
  const parsed = parseAtsCard(text);
  const findings = evaluateAtsText(text, pages, parsed);
  return { pages, chars: text.length, findings, text, parsed, score: scoreAtsFindings(findings) };
};
