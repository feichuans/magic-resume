import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TEMPLATES } from "../src/config";
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
  tokenize,
} from "../src/cli/resume-edit";
import {
  detectLocale,
  getBlankResume,
  getSampleResume,
  normalizeResume,
  unwrapResume,
} from "../src/cli/resume-data";
import { computeOnePageScale, A4_HEIGHT_PX } from "../src/cli/browser-render";
import { OpsError, applyOps, clearSection, type ResumeOp } from "../src/cli/resume-ops";
import { buildSchema, diffResumes, renderResumeText } from "../src/cli/resume-read";

const editOptions = { baseDir: process.cwd() };

test("normalizeResume fills defaults for a minimal resume", () => {
  const resume = normalizeResume({
    title: "My Resume",
    basic: { name: "张三", email: "a@example.com" },
    experience: [{ company: "Example", position: "Engineer", date: "2020 - 2024", details: "- did things" }],
  });

  assert.equal(resume.title, "My Resume");
  assert.equal(resume.basic.name, "张三");
  assert.equal(resume.basic.photoConfig.width, 90);
  assert.equal(resume.globalSettings.pagePadding, 32);
  assert.equal(resume.templateId, DEFAULT_TEMPLATES[0].id);
  assert.equal(resume.experience.length, 1);
  assert.equal(resume.experience[0].visible, true);
  assert.ok(resume.experience[0].id);
  assert.ok(resume.menuSections.some((section) => section.id === "basic"));
});

test("normalizeResume accepts a localStorage dump and keeps unknown fields", () => {
  const sample = getSampleResume("zh");
  const dump = { state: { resumes: { [sample.id]: sample }, activeResumeId: sample.id } };
  const resume = normalizeResume(dump);

  assert.equal(resume.id, sample.id);
  assert.equal(resume.basic.name, sample.basic.name);
  assert.equal(resume.experience.length, sample.experience.length);
});

test("unwrapResume picks the active resume out of a store dump", () => {
  const raw = {
    state: {
      resumes: { a: { id: "a", title: "A" }, b: { id: "b", title: "B" } },
      activeResumeId: "b",
    },
  };
  assert.equal((unwrapResume(raw) as { title: string }).title, "B");
});

test("normalizeResume registers custom sections and their items", () => {
  const resume = normalizeResume({
    menuSections: [
      { id: "basic", title: "Basic", enabled: true, order: 0 },
      { id: "awards", title: "Awards", enabled: true, order: 1 },
    ],
    customData: { awards: [{ title: "Best paper", subtitle: "", description: "2023" }] },
  });

  assert.equal(resume.customData.awards.length, 1);
  assert.ok(resume.customData.awards[0].id);
  assert.equal(resume.menuSections.find((section) => section.id === "awards")?.title, "Awards");
});

test("normalizeResume falls back to a known template id", () => {
  const resume = normalizeResume({ templateId: "does-not-exist" });
  assert.ok(DEFAULT_TEMPLATES.some((template) => template.id === resume.templateId));
});

test("tokenize supports dot and bracket paths", () => {
  assert.deepEqual(tokenize("experience[0].company"), ["experience", 0, "company"]);
  assert.deepEqual(tokenize("menuSections.2.title"), ["menuSections", 2, "title"]);
  assert.deepEqual(tokenize("basic.name"), ["basic", "name"]);
});

test("applySet writes strings, numbers and booleans by target type", async () => {
  const resume = getBlankResume("zh");

  await applySet(resume, "basic.name", "宋哈娜", editOptions);
  await applySet(resume, "basic.phone", "13800138000", editOptions);
  await applySet(resume, "globalSettings.lineHeight", "1.6", editOptions);
  await applySet(resume, "globalSettings.autoOnePage", "true", editOptions);
  await applySet(resume, "basic.photoConfig.visible", "false", editOptions);

  assert.equal(resume.basic.name, "宋哈娜");
  assert.equal(resume.basic.phone, "13800138000");
  assert.equal(resume.globalSettings.lineHeight, 1.6);
  assert.equal(resume.globalSettings.autoOnePage, true);
  assert.equal(resume.basic.photoConfig.visible, false);
});

test("applySet converts plain text in rich-text fields into HTML", async () => {
  const resume = getBlankResume("zh");
  await applySet(resume, "skillContent", "熟悉 React\n熟悉 TypeScript", editOptions);

  assert.match(resume.skillContent, /<br \/>/);
  assert.ok(!resume.skillContent.includes("\n"));
});

test("applySet converts Markdown in rich-text fields into HTML", async () => {
  const resume = getBlankResume("zh");
  resume.experience.push({
    id: "e1",
    company: "Example",
    position: "Engineer",
    date: "2020 - 2024",
    details: "",
    visible: true,
  });

  await applySet(resume, "experience.0.details", "- one\n- two", editOptions);
  assert.match(resume.experience[0].details, /<ul>/);
  assert.match(resume.experience[0].details, /<li>one<\/li>/);
});

test("applySet keeps HTML untouched and honours --format text", async () => {
  const resume = getBlankResume("zh");
  await applySet(resume, "selfEvaluationContent", "<p>Hello</p>", editOptions);
  assert.equal(resume.selfEvaluationContent, "<p>Hello</p>");

  await applySet(resume, "skillContent", "**bold**", { ...editOptions, format: "text" });
  assert.equal(resume.skillContent, "**bold**");
});

test("applySet rejects unknown paths", async () => {
  const resume = getBlankResume("zh");
  await assert.rejects(
    () => applySet(resume, "basic.nope", "x", editOptions),
    EditError
  );
  await assert.rejects(
    () => applySet(resume, "experience.0.company", "x", editOptions),
    EditError
  );
});

test("getByPath reads nested values and accepts the settings alias", () => {
  const resume = getSampleResume("zh");
  assert.equal(getByPath(resume, "basic.name"), resume.basic.name);
  assert.equal(getByPath(resume, "settings.lineHeight"), resume.globalSettings.lineHeight);
  assert.equal(getByPath(resume, "experience.0.company"), resume.experience[0].company);
  assert.equal(getByPath(resume, "nothing.here"), undefined);
});

test("applyTemplate adopts the template colour, spacing and layout", () => {
  const resume = getSampleResume("zh");
  const target = DEFAULT_TEMPLATES.find((template) => template.id === "swiss")!;
  applyTemplate(resume, target.id);

  assert.equal(resume.templateId, "swiss");
  assert.equal(resume.globalSettings.themeColor, target.colorScheme.primary);
  assert.equal(resume.globalSettings.pagePadding, target.spacing.contentPadding);
  assert.equal(resume.basic.layout, target.basic.layout);
});

test("applyTemplate rejects unknown templates", () => {
  const resume = getBlankResume("zh");
  assert.throws(() => applyTemplate(resume, "nope"), EditError);
});

test("applySection toggles, renames and reorders", () => {
  const resume = getBlankResume("zh");
  applySection(resume, "education", { enable: false, order: 9, title: "学习经历" });

  const section = resume.menuSections.find((item) => item.id === "education")!;
  assert.equal(section.enabled, false);
  assert.equal(section.order, 9);
  assert.equal(section.title, "学习经历");
});

test("applySection refuses unknown sections", () => {
  const resume = getBlankResume("zh");
  assert.throws(() => applySection(resume, "awards", { enable: true }), EditError);
});

test("normalizeSectionName maps aliases and rejects content-only sections", () => {
  assert.equal(normalizeSectionName("Experience"), "experience");
  assert.equal(normalizeSectionName("projects"), "projects");
  assert.equal(normalizeSectionName("certificates"), "certificates");
  assert.equal(normalizeSectionName("skills"), null);
  assert.equal(normalizeSectionName("unknown"), null);
});

test("addItem/removeItem/moveItem operate on the section lists", () => {
  const resume = getBlankResume("zh");

  addItem(resume, "experience", { company: "A", position: "Dev", date: "2020", details: "- x" }, { baseDir: process.cwd() });
  addItem(resume, "experience", { company: "B", position: "Dev", date: "2021" }, { baseDir: process.cwd() });
  addItem(resume, "education", { school: "S", major: "CS" }, { baseDir: process.cwd() });
  addItem(resume, "custom", { title: "Award" }, { sectionId: "awards", baseDir: process.cwd() });

  assert.equal(resume.experience.length, 2);
  assert.match(resume.experience[0].details, /<ul>/);
  assert.equal(resume.education.length, 1);
  assert.equal(resume.customData.awards.length, 1);
  assert.ok(resume.menuSections.some((section) => section.id === "awards"));

  moveItem(resume, "experience", 0, 1);
  assert.equal(resume.experience[0].company, "B");

  const removed = removeItem(resume, "experience", 0) as { company: string };
  assert.equal(removed.company, "B");
  assert.equal(resume.experience.length, 1);
});

test("addItem requires the fields that identify an item", () => {
  const resume = getBlankResume("zh");
  assert.throws(
    () => addItem(resume, "custom", { title: "Award" }, { baseDir: process.cwd() }),
    EditError
  );
});

test("applySection registers a standard section missing from a blank resume", () => {
  const resume = getBlankResume("zh");
  assert.ok(!resume.menuSections.some((section) => section.id === "certificates"));

  const result = applySection(resume, "certificates", { enable: true, locale: "zh" });

  assert.equal(result.created, true);
  assert.equal(result.section.title, "证书作品");
  assert.equal(result.section.enabled, true);
});

test("applySection still refuses unknown sections", () => {
  const resume = getBlankResume("zh");
  assert.throws(() => applySection(resume, "awards", { enable: true }), EditError);
});

test("addItem registers the section it adds to", () => {
  const resume = getBlankResume("en");
  addItem(resume, "certificates", { url: "/avatar.png" }, { baseDir: process.cwd(), locale: "en" });

  const section = resume.menuSections.find((item) => item.id === "certificates");
  assert.ok(section);
  assert.equal(section?.title, "Certificates");
  assert.equal(resume.certificates.length, 1);
});

test("detectLocale reads the locale from section titles", () => {
  assert.equal(detectLocale(getBlankResume("zh")), "zh");
  assert.equal(detectLocale(getBlankResume("en")), "en");
  assert.equal(
    detectLocale({
      menuSections: [{ id: "basic", title: "基本信息", icon: "", enabled: true, order: 0 }],
      basic: { name: "李四" },
    }),
    "zh"
  );
});

test("computeOnePageScale mirrors the workbench thresholds", () => {
  const pagePadding = 32;
  const usable = A4_HEIGHT_PX - 2 * pagePadding;

  const fits = computeOnePageScale(usable + 2 * pagePadding - 10, pagePadding);
  assert.equal(fits.isScaled, false);

  const slightOverflow = computeOnePageScale(usable * 1.05 + 2 * pagePadding, pagePadding);
  assert.equal(slightOverflow.isScaled, true);
  assert.equal(slightOverflow.cannotFit, false);
  assert.ok(slightOverflow.scale < 1 && slightOverflow.scale >= 0.9);

  const wayOver = computeOnePageScale(usable * 3 + 2 * pagePadding, pagePadding);
  assert.equal(wayOver.scale, 0.9);
  assert.equal(wayOver.cannotFit, true);
});

// --------------------------------------------------------- agent interface --

test("renderResumeText exposes indices, hides JSON noise and flattens rich text", () => {
  const resume = getSampleResume("zh");
  const text = renderResumeText(resume);

  assert.match(text, /^resume: /m);
  assert.match(text, /sections \(render order/);
  assert.match(text, /== experience \(工作经验\) ==/);
  assert.match(text, /\[0\] 字节跳动 \| 高级前端工程师/);
  assert.match(text, /^ {4}- {3}负责抖音创作者平台/m);

  // The agent should not be reading editor bookkeeping.
  assert.ok(!text.includes("fieldOrder"));
  assert.ok(!text.includes("photoConfig"));
  assert.ok(!text.includes("draggingProjectId"));
  assert.ok(!text.includes("<ul>"));
  assert.ok(!text.includes("<li>"));
});

test("renderResumeText marks hidden sections and hidden items", () => {
  const resume = getBlankResume("zh");
  resume.menuSections.find((section) => section.id === "education")!.enabled = false;
  addItem(
    resume,
    "experience",
    { company: "Hidden Co", position: "Dev", date: "2020", visible: "false" },
    { baseDir: process.cwd() }
  );

  const text = renderResumeText(resume);
  assert.match(text, /\[off\] education/);
  assert.match(text, /\[0\] \[off\] Hidden Co/);
});

test("buildSchema lists paths, item fields and enums", () => {
  const schema = buildSchema();

  assert.ok(schema.paths.includes("experience[i].details"));
  assert.deepEqual(schema.items.projects.required, ["name"]);
  assert.ok(schema.enums.templateId.includes("swiss"));
  assert.ok(schema.enums.fontFamily.length >= 4);
  assert.ok(schema.richTextFields.includes("skillContent"));
});

test("diffResumes reports field-level changes only", () => {
  const before = getBlankResume("zh");
  const after = JSON.parse(JSON.stringify(before)) as typeof before;
  after.basic.name = "张三";
  after.updatedAt = new Date(Date.now() + 1000).toISOString();

  const entries = diffResumes(before, after);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, "basic.name");
  assert.equal(entries[0].from, "");
  assert.equal(entries[0].to, "张三");
});

test("applyOps applies a batch and leaves the input untouched", async () => {
  const resume = getBlankResume("zh");
  const ops: ResumeOp[] = [
    { op: "set", path: "basic.name", value: "张三" },
    { op: "set", path: "skillContent", value: "- React\n- TypeScript" },
    { op: "template", templateId: "swiss" },
    { op: "add", section: "projects", fields: { name: "P1", description: "- did it" } },
    { op: "section", sectionId: "selfEvaluation", enabled: true, order: 3 },
  ];

  const { resume: next, applied } = await applyOps(resume, ops, { baseDir: process.cwd() });

  assert.equal(applied.length, 5);
  assert.equal(resume.basic.name, "");
  assert.equal(next.basic.name, "张三");
  assert.match(next.skillContent, /<ul>/);
  assert.equal(next.templateId, "swiss");
  assert.equal(next.projects.length, 1);
  assert.ok(next.menuSections.some((section) => section.id === "selfEvaluation"));
});

test("applyOps is atomic: a failing op leaves nothing applied", async () => {
  const resume = getBlankResume("zh");
  const ops: ResumeOp[] = [
    { op: "set", path: "basic.name", value: "张三" },
    { op: "set", path: "basic.doesNotExist", value: "x" },
  ];

  await assert.rejects(() => applyOps(resume, ops, { baseDir: process.cwd() }), OpsError);
  assert.equal(resume.basic.name, "");
});

test("applyOps resolves @file for add fields", async () => {
  const resume = getBlankResume("zh");
  const { resume: next } = await applyOps(
    resume,
    [{ op: "add", section: "experience", fields: { company: "C", details: "@tests/fixtures/details.md" } }],
    { baseDir: process.cwd() }
  );

  assert.match(next.experience[0].details, /<li>主导核心功能方案设计<\/li>/);
});

test("applyOps rejects unknown ops with the index of the failure", async () => {
  const resume = getBlankResume("zh");
  await assert.rejects(
    () => applyOps(resume, [{ op: "nope" }], { baseDir: process.cwd() }),
    /op #0 \(nope\)/
  );
});

test("clearSection empties one section and keeps the rest", () => {
  const resume = getSampleResume("zh");
  clearSection(resume, "projects");

  assert.equal(resume.projects.length, 0);
  assert.ok(resume.experience.length > 0);
  assert.ok(resume.menuSections.some((section) => section.id === "projects"));
});

test("countPdfPages reads the real page count from the PDF bytes", async () => {
  const { countPdfPages } = await import("../src/cli/browser-render");
  const { readFile } = await import("node:fs/promises");
  const pdf = await readFile("tests/fixtures/two-pages.pdf");
  assert.equal(countPdfPages(pdf), 2);

  const onePage = await readFile("tests/fixtures/one-page.pdf");
  assert.equal(countPdfPages(onePage), 1);
});

test("computeOnePageScale cannotFit only reflects the raw height ratio", () => {
  const pagePadding = 32;
  const usable = A4_HEIGHT_PX - 2 * pagePadding;

  // 72% would be needed, so at the 0.9 floor the flag is set — but the real PDF
  // may still fit one page, which is why renderResume reports `fitsOnePage`.
  const result = computeOnePageScale(usable / 0.72 + 2 * pagePadding, pagePadding, 0.9);
  assert.equal(result.scale, 0.9);
  assert.equal(result.cannotFit, true);

  const fits = computeOnePageScale(usable / 0.72 + 2 * pagePadding, pagePadding, 0.7);
  assert.equal(fits.scale, 0.72);
  assert.equal(fits.cannotFit, false);
});

test("applyOps writes to a new file and never touches the source", async () => {
  const resume = getBlankResume("zh");
  const before = JSON.stringify(resume);
  const { resume: next } = await applyOps(
    resume,
    [{ op: "set", path: "basic.name", value: "张三" }],
    { baseDir: process.cwd() }
  );

  assert.equal(JSON.stringify(resume), before);
  assert.equal(next.basic.name, "张三");
  assert.notEqual(next, resume);
});

test("evaluateAtsText flags icon-only website/github labels and missing contact", async () => {
  const { evaluateAtsText, scoreAtsFindings } = await import("../src/cli/ats");
  const bad = evaluateAtsText("张三 前端开发 个人网站 Github 某某科技", 2);
  const ids = bad.map((item) => item.id);
  assert.ok(ids.includes("email"));
  assert.ok(ids.includes("phone"));
  assert.ok(ids.includes("url"));
  assert.ok(ids.includes("website-label"));
  assert.ok(ids.includes("github-label"));
  assert.ok(ids.includes("headings"));
  assert.ok(scoreAtsFindings(bad) < 50);
});

test("evaluateAtsText accepts a well-formed text layer", async () => {
  const { evaluateAtsText, scoreAtsFindings } = await import("../src/cli/ats");
  const text = `张三
邮箱: zhangsan@example.com
电话: 13800000000
个人网站: https://example.com
Github: https://github.com/example
教育经历 某某大学
专业技能 TypeScript React
实习经历 某某科技
项目经历 Example https://github.com/example/project`;
  const findings = evaluateAtsText(text, 2);
  assert.equal(scoreAtsFindings(findings), 100);
  assert.equal(findings[0].id, "ok");
});

test("parseAtsCard splits projects on date lines and flags a glued title+email row", async () => {
  const { parseAtsCard, evaluateAtsText } = await import("../src/cli/ats");
  const glued = `张三
前端开发邮箱:zhangsan@example.com 电话:13800000000
教育经历
某某大学 本科 2023/09 - 2027/06
专业技能
TypeScript
实习经历
某某科技有限公司 前端开发 2026/03 - 2026/08
项目背景：内部平台
某某教育科技有限公司 前端开发 2025/06 - 2025/12
项目经历
Example｜内部交付平台 2026/06 - 2026/09
前端核心贡献者
项目地址：https://github.com/example/platform
会话实时流
AnotherProject 2026/02 - 2026/06
前端贡献者
项目地址：https://github.com/example/another/pull/1
控制台`;
  const card = parseAtsCard(glued);
  assert.equal(card.name, "张三");
  assert.equal(card.title, "前端开发");
  assert.equal(card.email, "zhangsan@example.com");
  assert.equal(card.experience.length, 2);
  assert.equal(card.projects.length, 2);
  assert.equal(card.projects[0].name, "Example｜内部交付平台");
  assert.equal(card.projects[1].name, "AnotherProject");
  const gluedFindings = evaluateAtsText(glued, 2, card).map((item) => item.id);
  assert.ok(gluedFindings.includes("glued-contact"));

  const merged = `张三
邮箱: a@b.com
电话: 13800000000
个人网站: https://example.com
教育经历
学校
专业技能
TS
实习经历
公司 2026/03 - 2026/08
项目经历
Example｜内部交付平台 前端核心贡献者 2026/06 - 2026/09
https://github.com/example/platform
描述
AnotherProject 前端贡献者 2026/02 - 2026/06
https://github.com/example/another/pull/1`;
  const mergedCard = parseAtsCard(merged);
  assert.equal(mergedCard.projects.length, 2);
  const mergedIds = evaluateAtsText(merged, 2, mergedCard).map((item) => item.id);
  assert.ok(mergedIds.includes("project-unlabeled-url"));
});
