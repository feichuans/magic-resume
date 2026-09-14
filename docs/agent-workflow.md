# 用 CLI 驱动 Agent 生成简历

这份文档面向 **调用 CLI 的 Agent**（Claude Code / Codex / 自建 Agent），目标是：读一份基础简历，按 JD 生成多份定制简历并渲染成 PDF。

## 一次性准备

```bash
pnpm install
pnpm install:playwright     # 渲染需要 Chromium；不装会回退到本机 Chrome
pnpm link --global          # 之后可以直接用 magic-resume
```

## Agent 循环（4 步）

```bash
# 1. 读基础简历：带下标的纯文本视图，富文本已转成 Markdown
magic-resume read resume.json

# 2. 读可编辑面：路径、item 字段、枚举值、ops 语法
magic-resume schema

# 3. 写一批 ops（可直接管道进 stdin，避免临时文件）
cat > ops.json <<'EOF'
{ "ops": [
  { "op": "template", "templateId": "swiss" },
  { "op": "set", "path": "basic.title", "value": "高级前端工程师（React / 电商中台）" },
  { "op": "clear", "section": "projects" },
  { "op": "add", "section": "projects", "fields": {
      "name": "抖音电商创作者中台",
      "role": "前端负责人",
      "date": "2022.06 - 2023.12",
      "description": "- 面向百万级创作者的数据分析平台\n- 主导组件库建设，复用率提升至 70%"
  } },
  { "op": "section", "sectionId": "selfEvaluation", "enabled": true, "order": 3 }
] }
EOF

# 4. 生成变体并渲染，一条命令完成
magic-resume variant resume.json tailored.json \
  --ops ops.json --title "前端工程师-抖音电商" -f pdf
```

`variant` 不会修改源文件，所以基础简历可以反复复用。

## 为什么用 `read` 而不是 `show`

`show` 输出完整 JSON（含 `fieldOrder`、`icons`、`photoConfig`、UUID 等编辑态噪音）。`read` 是给模型看的：

```
sections (render order, [off] = hidden):
   0 [on ] basic            1 items  基本信息
   1 [on ] skills           1 items  专业技能
   2 [on ] experience       1 items  工作经验
   3 [on ] projects         3 items  项目经历

== experience (工作经验) ==
[0] 字节跳动 | 高级前端工程师 | 2021.07 - 2024.12
    -   负责抖音创作者平台的开发与维护，主导多个核心功能的技术方案设计
```

| 特性 | 说明 |
| --- | --- |
| `[i]` 下标 | 直接喂给 `remove` / `move` / `ops`，不用数数组 |
| 富文本转 Markdown | `<ul><li>` 变成 `- 条目`，模型不需要解析 HTML |
| `[off]` 标记 | 隐藏的模块和条目一眼可见 |
| 渲染顺序 | 按 `order` 排好，与最终 PDF 一致 |
| 无噪音字段 | 不含 id / photoConfig / fieldOrder |

实测：示例简历 `read` 是 **3924 字符**，`show` 是 **7457 字符**，省约 **47%** token。

## 全部 ops

`schema` 的 `ops` 字段里有完整定义和示例，这里是速查：

| op | 字段 | 用途 |
| --- | --- | --- |
| `set` | `path` `value` `format?` | 改单个字段，富文本自动判别 Markdown/纯文本/HTML |
| `add` | `section` `fields` `sectionId?` | 追加条目，`fields` 里支持 `@file` |
| `remove` | `section` `index` `sectionId?` | 按 `read` 显示的下标删除 |
| `move` | `section` `from` `to` | 调整条目顺序 |
| `clear` | `section` | 清空一个模块的内容，保留模块本身 |
| `template` | `templateId` | 换模板，同时更新主题色与间距 |
| `section` | `sectionId` `enabled?` `order?` `title?` `icon?` | 启用/隐藏/排序/改名模块 |

**原子性**：任何一条 op 失败，整个批次都不写入，源文件保持不变。错误信息带 op 序号：

```
error op #1 (set): unknown field "nope" in path "basic.nope"
```

先用 `--dry-run` 预览：

```bash
magic-resume ops resume.json --ops ops.json --dry-run
```

## 输出格式

所有命令都支持 `--json`，输出单个 JSON 对象（不混人类可读文本），便于 Agent 解析：

```bash
magic-resume read resume.json --json
magic-resume ls resume.json --json
magic-resume diff a.json b.json --json
magic-resume render resume.json -o out.pdf --json
magic-resume variant base.json v.json --ops - --json
```

```json
{"output":"/abs/v.pdf","format":"pdf","bytes":1186827,"pageCount":1,
 "fitsOnePage":true,"onePage":{"scale":0.75,"isScaled":true,"cannotFit":true},
 "warnings":[]}
```

`ops` 和 `variant` 的 `--ops` 支持 `-` 从 stdin 读取，Agent 不需要写临时文件：

```bash
echo '{"ops":[{"op":"set","path":"basic.title","value":"X"}]}' | magic-resume ops resume.json --ops -
```

## 校验生成结果

```bash
magic-resume validate tailored.json      # 空模块、缺姓名等提示
magic-resume diff resume.json tailored.json   # 逐字段对比改了什么
magic-resume read tailored.json | head -20    # 复核内容
```

`render --json` 的 `pageCount` 和 `onePage.cannotFit` 让 Agent 能自动判断是否需要精简内容或调整 `min-scale`：

| 情况 | 应对 |
| --- | --- |
| `pageCount > 1` 且不想缩 | 用 `clear` / `remove` 删减条目 |
| 想强行压成一页 | `--one-page --min-scale 0.75` |
| `fitsOnePage: false` | 产物确实多于一页，必须删减内容 |
| 想让某份简历默认一页 | `{ "op": "set", "path": "globalSettings.autoOnePage", "value": true }` |

`pageCount` 从生成的 PDF 里读出来，不是按高度估算的：Chrome 的 `zoom` 缩放分页行为与高度除法不一致（实测按高度算要 2 页的简历，`--min-scale 0.75` 实际输出 1 页）。判断是否成功压成一页请用 **`fitsOnePage`**。

## 典型场景

**按 JD 定制**：保留 `experience`，只替换 `projects` 和 `selfEvaluation`，换 `template`，把最相关的项目 `move` 到第一位。

**多版本批量生成**：对每个 JD 写一份 `ops-<jd>.json`，循环调用 `variant`。渲染约 5–9 秒/份。

**从零建简历**：`init resume.json --blank` 得到空骨架（标准模块齐全、内容为空），再用 `add` 逐条填充。

## 提示

- 路径下标从 **0** 开始；`experience.0.company` 和 `experience[0].company` 等价。
- 写不存在的字段会直接报错，新增内容要用 `add` / `section`。
- `skills` 和 `selfEvaluation` 是单个富文本字段，没有条目下标。
- 自定义模块：`{ "op": "add", "section": "custom", "sectionId": "awards", "fields": { "title": "最佳论文" } }` 会自动注册模块。
- 渲染结果与网页版一致：复用同一套模板组件、Tailwind 配置和 `public/fonts` 字体。
