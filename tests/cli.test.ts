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
