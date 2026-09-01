// Small syntax highlighter for the two languages this plugin emits.
//
// Bundling a general highlighter would add tens of kilobytes to an inlined
// single-file UI for no gain: the input is always output from this plugin's own
// generators, so a short ordered rule list covers it. Lines are highlighted
// independently, which keeps the line gutter trivially in sync.

type Grammar = { pattern: RegExp; names: string[] }

function grammar(rules: [string, string][]): Grammar {
  return {
    pattern: new RegExp(rules.map(([, source]) => `(${source})`).join('|'), 'g'),
    names: rules.map(([name]) => name),
  }
}

const TSX = grammar([
  ['comment', '//[^\\n]*|/\\*[\\s\\S]*?\\*/'],
  ['string', "'(?:[^'\\\\\\n]|\\\\.)*'|\"(?:[^\"\\\\\\n]|\\\\.)*\"|`(?:[^`\\\\]|\\\\.)*`"],
  ['tag', '</?[A-Za-z][\\w.]*|/?>'],
  ['keyword', '\\b(?:import|export|from|function|return|type|const|let|true|false|null|undefined)\\b'],
  ['attr', '\\b[a-zA-Z][\\w-]*(?=\\s*=)'],
  ['number', '\\b\\d+(?:\\.\\d+)?\\b'],
])

const CSS = grammar([
  ['comment', '/\\*[\\s\\S]*?\\*/'],
  ['atrule', '@[\\w-]+'],
  // Anchored to the line start so a hex colour mid-declaration is not a selector.
  ['selector', '^\\s*[.#][A-Za-z_][\\w-]*'],
  ['variable', '--[\\w-]+'],
  ['prop', '[a-z-]+(?=\\s*:)'],
  ['string', "'(?:[^'\\\\]|\\\\.)*'|\"(?:[^\"\\\\]|\\\\.)*\""],
  ['number', '#[0-9a-fA-F]{3,8}\\b|\\b\\d+(?:\\.\\d+)?(?:px|rem|em|%|s|ms|deg|fr|vh|vw)?\\b'],
])

// Markup plus an embedded stylesheet, which is what the html output is. The CSS
// rules are picked up by the prop and number patterns rather than a second pass.
const HTML = grammar([
  ['comment', '<!--[\\s\\S]*?-->|/\\*[\\s\\S]*?\\*/'],
  ['string', '"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\''],
  ['tag', '</?[A-Za-z][\\w:-]*|/?>'],
  ['attr', '\\b[a-zA-Z][\\w:-]*(?=\\s*=)'],
  ['prop', '[a-z-]+(?=\\s*:)'],
  ['number', '#[0-9a-fA-F]{3,8}\\b|\\b\\d+(?:\\.\\d+)?(?:px|rem|em|%|s|ms|deg|fr|vh|vw)?\\b'],
])

const SHELL = grammar([
  ['comment', '#[^\\n]*'],
  ['string', "'(?:[^'\\\\]|\\\\.)*'|\"(?:[^\"\\\\]|\\\\.)*\""],
  ['keyword', '^\\s*(?:curl|npm|open|export)\\b'],
  ['attr', '\\s-{1,2}[A-Za-z][\\w-]*'],
  ['tag', '\\b(?:GET|POST|DELETE)\\b'],
  ['selector', 'https?://[^\\s]+|/[a-z][\\w/:.-]*'],
])

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) => ESCAPES[char])
}

function highlightLine(line: string, { pattern, names }: Grammar): string {
  let html = ''
  let cursor = 0
  pattern.lastIndex = 0

  let match = pattern.exec(line)
  while (match) {
    html += escapeHtml(line.slice(cursor, match.index))
    // Group 1..n map one-to-one onto the rule names.
    let name = 'plain'
    for (let group = 1; group <= names.length; group++) {
      if (match[group] !== undefined) {
        name = names[group - 1]
        break
      }
    }
    html += `<span class="t-${name}">${escapeHtml(match[0])}</span>`
    cursor = match.index + match[0].length
    match = pattern.exec(line)
  }

  return html + escapeHtml(line.slice(cursor))
}

export function highlightLines(code: string, language: 'tsx' | 'css' | 'html' | 'shell'): string[] {
  const rules =
    language === 'tsx' ? TSX : language === 'html' ? HTML : language === 'shell' ? SHELL : CSS
  return code.split('\n').map((line) => highlightLine(line, rules))
}
