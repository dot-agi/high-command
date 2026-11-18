import type { PeerReport } from './envelope'
import { LIMITS } from './limits'
import { peerKey, sanitize } from './text'

/**
 * The start of a listing row, `  name [ref]`, where the engine's `·` fields begin. The name runs to the last
 * ` [ref]` that a `·` follows, so a session name that holds ` [ref] · ` stays whole and cannot place a field.
 * The fields after it are split on `·`, not matched by a repeated group, so a hostile row cannot make the
 * match backtrack across its fields.
 */
const HEAD = /^\s+(\S.*) \[[0-9a-z]+\](?=\s+·)/i
/** A state word as the engine writes one: a letter, then letters, spaces, and hyphens. */
const STATE_WORD = new RegExp(`^[a-z][a-z -]{0,${LIMITS.stateChars - 1}}$`, 'i')
/** The header of the listing's teammate rows. Any other header line, such as `Peer sessions (n):`, ends that section. */
const TEAMMATES = /^Teammates \(\d+\):$/
/** The last field of a teammate row that says when it started, as in `started 6s ago`. */
const STARTED = /^started\s/
/**
 * The state words of a teammate row. A teammate with no state prints its type alone, as in `general-purpose ·
 * started 2s ago`, or its backend, as in `pane`, so only these words count as a state.
 */
export const TEAMMATE_STATES: ReadonlySet<string> = new Set(['running', 'idle', 'done', 'failed', 'stopped', 'offline'])

/**
 * The state of a teammate row from its fields after the ref: `state`, or `type · state`, each with an optional
 * `started ...` field at the end (both forms measured on 2.1.326). The last field gives the state only when it is
 * one of TEAMMATE_STATES. Any other number of fields, or an empty field, gives none.
 */
function teammateState(fields: readonly string[]): string | undefined {
  const kept = fields.length > 0 && STARTED.test(fields.at(-1)!) ? fields.slice(0, -1) : fields
  if (kept.length < 1 || kept.length > 2 || kept.some(field => field === '')) return undefined
  const state = kept.at(-1)!
  return TEAMMATE_STATES.has(state) ? state : undefined
}

/**
 * Peer states from a ListAgents listing, and how many lines looked like rows. A row under `Teammates (n):` gives the
 * state of teammateState; any other row gives its second field after the ref (`interactive · busy`), as in 1.3.1.
 */
export function parseListing(listing: string): { reports: PeerReport[]; rowCount: number } {
  const reports: PeerReport[] = []
  let rowCount = 0
  let isTeammates = false
  for (const line of sanitize(listing).split('\n')) {
    if (!/^\s+\S/.test(line)) {
      if (line.trim() !== '') isTeammates = TEAMMATES.test(line.trim())
      continue
    }
    rowCount += 1
    const head = HEAD.exec(line)
    if (head === null) continue
    const peer = peerKey(head[1] ?? '')
    // The text before the first `·` is the space after the ref; the fields keep their places, so an empty one stays empty.
    const fields = line.slice(head[0].length).split('·').slice(1).map(field => field.trim())
    const state = isTeammates ? teammateState(fields) : fields[1]
    if (peer !== '' && state !== undefined && STATE_WORD.test(state)) reports.push({ peer, state })
  }
  return { reports, rowCount }
}

/** Structured rows take precedence; duplicate names cannot establish one peer's state. */
export function parseStructuredListing(result: unknown): { reports: PeerReport[]; rowCount: number } | undefined {
  if (typeof result !== 'object' || result === null || !('sections' in result) || !Array.isArray(result.sections)) return undefined
  const states = new Map<string, string | undefined>()
  let rowCount = 0
  for (const section of result.sections) {
    if (typeof section !== 'object' || section === null || !Array.isArray(section.rows)) continue
    for (const row of section.rows) {
      rowCount++
      if (typeof row !== 'object' || row === null || typeof row.name !== 'string') continue
      const peer = peerKey(row.name)
      if (peer === '') continue
      const state = typeof row.status === 'string' ? sanitize(row.status).trim() : ''
      states.set(peer, states.has(peer) || !STATE_WORD.test(state) ? undefined : state)
    }
  }
  return {
    reports: [...states].flatMap(([peer, state]) => state === undefined ? [] : [{ peer, state, source: 'structured listing' }]),
    rowCount,
  }
}
