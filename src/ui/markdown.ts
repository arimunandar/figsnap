// The subset of Markdown a coding agent actually writes.
//
// Agents answer in Markdown — headings, bullets, `code`, **emphasis**, fenced
// blocks, the occasional table — and rendering that as plain text turns a
// readable answer into a wall of asterisks. This is deliberately small: no
// dependency, no HTML passthrough, and every node built rather than assigned as
// a string, so nothing a model writes can become markup.
//
// The one exception is a fenced code block, which is handed to the panel's own
// highlighter — the same one the code column uses, which escapes as it goes.

import { highlightLines } from './highlight'

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; language: string; lines: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: { text: string; depth: number }[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'rule' }

const FENCE = /^\s*(```|~~~)(.*)$/
const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const NUMBER = /^(\s*)\d+[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const RULE = /^\s*([-*_])\s*(\1\s*){2,}$/
const TABLE_ROW = /^\s*\|(.+)\|\s*$/
const TABLE_RULE = /^\s*\|?[\s:|-]+\|[\s:|-]*$/

function cells(line: string): string[] {
  const match = TABLE_ROW.exec(line)
  return (match === null ? line : match[1]).split('|').map((cell) => cell.trim())
}

/** Groups lines into blocks. Fences win over everything, since they quote it. */
function parse(source: string): Block[] {
  const lines = source.split('\n')
  const blocks: Block[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    const fence = FENCE.exec(line)
    if (fence !== null) {
      const marker = fence[1]
      const language = fence[2].trim().toLowerCase()
      const body: string[] = []
      index += 1
      while (index < lines.length && lines[index].replace(/^\s+/, '').indexOf(marker) !== 0) {
        body.push(lines[index])
        index += 1
      }
      // An unclosed fence is what a half-streamed answer looks like, so it is
      // rendered as a block rather than held back until the closing marker.
      index += 1
      blocks.push({ kind: 'code', language, lines: body })
      continue
    }

    if (line.trim() === '') {
      index += 1
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      index += 1
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      index += 1
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (index < lines.length && QUOTE.test(lines[index])) {
        body.push(QUOTE.exec(lines[index])![1])
        index += 1
      }
      blocks.push({ kind: 'quote', lines: body })
      continue
    }

    if (TABLE_ROW.test(line) && index + 1 < lines.length && TABLE_RULE.test(lines[index + 1])) {
      const header = cells(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && TABLE_ROW.test(lines[index])) {
        rows.push(cells(lines[index]))
        index += 1
      }
      blocks.push({ kind: 'table', header, rows })
      continue
    }

    if (BULLET.test(line) || NUMBER.test(line)) {
      const ordered = NUMBER.test(line)
      const items: { text: string; depth: number }[] = []
      while (index < lines.length) {
        const match = (ordered ? NUMBER : BULLET).exec(lines[index]) ?? BULLET.exec(lines[index]) ?? NUMBER.exec(lines[index])
        if (match === null) {
          // A wrapped line belongs to the item above it, not to a new one.
          if (items.length > 0 && lines[index].trim() !== '' && !HEADING.test(lines[index]) && FENCE.exec(lines[index]) === null) {
            items[items.length - 1].text += ` ${lines[index].trim()}`
            index += 1
            continue
          }
          break
        }
        items.push({ text: match[2], depth: Math.min(2, Math.floor(match[1].length / 2)) })
        index += 1
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    const body: string[] = []
    while (
      index < lines.length &&
      lines[index].trim() !== '' &&
      !BULLET.test(lines[index]) &&
      !NUMBER.test(lines[index]) &&
      !HEADING.test(lines[index]) &&
      !QUOTE.test(lines[index]) &&
      FENCE.exec(lines[index]) === null
    ) {
      body.push(lines[index])
      index += 1
    }
    if (body.length === 0) {
      index += 1
      continue
    }
    blocks.push({ kind: 'paragraph', text: body.join('\n') })
  }

  return blocks
}

/**
 * Base64 has no business being read.
 *
 * A model handed an image sometimes writes it back out, and an adapter
 * stringifying a tool result will inline the whole thing. Either way it is tens
 * of kilobytes of noise in a 400px column. A data URI for an image becomes the
 * image; anything else long enough to be a payload is named and folded away.
 */
const DATA_IMAGE = /data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+/gi
const LONG_BASE64 = /[A-Za-z0-9+/]{512,}={0,2}/g

export function scrubBase64(text: string): string {
  return text
    .replace(DATA_IMAGE, (match) => `[image, ${Math.round((match.length * 3) / 4 / 1024)} kB]`)
    .replace(LONG_BASE64, (match) => `[${Math.round((match.length * 3) / 4 / 1024)} kB of base64]`)
}

/** A lone data URI, when the whole of something is one. */
export function loneDataImage(text: string): string | null {
  const trimmed = text.trim()
  return /^data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+$/i.test(trimmed) ? trimmed : null
}

const INLINE = /(`+)([\s\S]*?)\1|!?\[([^\]]*)\]\((data:[^)\s]+|[^)\s]+)\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|(?<![\w*])\*([^*\n]+)\*(?![\w*])|~~([\s\S]+?)~~/

/** Emphasis, code spans and links, into real nodes rather than markup. */
function inline(text: string, into: Node) {
  let rest = text
  for (;;) {
    const match = INLINE.exec(rest)
    if (match === null || match.index === undefined) break
    if (match.index > 0) into.appendChild(document.createTextNode(scrubBase64(rest.slice(0, match.index))))

    if (match[2] !== undefined) {
      const code = document.createElement('code')
      code.textContent = scrubBase64(match[2].trim())
      into.appendChild(code)
    } else if (match[4] !== undefined) {
      const isImage = match[0].startsWith('!')
      const target = match[4]
      // A picture is shown; a link is only followed when it is http(s), because
      // a model writing javascript: into one should not get a live link.
      if (isImage && /^data:image\/|^https?:\/\//i.test(target)) {
        const image = document.createElement('img')
        image.className = 'md-image'
        image.src = target
        image.alt = match[3] ?? ''
        image.addEventListener('error', () => image.remove())
        into.appendChild(image)
      } else if (!isImage && /^https?:\/\//i.test(target)) {
        const link = document.createElement('a')
        link.href = target
        link.setAttribute('target', '_blank')
        link.setAttribute('rel', 'noreferrer')
        inline(match[3] ?? target, link)
        into.appendChild(link)
      } else {
        into.appendChild(document.createTextNode(scrubBase64(match[3] ?? '')))
      }
    } else if (match[5] !== undefined || match[6] !== undefined) {
      const strong = document.createElement('strong')
      inline(match[5] ?? match[6], strong)
      into.appendChild(strong)
    } else if (match[7] !== undefined) {
      const em = document.createElement('em')
      inline(match[7], em)
      into.appendChild(em)
    } else if (match[8] !== undefined) {
      const del = document.createElement('del')
      inline(match[8], del)
      into.appendChild(del)
    }

    rest = rest.slice(match.index + match[0].length)
  }
  if (rest !== '') into.appendChild(document.createTextNode(scrubBase64(rest)))
}

/** What the panel's own highlighter can read, and what a fence usually says. */
const DIALECTS: Record<string, 'tsx' | 'html' | 'css'> = {
  tsx: 'tsx',
  jsx: 'tsx',
  ts: 'tsx',
  typescript: 'tsx',
  js: 'tsx',
  javascript: 'tsx',
  json: 'tsx',
  html: 'html',
  xml: 'html',
  svg: 'html',
  vue: 'html',
  css: 'css',
  scss: 'css',
  less: 'css',
}

const LANGUAGE_NAMES: Record<string, string> = {
  tsx: 'TSX',
  jsx: 'JSX',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  js: 'JavaScript',
  javascript: 'JavaScript',
  json: 'JSON',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  shell: 'Shell',
  md: 'Markdown',
  py: 'Python',
  python: 'Python',
  swift: 'Swift',
  kotlin: 'Kotlin',
}

/**
 * A code block, with the two things anyone wants from one: to know what it is,
 * and to take it away. The copy button carries no text of its own — the click
 * is delegated and reads the block beside it — so the markup stays a fragment
 * this module can build without knowing about the clipboard.
 */
function codeBlock(language: string, lines: string[]): HTMLElement {
  const body = lines.join('\n')
  const block = document.createElement('div')
  block.className = 'md-code-block'

  const head = document.createElement('div')
  head.className = 'md-code-head'
  const label = document.createElement('span')
  label.className = 'md-code-language'
  label.textContent = LANGUAGE_NAMES[language] ?? (language === '' ? 'Code' : language)
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'md-copy'
  copy.textContent = 'Copy'
  copy.title = 'Copy this block'
  head.append(label, copy)

  const pre = document.createElement('pre')
  pre.className = 'md-code'
  const code = document.createElement('code')
  const dialect = DIALECTS[language] ?? null
  if (dialect === null) {
    code.textContent = scrubBase64(body)
  } else {
    // Already escaped by the highlighter; only its own spans are markup.
    code.innerHTML = highlightLines(body, dialect).join('\n')
  }
  pre.appendChild(code)

  block.append(head, pre)
  return block
}

/** The rendered answer, as a fragment ready to drop into the transcript. */
export function renderMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment()

  for (const block of parse(source)) {
    if (block.kind === 'rule') {
      fragment.appendChild(document.createElement('hr'))
      continue
    }
    if (block.kind === 'heading') {
      const heading = document.createElement(`h${Math.min(4, block.level + 2)}`)
      heading.className = 'md-heading'
      inline(block.text, heading)
      fragment.appendChild(heading)
      continue
    }
    if (block.kind === 'code') {
      fragment.appendChild(codeBlock(block.language, block.lines))
      continue
    }
    if (block.kind === 'quote') {
      const quote = document.createElement('blockquote')
      quote.className = 'md-quote'
      inline(block.lines.join('\n'), quote)
      fragment.appendChild(quote)
      continue
    }
    if (block.kind === 'list') {
      const list = document.createElement(block.ordered ? 'ol' : 'ul')
      list.className = 'md-list'
      for (const item of block.items) {
        const entry = document.createElement('li')
        if (item.depth > 0) entry.style.marginLeft = `${item.depth * 12}px`
        inline(item.text, entry)
        list.appendChild(entry)
      }
      fragment.appendChild(list)
      continue
    }
    if (block.kind === 'table') {
      const wrap = document.createElement('div')
      wrap.className = 'md-table-wrap'
      const table = document.createElement('table')
      table.className = 'md-table'
      const head = document.createElement('tr')
      for (const cell of block.header) {
        const th = document.createElement('th')
        inline(cell, th)
        head.appendChild(th)
      }
      table.appendChild(head)
      for (const row of block.rows) {
        const tr = document.createElement('tr')
        for (const cell of row) {
          const td = document.createElement('td')
          inline(cell, td)
          tr.appendChild(td)
        }
        table.appendChild(tr)
      }
      wrap.appendChild(table)
      fragment.appendChild(wrap)
      continue
    }

    const paragraph = document.createElement('p')
    paragraph.className = 'md-p'
    inline(block.text, paragraph)
    fragment.appendChild(paragraph)
  }

  return fragment
}
