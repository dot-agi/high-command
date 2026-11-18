import type { PeerReport } from './envelope'
import { parseListing, parseStructuredListing } from './listing'

/**
 * Tool calls as the conversation's rows carry them, and their stored results. Pure: no `$`, no clock.
 *
 * A finished call reaches High Command as two `session.append` rows: the response row with its tool_use block (the
 * tool's input), then the result row with its tool_result block (what the model read). A call inside a Code Mode
 * script that succeeded gives an empty result row, and the transcript stores no result for it.
 */

/** The tools whose calls High Command records. */
export const ROW_TOOLS: ReadonlySet<string> = new Set(['SendMessage', 'ListAgents'])

/** The tool whose result rows start a local agent. */
export const SPAWN_TOOL = 'Agent'

type Fields = Record<string, unknown>

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One finished SendMessage or ListAgents call. */
export type RowCall = {
  toolUseId: string
  toolName: string
  /** What the model read, from the result row as kept: '' for a call inside a Code Mode script that succeeded. */
  text: string
  isError: boolean
  /** The arguments the model gave, from the call's response row. */
  input?: Fields
  /** The tool's structured record from `$.session.messages()`, when the transcript held one. */
  result?: unknown
  /** The local agent whose conversation holds the call; absent in the main conversation. */
  agentId?: string
  /** The conversation whose inbox the call goes to. */
  sessionId: string
  /** `$.clock.now()` at the call's result row: the time a send's entry shows, and the time of a listing's states. */
  at?: number
}

/** The text of a tool_result block's content: a string, or its text blocks joined with newlines. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => (isFields(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n')
}

/** The tool_use blocks of a response row. */
export function toolUsesOf(content: unknown): { id: string; name: string; input: Fields }[] {
  if (!Array.isArray(content)) return []
  return content.flatMap(block =>
    isFields(block) && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string'
      ? [{ id: block.id, name: block.name, input: isFields(block.input) ? block.input : {} }]
      : [],
  )
}

/** The tool_result blocks of a result row. */
export function toolResultsOf(content: unknown): { id: string; text: string; isError: boolean }[] {
  if (!Array.isArray(content)) return []
  return content.flatMap(block =>
    isFields(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string'
      ? [{ id: block.tool_use_id, text: contentText(block.content), isError: block.is_error === true }]
      : [],
  )
}

/** What `$.session.messages()` holds for one call: its input, and its result once the transcript stored one. */
export type Summary = { input?: Fields; result?: Fields; isAnswered: boolean }

/**
 * The calls named in `wanted`, from what `$.session.messages()` answered: the tool_use entries' `input`, and the
 * `result` of an answered call when it is an object. An error's `result` is its text, so it is left out. A call
 * counts as answered only with a structured result: a call inside a Code Mode script has none, also at turn end.
 */
export function summariesOf(rows: unknown, wanted: ReadonlySet<string>): Map<string, Summary> {
  const found = new Map<string, Summary>()
  if (!Array.isArray(rows)) return found
  const take = (id: string, part: Partial<Summary>): void => {
    if (!wanted.has(id)) return
    const known = found.get(id) ?? { isAnswered: false }
    found.set(id, { ...known, ...part, isAnswered: known.isAnswered || part.isAnswered === true })
  }
  for (const row of rows) {
    if (!isFields(row)) continue
    for (const use of Array.isArray(row.toolUses) ? row.toolUses : []) {
      if (!isFields(use) || typeof use.tool_use_id !== 'string') continue
      take(use.tool_use_id, {
        ...(isFields(use.input) ? { input: use.input } : {}),
        ...(isFields(use.result) ? { result: use.result, isAnswered: true } : {}),
      })
    }
    for (const done of Array.isArray(row.toolResults) ? row.toolResults : []) {
      if (!isFields(done) || typeof done.tool_use_id !== 'string') continue
      if (isFields(done.result)) take(done.tool_use_id, { result: done.result, isAnswered: true })
    }
  }
  return found
}

/**
 * Whether what `$.session.messages()` answered holds the result row of the call `id`: a tool_result entry for it,
 * with or without a stored record.
 */
export function isResultListed(rows: unknown, id: string): boolean {
  return Array.isArray(rows) && rows.some(row => isFields(row) && Array.isArray(row.toolResults) && row.toolResults.some(done => isFields(done) && done.tool_use_id === id))
}

/** A send's reported outcome; undefined when High Command cannot tell. */
export type SendOutcome = { isDelivered: true; reason?: undefined } | { isDelivered: false; reason: string } | undefined

const OPEN_TAG = '<tool_use_error>'
const CLOSE_TAG = '</tool_use_error>'

/** An error text without the `<tool_use_error>` tags around it. */
function untagged(text: string): string {
  if (!text.startsWith(OPEN_TAG) || !text.endsWith(CLOSE_TAG) || text.length < OPEN_TAG.length + CLOSE_TAG.length) return text
  return text.slice(OPEN_TAG.length, -CLOSE_TAG.length)
}

/** The JSON object that a text holds, or undefined. */
function objectOf(text: string): Fields | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return isFields(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** A SendMessage result's outcome, from its `success` and `message` fields. */
function outcomeOf(result: Fields | undefined): SendOutcome {
  if (result === undefined || typeof result.success !== 'boolean') return undefined
  if (result.success) return { isDelivered: true }
  return { isDelivered: false, reason: typeof result.message === 'string' && result.message !== '' ? result.message : 'not delivered' }
}

/**
 * The outcome of a SendMessage call: a failed call is not delivered, with its error text as the reason; otherwise
 * the `success` field of its stored result, or of the JSON text the model read. Undefined when neither says, as for
 * a call inside a Code Mode script that succeeded.
 */
export function sendOutcomeOf(call: RowCall): SendOutcome {
  if (call.isError) {
    const reason = untagged(call.text)
    return { isDelivered: false, reason: reason.trim() === '' ? 'not delivered' : reason }
  }
  return outcomeOf(isFields(call.result) ? call.result : undefined) ?? (call.text === '' ? undefined : outcomeOf(objectOf(call.text)))
}

/**
 * Whether a call waits for what `$.session.messages()` stores for it: a SendMessage call without its input, for its
 * recipient and text, as when the mod reloaded between the call's two rows; a ListAgents call, for the rows of its
 * listing; and a SendMessage call whose text does not say whether it was queued, for its record. A call with no text
 * never waits: the transcript holds no record for a call inside a Code Mode script. A failed call waits only for its
 * input: its record is its error text.
 */
export function needsResult(call: RowCall): boolean {
  if (call.text === '') return false
  if (call.toolName === 'SendMessage' && call.input === undefined) return true
  if (call.isError || call.result !== undefined) return false
  if (call.toolName === 'ListAgents') return true
  return call.toolName === 'SendMessage' && sendOutcomeOf(call) === undefined
}

/**
 * The peer states of a ListAgents call: its structured rows, else its printed listing, else the text the model read,
 * which is the printed listing. Undefined for a failed call and for a call with neither.
 */
export function listingOf(call: RowCall): { reports: PeerReport[]; rowCount: number } | undefined {
  if (call.isError) return undefined
  const structured = parseStructuredListing(call.result)
  if (structured !== undefined) return structured
  if (isFields(call.result) && typeof call.result.listing === 'string') return parseListing(call.result.listing)
  return call.text === '' ? undefined : parseListing(call.text)
}
