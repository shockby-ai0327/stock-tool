#!/usr/bin/env python3
from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from pathlib import Path


SOURCE_DIR = Path("/Users/rich/Desktop/ai/trade-guide")
OUTPUT_FILE = SOURCE_DIR / "index.html"
SOURCE_FILES = [
    "00-INDEX.md",
    "01-company-industry.md",
    "02-international-trade-basics.md",
    "03-scenarios-part1.md",
    "04-scenarios-part2.md",
    "05-scenarios-part3.md",
    "06-scenarios-part4.md",
    "07-negotiation-small-talk.md",
    "08-advanced-skills.md",
]


@dataclass
class SectionLink:
    level: int
    title: str
    anchor: str


@dataclass
class Document:
    filename: str
    title: str = ""
    lead: str = ""
    anchor: str = ""
    top_sections: list[SectionLink] = field(default_factory=list)
    body_html: str = ""


def unique_anchor(base: str, seen: set[str]) -> str:
    anchor = base
    index = 2
    while anchor in seen:
        anchor = f"{base}-{index}"
        index += 1
    seen.add(anchor)
    return anchor


def slugify(text: str) -> str:
    cleaned = strip_inline_markdown(text).strip().lower()
    chunks: list[str] = []
    for char in cleaned:
        if char.isalnum() or "\u4e00" <= char <= "\u9fff":
            chunks.append(char)
        else:
            chunks.append("-")
    slug = re.sub(r"-+", "-", "".join(chunks)).strip("-")
    return slug or "section"


def strip_inline_markdown(text: str) -> str:
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", text)
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"__(.+?)__", r"\1", text)
    text = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"\1", text)
    text = re.sub(r"(?<!_)_([^_\n]+)_(?!_)", r"\1", text)
    return html.unescape(text)


def resolve_href(url: str, file_anchor_map: dict[str, str]) -> str:
    url = html.unescape(url).strip()
    if not url:
        return "#"
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", url) or url.startswith("#"):
        return url
    path_part, _, fragment = url.partition("#")
    name = Path(path_part).name
    if name in file_anchor_map:
        target = f"#{file_anchor_map[name]}"
        if fragment:
            return target
        return target
    return url


def apply_emphasis(text: str) -> str:
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"__(.+?)__", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", text)
    text = re.sub(r"(?<!_)_([^_\n]+)_(?!_)", r"<em>\1</em>", text)
    return text


def parse_inline(text: str, file_anchor_map: dict[str, str]) -> str:
    placeholders: dict[str, str] = {}

    def stash(markup: str) -> str:
        key = f"§§INLINE{len(placeholders)}§§"
        placeholders[key] = markup
        return key

    escaped = html.escape(text, quote=False)

    def code_repl(match: re.Match[str]) -> str:
        return stash(f"<code>{html.escape(html.unescape(match.group(1)))}</code>")

    escaped = re.sub(r"`([^`]+)`", code_repl, escaped)

    def link_repl(match: re.Match[str]) -> str:
        label = apply_emphasis(match.group(1))
        href = resolve_href(match.group(2), file_anchor_map)
        attrs = ""
        if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", href):
            attrs = ' target="_blank" rel="noopener noreferrer"'
        return stash(f'<a href="{html.escape(href, quote=True)}"{attrs}>{label}</a>')

    escaped = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", link_repl, escaped)
    escaped = apply_emphasis(escaped)

    for key, value in placeholders.items():
        escaped = escaped.replace(key, value)
    return escaped


def is_table_separator(line: str) -> bool:
    stripped = line.strip()
    if "|" not in stripped:
        return False
    cells = [cell.strip() for cell in stripped.strip("|").split("|")]
    if not cells:
        return False
    return all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells)


def parse_table_row(line: str) -> list[str]:
    stripped = line.strip().strip("|")
    return [cell.strip() for cell in stripped.split("|")]


def list_match(line: str) -> re.Match[str] | None:
    return re.match(r"^(\s*)([-*+]|\d+\.)\s+(.*)$", line)


def task_match(line: str) -> re.Match[str] | None:
    return re.match(r"^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$", line)


def is_special_start(line: str, next_line: str | None = None) -> bool:
    stripped = line.strip()
    if not stripped:
        return True
    if stripped.startswith("```"):
        return True
    if re.match(r"^#{1,6}\s+", line):
        return True
    if stripped.startswith(">"):
        return True
    if stripped == "---":
        return True
    if task_match(line) or list_match(line):
        return True
    if next_line is not None and "|" in line and is_table_separator(next_line):
        return True
    return False


def render_list(items: list[tuple[str, str]], ordered: bool, file_anchor_map: dict[str, str]) -> str:
    tag = "ol" if ordered else "ul"
    list_class = "task-list" if items and items[0][0] in {"checked", "unchecked"} else ""
    class_attr = f' class="{list_class}"' if list_class else ""
    parts = [f"<{tag}{class_attr}>"]
    for kind, content in items:
        body = parse_inline(content, file_anchor_map)
        if kind == "checked":
            parts.append(
                '<li class="task-item"><span class="task-box is-checked" aria-hidden="true"></span>'
                f"<span>{body}</span></li>"
            )
        elif kind == "unchecked":
            parts.append(
                '<li class="task-item"><span class="task-box" aria-hidden="true"></span>'
                f"<span>{body}</span></li>"
            )
        else:
            parts.append(f"<li>{body}</li>")
    parts.append(f"</{tag}>")
    return "".join(parts)


def parse_document(path: Path, file_anchor_map: dict[str, str]) -> Document:
    lines = path.read_text(encoding="utf-8").splitlines()
    doc = Document(filename=path.name, anchor=file_anchor_map[path.name])
    blocks: list[str] = []
    seen_anchors: set[str] = {doc.anchor}
    i = 0

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            i += 1
            continue

        if stripped.startswith("```"):
            code_lines: list[str] = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code_lines.append(lines[i])
                i += 1
            if i < len(lines):
                i += 1
            code = html.escape("\n".join(code_lines))
            blocks.append(f"<pre><code>{code}</code></pre>")
            continue

        if "|" in line and i + 1 < len(lines) and is_table_separator(lines[i + 1]):
            header = parse_table_row(line)
            i += 2
            rows: list[list[str]] = []
            while i < len(lines):
                candidate = lines[i]
                if not candidate.strip() or "|" not in candidate:
                    break
                rows.append(parse_table_row(candidate))
                i += 1
            table_parts = ["<div class=\"table-wrap\"><table><thead><tr>"]
            for cell in header:
                table_parts.append(f"<th>{parse_inline(cell, file_anchor_map)}</th>")
            table_parts.append("</tr></thead><tbody>")
            for row in rows:
                table_parts.append("<tr>")
                for cell in row:
                    table_parts.append(f"<td>{parse_inline(cell, file_anchor_map)}</td>")
                table_parts.append("</tr>")
            table_parts.append("</tbody></table></div>")
            blocks.append("".join(table_parts))
            continue

        heading = re.match(r"^(#{1,6})\s+(.*)$", line)
        if heading:
            level = len(heading.group(1))
            raw_text = heading.group(2).strip()
            title = strip_inline_markdown(raw_text)
            if level == 1 and not doc.title:
                doc.title = title
            anchor = unique_anchor(f"{doc.anchor}-{slugify(title)}", seen_anchors)
            if level == 2:
                doc.top_sections.append(SectionLink(level=level, title=title, anchor=anchor))
            blocks.append(f'<h{level} id="{anchor}">{parse_inline(raw_text, file_anchor_map)}</h{level}>')
            i += 1
            continue

        if stripped == "---":
            blocks.append("<hr>")
            i += 1
            continue

        if stripped.startswith(">"):
            quote_lines: list[str] = []
            while i < len(lines):
                current = lines[i]
                if not current.strip():
                    quote_lines.append("")
                    i += 1
                    continue
                if not current.strip().startswith(">"):
                    break
                quote_lines.append(re.sub(r"^\s*>\s?", "", current))
                i += 1

            paragraphs: list[str] = []
            current_group: list[str] = []
            for quote_line in quote_lines:
                if quote_line == "":
                    if current_group:
                        paragraphs.append("<br>".join(parse_inline(item, file_anchor_map) for item in current_group))
                        current_group = []
                else:
                    current_group.append(quote_line)
            if current_group:
                paragraphs.append("<br>".join(parse_inline(item, file_anchor_map) for item in current_group))

            quote_html = "".join(f"<p>{paragraph}</p>" for paragraph in paragraphs)
            blocks.append(f"<blockquote>{quote_html}</blockquote>")
            continue

        task = task_match(line)
        listed = list_match(line)
        if task or listed:
            ordered = bool(listed and listed.group(2).endswith(".")) if listed else False
            items: list[tuple[str, str]] = []

            while i < len(lines):
                current = lines[i]
                if not current.strip():
                    break

                current_task = task_match(current)
                current_list = list_match(current)
                if current_task:
                    content = current_task.group(3).strip()
                    state = "checked" if current_task.group(2).lower() == "x" else "unchecked"
                    i += 1
                    continuation: list[str] = []
                    while i < len(lines):
                        follow = lines[i]
                        if not follow.strip():
                            break
                        if task_match(follow) or list_match(follow) or is_special_start(
                            follow, lines[i + 1] if i + 1 < len(lines) else None
                        ):
                            break
                        continuation.append(follow.strip())
                        i += 1
                    if continuation:
                        content += " " + " ".join(continuation)
                    items.append((state, content))
                    continue

                if current_list and not task_match(current):
                    current_ordered = current_list.group(2).endswith(".")
                    if current_ordered != ordered:
                        break
                    content = current_list.group(3).strip()
                    i += 1
                    continuation = []
                    while i < len(lines):
                        follow = lines[i]
                        if not follow.strip():
                            break
                        if task_match(follow) or list_match(follow) or is_special_start(
                            follow, lines[i + 1] if i + 1 < len(lines) else None
                        ):
                            break
                        continuation.append(follow.strip())
                        i += 1
                    if continuation:
                        content += " " + " ".join(continuation)
                    items.append(("plain", content))
                    continue

                break

            blocks.append(render_list(items, ordered=ordered, file_anchor_map=file_anchor_map))
            continue

        paragraph_lines = [line.strip()]
        i += 1
        while i < len(lines):
            next_line = lines[i]
            after = lines[i + 1] if i + 1 < len(lines) else None
            if is_special_start(next_line, after):
                break
            paragraph_lines.append(next_line.strip())
            i += 1

        paragraph = " ".join(part for part in paragraph_lines if part)
        if not doc.lead and not paragraph.startswith("製作日期"):
            doc.lead = strip_inline_markdown(paragraph)
        blocks.append(f"<p>{parse_inline(paragraph, file_anchor_map)}</p>")

    if not doc.title:
        doc.title = path.stem

    chapter_toc = ""
    if doc.top_sections:
        links = "".join(
            f'<a class="chapter-chip" href="#{section.anchor}">{html.escape(section.title)}</a>'
            for section in doc.top_sections
        )
        chapter_toc = (
            '<div class="chapter-toc"><div class="chapter-toc-label">本章導覽</div>'
            f'<div class="chapter-chip-row">{links}</div></div>'
        )

    doc.body_html = chapter_toc + "\n".join(blocks)
    return doc


def render_html(documents: list[Document]) -> str:
    manifest_html = []
    sidebar_html = []
    article_html = []
    total_sections = sum(len(document.top_sections) for document in documents)

    for index, document in enumerate(documents, start=1):
        lead = html.escape(document.lead[:120] + ("…" if len(document.lead) > 120 else ""))
        sections = "".join(
            f'<a href="#{section.anchor}" class="side-link side-link-section">{html.escape(section.title)}</a>'
            for section in document.top_sections
        )
        manifest_html.append(
            f'''
            <a class="manifest-row" href="#{document.anchor}">
              <span class="manifest-number">{index:02d}</span>
              <span class="manifest-content">
                <span class="manifest-file">{html.escape(document.filename.replace(".md", ""))}</span>
                <strong>{html.escape(document.title)}</strong>
                <span>{lead}</span>
              </span>
              <span class="manifest-tail">{len(document.top_sections)} 節</span>
            </a>
            '''
        )
        sidebar_html.append(
            f'''
            <section class="side-group">
              <a href="#{document.anchor}" class="side-link side-link-doc" data-doc-link="{document.anchor}">
                <span class="side-link-number">{index:02d}</span>
                <span>{html.escape(document.title)}</span>
              </a>
              <div class="side-subnav">{sections}</div>
            </section>
            '''
        )
        article_html.append(
            f'''
            <article class="chapter" id="{document.anchor}" data-doc-section>
              <header class="chapter-header">
                <div class="chapter-kicker">{html.escape(document.filename)}</div>
                <h2>{html.escape(document.title)}</h2>
                <p>{lead}</p>
              </header>
              <div class="chapter-body">
                {document.body_html}
              </div>
            </article>
            '''
        )

    return f"""<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>廣澤國貿業務完全學習手冊</title>
  <meta name="description" content="廣澤國貿業務完整學習手冊，整合公司、產業、國際貿易、情境模擬、談判與進階技能。">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%238b6446'/%3E%3Cpath d='M18 21h28v6H24v10h18v6H24v12h-6V21Z' fill='white'/%3E%3C/svg%3E">
  <style>
    :root {{
      --bg: #f6f3ee;
      --surface: #fbf9f5;
      --surface-soft: #f1ece4;
      --ink: #202020;
      --muted: #66625b;
      --accent: #8b6446;
      --accent-soft: rgba(139, 100, 70, 0.08);
      --line: rgba(32, 32, 32, 0.11);
      --line-strong: rgba(32, 32, 32, 0.18);
      --shadow: 0 18px 45px rgba(35, 24, 12, 0.06);
      --sidebar-width: 280px;
    }}

    * {{
      box-sizing: border-box;
    }}

    html {{
      scroll-behavior: smooth;
    }}

    body {{
      margin: 0;
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", "Helvetica Neue", Arial, sans-serif;
      line-height: 1.8;
      background: var(--bg);
      min-height: 100vh;
    }}

    a {{
      color: inherit;
      text-decoration: none;
    }}

    a:hover {{
      text-decoration: underline;
    }}

    .progress {{
      position: fixed;
      inset: 0 auto auto 0;
      width: 100%;
      height: 4px;
      background: transparent;
      z-index: 50;
    }}

    .progress-bar {{
      height: 100%;
      width: 0;
      background: linear-gradient(90deg, var(--accent), #c4a388);
      transition: width 0.15s linear;
    }}

    .app {{
      display: grid;
      grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
      gap: 24px;
      width: min(calc(100vw - 40px), 1440px);
      margin: 0 auto;
      padding: 20px 0 64px;
    }}

    .sidebar {{
      position: sticky;
      top: 20px;
      align-self: start;
      height: calc(100vh - 40px);
      padding: 26px 22px 22px;
      border: 1px solid var(--line);
      border-radius: 24px;
      background: rgba(251, 249, 245, 0.94);
      box-shadow: var(--shadow);
      overflow: auto;
    }}

    .sidebar h1 {{
      margin: 0;
      font-size: 1.32rem;
      line-height: 1.35;
      letter-spacing: -0.01em;
      font-weight: 700;
    }}

    .sidebar p {{
      margin: 12px 0 0;
      color: var(--muted);
      font-size: 0.92rem;
    }}

    .meta-row {{
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin: 18px 0 22px;
    }}

    .meta-pill {{
      display: inline-flex;
      align-items: center;
      padding: 7px 10px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: white;
      color: var(--muted);
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }}

    .search-box {{
      width: 100%;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: white;
      color: var(--ink);
      outline: none;
      font-size: 0.95rem;
    }}

    .search-box::placeholder {{
      color: #9a958d;
    }}

    .search-box:focus {{
      border-color: rgba(139, 100, 70, 0.35);
      box-shadow: 0 0 0 4px rgba(139, 100, 70, 0.08);
    }}

    .side-nav {{
      margin-top: 18px;
      display: grid;
      gap: 18px;
    }}

    .side-group {{
      padding-bottom: 14px;
      border-bottom: 1px solid var(--line);
    }}

    .side-group:last-child {{
      border-bottom: 0;
      padding-bottom: 0;
    }}

    .side-link {{
      display: block;
      padding: 8px 10px;
      border-radius: 14px;
      transition: background 0.2s ease, color 0.2s ease, transform 0.2s ease;
    }}

    .side-link:hover {{
      background: var(--accent-soft);
      transform: translateX(2px);
      text-decoration: none;
    }}

    .side-link-doc {{
      display: flex;
      gap: 10px;
      align-items: baseline;
      font-weight: 700;
      color: var(--ink);
      margin-bottom: 6px;
    }}

    .side-link-section {{
      color: var(--muted);
      font-size: 0.88rem;
      margin-left: 22px;
      line-height: 1.5;
    }}

    .side-link-number {{
      color: var(--accent);
      font-size: 0.74rem;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      min-width: 26px;
    }}

    .side-link.active {{
      background: var(--accent-soft);
      color: var(--ink);
    }}

    .main {{
      min-width: 0;
    }}

    .hero,
    .manifest,
    .chapter {{
      border: 1px solid var(--line);
      border-radius: 24px;
      background: var(--surface);
      box-shadow: var(--shadow);
    }}

    .hero {{
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr);
      gap: 28px;
      padding: 28px 32px 30px;
    }}

    .hero-brand {{
      display: inline-block;
      margin-bottom: 14px;
      color: var(--accent);
      font-weight: 700;
      letter-spacing: 0.18em;
      font-size: 0.76rem;
      text-transform: uppercase;
    }}

    .hero-mark {{
      margin: 0 0 10px;
      color: var(--muted);
      font-size: 0.92rem;
    }}

    .hero h2 {{
      margin: 0;
      font-size: clamp(2.1rem, 4.2vw, 3.5rem);
      line-height: 1.18;
      letter-spacing: -0.03em;
      font-weight: 700;
      max-width: 11ch;
    }}

    .hero-copy {{
      max-width: 40rem;
      margin: 16px 0 0;
      color: var(--muted);
      font-size: 1.02rem;
    }}

    .hero-actions {{
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 22px;
    }}

    .hero-link {{
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 44px;
      padding: 0 16px;
      border-radius: 999px;
      border: 1px solid var(--line-strong);
      color: var(--ink);
      font-weight: 600;
      transition: transform 0.2s ease, background 0.2s ease, color 0.2s ease;
    }}

    .hero-link:hover {{
      transform: translateY(-1px);
      text-decoration: none;
      background: var(--surface-soft);
    }}

    .hero-link.primary {{
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }}

    .hero-link.primary:hover {{
      background: #7b583d;
    }}

    .hero-aside {{
      padding-left: 24px;
      border-left: 1px solid var(--line);
    }}

    .hero-aside-label {{
      color: var(--accent);
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }}

    .hero-aside-list {{
      display: grid;
      gap: 14px;
      margin-top: 16px;
    }}

    .hero-aside-item {{
      display: grid;
      gap: 4px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--line);
    }}

    .hero-aside-item:last-child {{
      border-bottom: 0;
      padding-bottom: 0;
    }}

    .hero-aside-item strong {{
      font-size: 0.94rem;
      letter-spacing: 0.02em;
    }}

    .hero-aside-item span {{
      color: var(--muted);
      font-size: 0.92rem;
      line-height: 1.55;
    }}

    .hero-footer {{
      display: flex;
      flex-wrap: wrap;
      gap: 12px 24px;
      margin-top: 28px;
      padding-top: 18px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 0.9rem;
    }}

    .hero-footer strong {{
      display: block;
      color: var(--ink);
      font-size: 0.98rem;
      margin-bottom: 2px;
    }}

    .manifest {{
      margin-top: 28px;
      padding: 30px 32px;
    }}

    .manifest-intro {{
      margin-bottom: 18px;
    }}

    .manifest-label {{
      margin: 0 0 8px;
      color: var(--accent);
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }}

    .manifest-intro h3 {{
      margin: 0;
      font-size: clamp(1.5rem, 3vw, 2.15rem);
      line-height: 1.35;
      letter-spacing: -0.02em;
      font-weight: 700;
    }}

    .manifest-intro p:last-child {{
      margin: 10px 0 0;
      max-width: 44rem;
      color: var(--muted);
    }}

    .manifest-list {{
      border-top: 1px solid var(--line);
    }}

    .manifest-row {{
      display: grid;
      grid-template-columns: 54px minmax(0, 1fr) auto;
      gap: 18px;
      align-items: start;
      padding: 18px 0;
      border-bottom: 1px solid var(--line);
      transition: transform 0.2s ease;
    }}

    .manifest-row:hover {{
      transform: translateX(3px);
      text-decoration: none;
    }}

    .manifest-number {{
      color: rgba(139, 100, 70, 0.65);
      font-size: 1.1rem;
      font-weight: 700;
      line-height: 1.5;
    }}

    .manifest-content {{
      display: grid;
      gap: 4px;
    }}

    .manifest-file {{
      color: var(--accent);
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }}

    .manifest-content strong {{
      font-size: 1.06rem;
      line-height: 1.5;
      font-weight: 700;
    }}

    .manifest-content span:last-child {{
      color: var(--muted);
      font-size: 0.92rem;
    }}

    .manifest-tail {{
      color: var(--muted);
      font-size: 0.82rem;
      font-weight: 700;
      white-space: nowrap;
      padding-top: 4px;
    }}

    .chapters {{
      display: grid;
      gap: 32px;
      margin-top: 32px;
    }}

    .chapter {{
      padding: 30px 32px 38px;
      scroll-margin-top: 24px;
    }}

    .chapter-header {{
      width: min(100%, 880px);
      margin-bottom: 24px;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--line);
    }}

    .chapter-kicker {{
      color: var(--accent);
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }}

    .chapter-header h2 {{
      margin: 8px 0 8px;
      font-size: clamp(1.8rem, 3vw, 2.45rem);
      line-height: 1.3;
      letter-spacing: -0.02em;
      font-weight: 700;
    }}

    .chapter-header p {{
      margin: 0;
      color: var(--muted);
      max-width: 44rem;
      font-size: 0.98rem;
    }}

    .chapter-body {{
      width: min(100%, 860px);
    }}

    .chapter-body > h1:first-of-type {{
      display: none;
    }}

    .chapter-toc {{
      margin-bottom: 28px;
      padding: 18px 0;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }}

    .chapter-toc-label {{
      margin-bottom: 12px;
      color: var(--accent);
      font-weight: 700;
      font-size: 0.84rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }}

    .chapter-chip-row {{
      display: flex;
      flex-wrap: wrap;
      gap: 10px 14px;
    }}

    .chapter-chip {{
      color: var(--ink);
      font-size: 0.92rem;
      font-weight: 600;
      padding-bottom: 2px;
      border-bottom: 1px solid rgba(32, 32, 32, 0.16);
    }}

    .chapter-chip:hover {{
      text-decoration: none;
      border-color: var(--accent);
    }}

    .chapter-body h1,
    .chapter-body h2,
    .chapter-body h3,
    .chapter-body h4 {{
      line-height: 1.45;
      margin: 1.6em 0 0.65em;
      scroll-margin-top: 24px;
      letter-spacing: -0.01em;
      font-weight: 700;
    }}

    .chapter-body h1 {{
      font-size: 2rem;
      margin-top: 0;
    }}

    .chapter-body h2 {{
      font-size: 1.45rem;
      padding-top: 4px;
    }}

    .chapter-body h3 {{
      font-size: 1.18rem;
      color: var(--ink);
    }}

    .chapter-body h4 {{
      font-size: 1.02rem;
      color: var(--muted);
    }}

    .chapter-body p {{
      margin: 0 0 1em;
      max-width: 72ch;
    }}

    .chapter-body ul,
    .chapter-body ol {{
      margin: 0 0 1.2em 1.2em;
      padding-left: 1.1em;
      max-width: 72ch;
    }}

    .chapter-body li {{
      margin: 0.32em 0;
    }}

    .task-list {{
      list-style: none;
      margin-left: 0;
      padding-left: 0;
    }}

    .task-item {{
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }}

    .task-box {{
      width: 18px;
      height: 18px;
      border-radius: 5px;
      border: 1.5px solid rgba(32, 32, 32, 0.24);
      margin-top: 6px;
      background: white;
      flex: 0 0 auto;
    }}

    .task-box.is-checked {{
      background: linear-gradient(135deg, var(--accent), #c4a388);
      border-color: transparent;
      box-shadow: inset 0 0 0 4px rgba(255, 255, 255, 0.88);
    }}

    .chapter-body blockquote {{
      margin: 1.4em 0;
      padding: 16px 18px 16px 20px;
      border-left: 3px solid rgba(139, 100, 70, 0.35);
      border-radius: 0 12px 12px 0;
      background: var(--surface-soft);
      color: #2c2a26;
      max-width: 72ch;
    }}

    .chapter-body blockquote p:last-child {{
      margin-bottom: 0;
    }}

    .chapter-body code {{
      padding: 0.15em 0.42em;
      border-radius: 8px;
      background: rgba(32, 32, 32, 0.08);
      font-family: "SFMono-Regular", "Consolas", "Liberation Mono", monospace;
      font-size: 0.92em;
    }}

    .chapter-body pre {{
      margin: 1.5em 0;
      padding: 18px 20px;
      overflow: auto;
      border-radius: 16px;
      background: #1a2521;
      color: #edf4f4;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }}

    .chapter-body pre code {{
      padding: 0;
      background: transparent;
      color: inherit;
      font-size: 0.9rem;
    }}

    .chapter-body hr {{
      border: 0;
      border-top: 1px solid var(--line);
      margin: 2em 0;
    }}

    .table-wrap {{
      overflow-x: auto;
      margin: 1.5em 0;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: white;
    }}

    table {{
      width: 100%;
      border-collapse: collapse;
      min-width: 620px;
    }}

    th,
    td {{
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }}

    th {{
      background: #f6f1ea;
      color: var(--ink);
      font-weight: 700;
    }}

    tbody tr:nth-child(2n) td {{
      background: #fcfbf8;
    }}

    .mobile-bar {{
      display: none;
      position: sticky;
      top: 0;
      z-index: 40;
      padding: 14px 18px;
      background: rgba(246, 243, 238, 0.94);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--line);
    }}

    .mobile-toggle {{
      border: 0;
      border-radius: 999px;
      padding: 10px 14px;
      background: rgba(139, 100, 70, 0.1);
      color: var(--accent);
      font-weight: 700;
      cursor: pointer;
    }}

    .to-top {{
      position: fixed;
      right: 22px;
      bottom: 22px;
      width: 48px;
      height: 48px;
      border: 0;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--accent), #c4a388);
      color: white;
      font-size: 1.2rem;
      box-shadow: 0 16px 28px rgba(26, 43, 50, 0.2);
      cursor: pointer;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease, transform 0.2s ease;
      transform: translateY(8px);
    }}

    .to-top.show {{
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0);
    }}

    @media (max-width: 1080px) {{
      .app {{
        grid-template-columns: minmax(0, 1fr);
        width: min(100vw, calc(100vw - 24px));
        gap: 18px;
        padding-top: 12px;
      }}

      .mobile-bar {{
        display: flex;
        justify-content: flex-start;
      }}

      .sidebar {{
        position: fixed;
        top: 0;
        left: 0;
        bottom: 0;
        width: min(90vw, 360px);
        height: 100vh;
        border-radius: 0 24px 24px 0;
        transform: translateX(-102%);
        transition: transform 0.25s ease;
        z-index: 45;
      }}

      body.nav-open .sidebar {{
        transform: translateX(0);
      }}

      .hero {{
        grid-template-columns: 1fr;
      }}

      .hero-aside {{
        padding-left: 0;
        padding-top: 20px;
        border-left: 0;
        border-top: 1px solid var(--line);
      }}
    }}

    @media (max-width: 720px) {{
      .hero,
      .manifest,
      .chapter {{
        padding: 22px 20px 24px;
      }}

      .hero h2 {{
        max-width: none;
      }}

      .hero-footer {{
        gap: 10px 16px;
      }}

      .manifest-row {{
        grid-template-columns: 48px minmax(0, 1fr);
      }}

      .manifest-tail {{
        grid-column: 2;
        padding-top: 0;
      }}

      .chapter-body h1 {{
        font-size: 1.65rem;
      }}

      table {{
        min-width: 520px;
      }}
    }}
  </style>
</head>
<body>
  <div class="progress"><div class="progress-bar" id="progressBar"></div></div>
  <div class="mobile-bar">
    <button class="mobile-toggle" id="mobileToggle" type="button">章節導覽</button>
  </div>
  <div class="app">
    <aside class="sidebar" id="sidebar">
      <h1>廣澤國貿業務完全學習手冊</h1>
      <p>把公司背景、國貿基礎、情境題與談判文化整理成一份可以穩定閱讀的訓練教材。</p>
      <div class="meta-row">
        <span class="meta-pill">9 份文件</span>
        <span class="meta-pill">520+ 情境題</span>
        <span class="meta-pill">{total_sections} 個主節點</span>
      </div>
      <input id="navSearch" class="search-box" type="search" placeholder="搜尋章節或主題">
      <nav class="side-nav" id="sideNav">
        {''.join(sidebar_html)}
      </nav>
    </aside>
    <main class="main">
      <section class="hero">
        <div class="hero-panel">
          <div class="hero-mark">Dongguan Hirosawa Automotive Trim Parts Co., Ltd.</div>
          <span class="hero-brand">Trade Guide 2026</span>
          <h2>廣澤國貿業務完全學習手冊</h2>
          <p class="hero-copy">從公司與產業背景、Incoterms、付款條款，到 520+ 個情境題與各國談判文化，這份教材把新人第一階段最需要的內容整理在同一個閱讀入口。</p>
          <div class="hero-actions">
            <a class="hero-link primary" href="#guide-map">開始閱讀</a>
            <a class="hero-link" href="#doc-00-00-index">先看索引</a>
          </div>
          <div class="hero-footer">
            <span><strong>閱讀順序</strong>先基礎、再情境、最後談判與進階技能</span>
            <span><strong>使用情境</strong>新人訓練、主管內訓、快速查閱</span>
          </div>
        </div>
        <div class="hero-aside">
          <div>
            <div class="hero-aside-label">Reading Plan</div>
            <div class="hero-aside-list">
              <div class="hero-aside-item">
                <strong>Week 1</strong>
                <span>先吃透公司、產業和國貿條款，建立共同語言。</span>
              </div>
              <div class="hero-aside-item">
                <strong>Week 2</strong>
                <span>用 Part 1 到 Part 4 情境題做高頻實戰反應訓練。</span>
              </div>
              <div class="hero-aside-item">
                <strong>Week 3+</strong>
                <span>補談判、文化與業績管理，變成能獨立上場的業務。</span>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section class="manifest" id="guide-map">
        <div class="manifest-intro">
          <p class="manifest-label">Guide Map</p>
          <h3>九份文件，按閱讀順序排好。</h3>
          <p>這裡先給你清楚入口，再往下進入完整正文。每一份都能獨立讀，但照順序效果最好。</p>
        </div>
        <div class="manifest-list">
          {''.join(manifest_html)}
        </div>
      </section>
      <section class="chapters">
        {''.join(article_html)}
      </section>
    </main>
  </div>
  <button class="to-top" id="toTop" type="button" aria-label="回到頂部">↑</button>
  <script>
    const progressBar = document.getElementById('progressBar');
    const toTop = document.getElementById('toTop');
    const mobileToggle = document.getElementById('mobileToggle');
    const sidebar = document.getElementById('sidebar');
    const searchInput = document.getElementById('navSearch');
    const docSections = [...document.querySelectorAll('[data-doc-section]')];
    const docLinks = [...document.querySelectorAll('[data-doc-link]')];

    function updateProgress() {{
      const scrollTop = window.scrollY;
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      const width = maxScroll > 0 ? (scrollTop / maxScroll) * 100 : 0;
      progressBar.style.width = `${{width}}%`;
      toTop.classList.toggle('show', scrollTop > 640);
    }}

    updateProgress();
    window.addEventListener('scroll', updateProgress, {{ passive: true }});
    window.addEventListener('resize', updateProgress);

    toTop.addEventListener('click', () => {{
      window.scrollTo({{ top: 0, behavior: 'smooth' }});
    }});

    mobileToggle.addEventListener('click', () => {{
      document.body.classList.toggle('nav-open');
    }});

    document.addEventListener('click', (event) => {{
      if (window.innerWidth > 1080) return;
      if (sidebar.contains(event.target) || mobileToggle.contains(event.target)) return;
      document.body.classList.remove('nav-open');
    }});

    document.querySelectorAll('.side-link, .manifest-row').forEach(link => {{
      link.addEventListener('click', () => document.body.classList.remove('nav-open'));
    }});

    const observer = new IntersectionObserver((entries) => {{
      const visible = entries
        .filter(entry => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      const id = visible.target.id;
      docLinks.forEach(link => {{
        link.classList.toggle('active', link.dataset.docLink === id);
      }});
    }}, {{
      rootMargin: '-20% 0px -60% 0px',
      threshold: [0.2, 0.4, 0.6]
    }});

    docSections.forEach(section => observer.observe(section));

    searchInput.addEventListener('input', () => {{
      const query = searchInput.value.trim().toLowerCase();
      document.querySelectorAll('.side-group').forEach(group => {{
        const text = group.textContent.toLowerCase();
        group.style.display = !query || text.includes(query) ? '' : 'none';
      }});
    }});
  </script>
</body>
</html>
"""


def main() -> None:
    file_anchor_map = {
        filename: f"doc-{index:02d}-{Path(filename).stem.lower().replace('_', '-').replace(' ', '-')}"
        for index, filename in enumerate(SOURCE_FILES)
    }
    documents = [parse_document(SOURCE_DIR / filename, file_anchor_map) for filename in SOURCE_FILES]
    OUTPUT_FILE.write_text(render_html(documents), encoding="utf-8")
    print(f"Generated {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
