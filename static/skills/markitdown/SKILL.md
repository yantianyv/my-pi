---
name: markitdown
description: 用微软 MarkItDown 把本地文档（PDF/Word/Excel/PPT/图片/音频/EPUB/CSV 等 13 种格式）转成 Markdown。当用户提供本地文档文件、需要读取其内容，或需要把办公文档转成结构化 Markdown 供 LLM 分析时使用；支持 CLI 单文件/批量与 Python API。
---

# MarkItDown：文档转 Markdown

微软 AutoGen 团队开源的轻量级 Python 工具（MIT 许可，需 Python 3.10+），把 PDF/Word/Excel/PPT/图片/音频等异构文档统一转成 Markdown——LLM/RAG 友好的结构化格式（标题/列表/表格/链接保留）。

## 首次使用（重要：AI 先检查、缺则自装）

**规则：每次使用本 skill 前，先确认已安装：**

```bash
markitdown --version
```

- 命令存在（输出版本号）→ 直接用
- 命令不存在（command not found）→ **AI 必须自行执行下方「安装」步骤装好后再使用**，不得因未安装而跳过转换或改用手工摘抄

## 安装教程

### 方式一：pip 安装（推荐）

全量支持（PDF/Office/图片/音频/EPUB/Outlook/YouTube 等全部格式，体积较大）：

```bash
pip install 'markitdown[all]'
```

按需安装（只装需要的格式，体积小、装得快）：

```bash
pip install 'markitdown[pdf]'                  # 只要 PDF
pip install 'markitdown[docx,pptx,xlsx]'       # Office 三件套
pip install 'markitdown[pdf,docx,pptx]'        # PDF + Word + PPT
```

Windows / 环境注意：

- `pip` 不存在时改用 `python -m pip install 'markitdown[all]'`（或 `py -m pip ...`）
- 安装后 `markitdown` 命令不在 PATH（Scripts 目录未加入 PATH）时，用 `python -m markitdown --version` 验证，后续也可用 `python -m markitdown` 调 CLI
- 装完用 `markitdown --version` 确认版本 ≥ 0.1（早期 0.0.1a 系列不完整，若装到老版则卸载重装：`pip uninstall markitdown && pip install 'markitdown[all]'`）

### 方式二：虚拟环境（可选，隔离依赖）

```bash
python -m venv .venv && source .venv/bin/activate   # Linux/macOS
# Windows: .venv\Scripts\activate
pip install 'markitdown[all]'
```

### 验证安装

```bash
markitdown --version    # 应输出如 markitdown 0.1.x
```

## 用法

### CLI：单个文件

```bash
markitdown 文件.pdf -o 输出.md      # 输出到文件
markitdown 文件.pdf > 输出.md       # 重定向到文件
markitdown 文件.docx                # 输出到 stdout
```

### CLI：批量转换

```bash
for f in *.pdf; do markitdown "$f" -o "${f%.pdf}.md"; done
```

### Python API（批量 / 嵌入工作流）

```python
from markitdown import MarkItDown
from pathlib import Path

md = MarkItDown()
for f in Path(".").glob("*.docx"):
    result = md.convert(str(f))
    Path(f"{f.stem}.md").write_text(result.text_content, encoding="utf-8")
```

### 读取转换结果

转换出的 .md 文件用 read 工具读取内容再分析；输出到 stdout 时直接使用返回文本。

## 支持格式

| 格式 | 说明 | 依赖 |
|---|---|---|
| PDF | 文本/结构提取 | markitdown[pdf] |
| Word .docx | 标题/表格/链接 | markitdown[docx] |
| PowerPoint .pptx | 幻灯片内容 | markitdown[pptx] |
| Excel .xlsx/.xls | 表格转 markdown 表格 | markitdown[xlsx] |
| 图片 | EXIF + 可选 OCR | 内置 / markitdown-ocr |
| 音频/视频 | 元数据 + 转录 | audio-transcription / youtube-transcription |
| HTML/CSV/JSON/XML/ZIP/EPUB | 内置支持 | 无 |

## 已知局限（转换后注意核对）

- **公式**：Word/PDF 中的公式（Mathtype/LaTeX）会丢失，表格内公式列常为空
- **图片**：PDF 图片消失；docx 图片尝试 base64 内嵌但可能失败/描述残缺
- **复杂 PDF**：多栏排版精度有限，扫描件需 OCR（PDF 表格常降级为纯文本）
- **链接**：部分转成裸 URL 或被换行截断
- 耗时与文件大小相关（16MB docx ≈ 2.5s，5MB PDF ≈ 12s）；超大文件注意输出截断

## 与 web_fetch 的分工

- web_fetch：抓**网页 URL** 转 markdown（web-tool 扩展）
- 本 skill：转**本地文件**（下载的 PDF/Office 等）为 markdown

两者互补：先在网页里发现文档链接 → 下载到本地 → markitdown 转换 → read 分析。
