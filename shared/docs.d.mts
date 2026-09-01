export type DocsContext = {
  httpBase: string
  relayState: string
  nodeId: string
  surface?: 'http' | 'public'
}

export type DocsBlock =
  | { type: 'lead' | 'p' | 'h3'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'code'; text: string }
  | { type: 'table'; head: string[]; rows: string[][] }

export type DocsSection = { heading: string; blocks: DocsBlock[] }

export function docsSections(context: DocsContext): DocsSection[]
export function renderDocsHtml(context: DocsContext): string
export function renderDocsMarkdown(context: DocsContext): string
