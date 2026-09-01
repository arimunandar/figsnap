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

const INLINE = /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|(?<![\w*])\*([^*\n]+)\*(?![\w*])|~~([\s\S]+?)~~|\[([^\]]+)\]\(([^)\s]+)\)/

/** Emphasis, code spans and links, into real nodes rather than markup. */
function inline(text: string, into: Node) {
  let rest = text
  for (;;) {
    const match = INLINE.exec(rest)
    if (match === null || match.index === undefined) break
    if (match.index > 0) into.appendChild(document.createTextNode(rest.slice(0, match.index)))

    if (match[2] !== undefined) {
      const code = document.createElement('code')
      code.textContent = match[2].trim()
      into.appendChild(code)
    } else if (match[3] !== undefined || match[4] !== undefined) {
      const strong = document.createElement('strong')
      inline(match[3] ?? match[4], strong)
      into.appendChild(strong)
    } else if (match[5] !== undefined) {
      const em = document.createElement('em')
      inline(match[5], em)
      into.appendChild(em)
    } else if (match[6] !== undefined) {
      const del = document.createElement('del')
      inline(match[6], del)
      into.appendChild(del)
    } else if (match[7] !== undefined) {
      // Only http(s): a model writing javascript: into a link should not get one.
      const safe = /^https?:\/\//i.test(match[8])
      const node = document.createElement(safe ? 'a' : 'span')
      if (safe) {
        ;(node as HTMLAnchorElement).href = match[8]
        node.setAttribute('target', '_blank')
        node.setAttribute('rel', 'noreferrer')
      }
      inline(match[7], node)
      into.appendChild(node)
    }

    rest = rest.slice(match.index + match[0].length)
  }
  if (rest !== '') into.appendChild(document.createTextNode(rest))
}

function codeBlock(language: string, lines: string[]): HTMLElement {
  const pre = document.createElement('pre')
  pre.className = 'md-code'
  const code = document.createElement('code')
  const known = ['tsx', 'ts', 'jsx', 'js', 'javascript', 'typescript'].indexOf(language) !== -1
  const dialect = known ? 'tsx' : language === 'html' ? 'html' : language === 'css' ? 'css' : null
  if (dialect === null) {
    code.textContent = lines.join('\n')
  } else {
    // Already escaped by the highlighter; only its own spans are markup.
    code.innerHTML = highlightLines(lines.join('\n'), dialect).join('\n')
  }
  pre.appendChild(code)
  return pre
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
