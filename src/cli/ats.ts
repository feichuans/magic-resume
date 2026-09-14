import { readFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface AtsFinding {
  id: string;
  severity: "error" | "warn" | "info";
  message: string;
}

export interface AtsReport {
  pages: number;
  chars: number;
  findings: AtsFinding[];
  text: string;
  score: number;
}

const STANDARD_HEADINGS = ["教育经历", "专业技能", "实习经历", "工作经历", "工作经验", "项目经历", "自我评价"];

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /1[3-9]\d{9}/;
const URL_RE = /https?:\/\/[^\s)）]+/gi;
const LIGATURE_RE = /[ﬁﬂﬀﬃﬄ]/;

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
    const line = (content.items as Array<{ str?: string }>)
      .map((item) => item.str ?? "")
      .join(" ")
      .replace(/[ \t]+/g, " ")
      .trim();
    pages.push(line);
  }

  return { pages: pdf.numPages, text: pages.join("\n") };
};

/**
 * Heuristic ATS parse of a rendered PDF: contact tokens, standard headings,
 * visible URLs, and common text-layer traps (ligatures, icon-only labels).
 */
export const evaluateAtsText = (text: string, pages: number): AtsFinding[] => {
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
    findings.push({ id: "ok", severity: "info", message: "contact tokens, URLs and standard headings are present in the text layer" });
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
  const findings = evaluateAtsText(text, pages);
  return { pages, chars: text.length, findings, text, score: scoreAtsFindings(findings) };
};
