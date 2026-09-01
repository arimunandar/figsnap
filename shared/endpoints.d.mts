export type Field = { name: string; type: string; note: string }

export type Endpoint = {
  id: string
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  summary: string
  auth: 'none' | 'optional' | 'required'
  authNote?: string
  params?: { name: string; note: string }[]
  query?: { name: string; note: string }[]
  body?: { fields: Field[]; examples: { label: string; value: unknown }[] }
  response?: unknown
  responseNote?: string
  binary?: boolean
  stream?: boolean
}

export type EndpointGroup = { id: string; title: string; note: string; endpoints: Endpoint[] }

export const groups: EndpointGroup[]
export function allEndpoints(): Endpoint[]
export function endpointTableRows(): string[][]
export function requestHeaders(endpoint: Endpoint): string[]
export function curlFor(
  endpoint: Endpoint,
  context: { base: string; path: string; body: string; token: string },
): string
