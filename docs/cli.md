# Magic Resume CLI

命令行版本的编辑与渲染：不用启动网页编辑器，直接用 JSON 文件编辑简历，再在无头浏览器里渲染成 PDF / PNG。

CLI 复用网页版的模板组件、Tailwind 样式和字体，所以同一份 `resume.json` 在 CLI 和网页工作台里渲染结果一致。

## 快速开始

```bash
pnpm install
node bin/magic-resume.mjs help

node bin/magic-resume.mjs init resume.json          # 带示例内容的简历
node bin/magic-resume.mjs init resume.json --blank  # 空简历骨架
```

安装成全局命令（可选）：

```bash
pnpm link --global
magic-resume help
```

## 编辑

```bash
# 单字段
magic-resume set resume.json basic.name "宋哈娜"
magic-resume set resume.json globalSettings.lineHeight 1.6

# 一次多个字段（每个 --set 必须写成 <path>=<value> 一个参数）
magic-resume set resume.json --set basic.email=a@b.com --set basic.phone=13800138000

# 增删改排序
magic-resume add resume.json experience --company "字节跳动" --position "前端工程师" \
  --date "2021.07 - 2024.12" --details @details.md
magic-resume remove resume.json experience 0
magic-resume move resume.json experience 0 1

# 模板与模块
magic-resume template resume.json swiss
magic-resume section resume.json certificates --enable --order 5   # 标准模块不在空白简历里，第一次用会自动注册
magic-resume section resume.json education --disable

# 查看
magic-resume ls resume.json
magic-resume show resume.json basic
magic-resume validate resume.json
magic-resume export-md resume.json -o resume.md
```

### 路径写法

点号或方括号都可以，数组下标从 0 开始：

```
basic.name
experience.0.company
experience[0].company
menuSections.2.title
globalSettings.themeColor
settings.lineHeight          # globalSettings 的简写
```

写入时字段名必须已存在（拼错会直接报错），新增条目用 `add` / `section`。

### 富文本字段

`skillContent`、`selfEvaluationContent`、`details`、`description` 是 HTML 富文本。CLI 会自动判断输入：

| 输入 | 结果 |
| --- | --- |
| `"熟悉 React"` 纯文本 | 转义后按行加 `<br />` |
| `"- 一条\n- 两条"` Markdown | 转成 `<ul><li>` |
| `"<p>已有 HTML</p>"` | 原样保留 |
| `@file.md` | 读文件（`.md` 按 Markdown 转换） |

`--format text|markdown|html|json` 可以强制指定，`json` 用于写入非字符串值。

## 渲染

```bash
magic-resume render resume.json -o out.pdf
magic-resume render resume.json -o out.png
magic-resume render resume.json --format pdf --html      # 同时导出中间 HTML
magic-resume render resume.json --one-page               # 缩放到正好一页
magic-resume render resume.json --no-one-page
magic-resume render resume.json --min-scale 0.72         # 允许比网页版更小的下限
magic-resume render resume.json --locale en
magic-resume preview resume.json                         # 本地起服务看效果
```

渲染流程：Vite 现场编译模板组件和 Tailwind 样式 → React 服务端渲染成静态 HTML → 本地 HTTP 服务提供字体和图片 → Playwright 打开页面、等待字体和图片加载 → 输出 PDF 或 PNG。

| 选项 | 说明 |
| --- | --- |
| `-o, --output` | 输出路径，默认与输入同名的 `.pdf` / `.png` |
| `-f, --format` | `pdf` 或 `png`，默认按输出后缀判断 |
| `--one-page` | 强制缩放到一页（网页版"一页纸"模式） |
| `--no-one-page` | 关闭缩放，即使 `autoOnePage` 为真 |
| `--min-scale` | 缩放下限，默认 0.9，与网页版一致 |
| `--image-scale` | PNG 的像素倍率，默认 2 |
| `--html` | 同时写出中间 HTML，便于排查样式问题 |
| `--browser-channel` | 指定 `chrome` / `msedge` 通道 |

不传 `--one-page` / `--no-one-page` 时，用简历里的 `globalSettings.autoOnePage` 决定。

### 浏览器依赖

渲染需要 Chromium。优先使用 Playwright 自带的版本：

```bash
pnpm install:playwright   # playwright install chromium
```

没有安装时，CLI 会自动回退到本机 Chrome / Edge（并打印一条 warning）。

## 与网页版的关系

- 只复用渲染相关代码：`src/components/templates/**`、`src/utils/fonts.ts`、`src/lib/richText.ts`、`src/config/**`、`src/i18n/**`。
- 编辑功能是一套新的文件模型：直接读写 `resume.json`，不依赖 zustand store 和 localStorage。store 的导出（含 `{ state: { resumes } }` 结构）也能被 `normalizeResume` 识别。
- 渲染时 `[data-resume-section-id]` 的悬停高亮和点击选中被 CSS 覆盖掉，分页线不渲染。

## 测试

```bash
pnpm test:cli        # tests/cli.test.ts
pnpm test:ai         # 原有测试
```
