import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResumeTemplateComponent from "@/components/templates";
import { DEFAULT_TEMPLATES } from "@/components/templates/registry";
import { NextIntlClientProvider } from "@/i18n/compat/client";
import enMessages from "@/i18n/locales/en.json";
import zhMessages from "@/i18n/locales/zh.json";
import type { ResumeData } from "@/types/resume";
import type { Locale } from "./resume-data";

export const PREVIEW_ELEMENT_ID = "resume-preview";

/**
 * Renders the same template tree the workbench preview renders, without the
 * editor chrome: no hover highlighting, no section selection, no page break lines.
 */
export const renderResumeMarkup = (resume: ResumeData, locale: Locale = "zh"): string => {
  const template =
    DEFAULT_TEMPLATES.find((item) => item.id === resume.templateId) ?? DEFAULT_TEMPLATES[0];

  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={(locale === "en" ? enMessages : zhMessages) as Record<string, unknown>}
    >
      <ResumeTemplateComponent data={resume} template={template} />
    </NextIntlClientProvider>
  );
};

export interface RenderPageOptions {
  css: string;
  locale?: Locale;
  fontFamily?: string;
  title?: string;
}

const REMOTE_IMPORT_REGEX = /@import\s+url\(\s*['"]?https?:\/\/[^)]*\)\s*;?/gi;

/**
 * The project's global CSS opens with a Google Fonts `@import`. The CLI never
 * loads remote styles (the resume fonts ship in `public/fonts`), and leaving the
 * import in would make every render depend on network access.
 */
export const stripRemoteImports = (css: string): string =>
  css.replace(REMOTE_IMPORT_REGEX, "");

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const buildResumeHtml = (
  resume: ResumeData,
  options: RenderPageOptions
): string => {
  const locale = options.locale ?? "zh";
  const pagePadding = resume.globalSettings?.pagePadding ?? 32;
  const markup = renderResumeMarkup(resume, locale);
  const css = stripRemoteImports(options.css);

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(options.title || resume.title || "Resume")}</title>
<style>
${css}
</style>
<style>
html, body {
  margin: 0;
  padding: 0;
  background: #ffffff;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
body {
  width: 210mm;
}
/* Screen preview keeps the A4 canvas and page padding; the PDF renderer
   overrides the padding to 0 and uses the print margin instead. */
#${PREVIEW_ELEMENT_ID} {
  width: 210mm;
  min-height: 297mm;
  padding: ${pagePadding}px;
  box-sizing: border-box;
  background: #ffffff;
  font-family: ${options.fontFamily || "inherit"};
}
#${PREVIEW_ELEMENT_ID} .min-h-screen,
#${PREVIEW_ELEMENT_ID} .min-h-full {
  min-height: 0 !important;
}
#${PREVIEW_ELEMENT_ID} [data-resume-section-id] {
  cursor: default !important;
  box-shadow: none !important;
  background: transparent !important;
}
</style>
</head>
<body>
<div id="${PREVIEW_ELEMENT_ID}">${markup}</div>
</body>
</html>`;
};
