import type { HighCommandState, HighCommandTrust } from '../types'
import { LIMITS } from './limits'

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g
const FORMAT = /\p{Cf}/gu
/**
 * The invisible characters that the suspicious-text check reads past: format characters (category Cf), the
 * combining grapheme joiner U+034F, and the variation selectors U+FE00 to U+FE0F and U+E0100 to U+E01EF.
 */
const INVISIBLE = /[\p{Cf}\u034F\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The suspicious-text list, in order: an instruction to ignore earlier instructions, to
 * change the permission mode, to run a download in a shell (piped, or through `$(...)` or `<(...)`), or to
 * read a credential file. Every repeat is bounded or over distinct words, so a match is linear in the text.
 * `hasBase64Block` adds the last item of the list, a long base64 block.
 */
const SUSPICIOUS = [
  /\b(?:ignore|disregard|forget)\s+(?:(?:all|any|the|your|of)\s+)*(?:(?:previous|prior|earlier|above)\s+(?:instructions?|prompts?|rules?)\b|(?:instructions?|prompts?|rules?)\s+above\b)/i,
  /\b(?:bypassPermissions|dangerously-skip-permissions)\b|\b(?:change|switch|set)\b[^.\n]{0,30}\bpermission mode\b/i,
  /\b(?:curl|wget)\b[^|\n]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\b(?:(?:ba|z|da|k)?sh|eval|source)\s+(?:-c\s+)?["']?(?:\$\(|<\()\s*(?:curl|wget)\b/i,
  /\b(?:cat|read|print|send|upload|paste|share|copy|dump)\b[^\n]{0,60}(?:\.ssh\/|\bid_(?:rsa|ecdsa|ed25519)\b|\.aws\/credentials|\.netrc\b|\.git-credentials\b|\.env\b)/i,
]
/** Characters of one unbroken base64 run that make a long base64 block. */
const BASE64_RUN = 200

/** Removes control characters, keeping tab and line feed, so no terminal sequence reaches a drawing. */
export function sanitize(text: string): string {
  return text.replace(CONTROL, '')
}

/** Replaces each run of white space with one space and trims. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** The first line that holds a non-space character, as one line; '' when there is none. */
export function firstLine(text: string): string {
  const line = text.split('\n').find(part => part.trim() !== '')
  return line === undefined ? '' : oneLine(line)
}

/** Keeps at most `max` UTF-16 units of a longer text, never splitting a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  const kept = text.slice(0, max)
  const last = kept.charCodeAt(max - 1)
  return last >= 0xd800 && last <= 0xdbff ? kept.slice(0, -1) : kept
}

/** The text when it has at most `max` characters, else its start and '…'. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${cut(text, max - 1)}…`
}

/** The text as one line of at most LIMITS.summaryChars characters. */
export function lineOf(text: string): string {
  return clip(oneLine(text), LIMITS.summaryChars)
}

/** One summary line: the preferred text, else the first line of the body, else '(empty message)'. */
export function summaryOf(preferred: string | undefined, body: string): string {
  return lineOf(preferred ?? '') || lineOf(firstLine(body)) || '(empty message)'
}

/** The body as stored, and its length before the cut. */
export function capBody(text: string): { body: string; fullChars: number } {
  return { body: cut(text, LIMITS.bodyChars), fullChars: text.length }
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

/** `HH:MM` in local time. */
export function timeLabel(at: number): string {
  const time = new Date(at)
  return `${twoDigits(time.getHours())}:${twoDigits(time.getMinutes())}`
}

/** The local day, as in `Oct 4`. */
export function dayLabel(at: number): string {
  const time = new Date(at)
  return `${MONTHS[time.getMonth()]} ${time.getDate()}`
}

/** Whether two times fall on one local day. */
export function isSameDay(at: number, other: number): boolean {
  const one = new Date(at)
  const two = new Date(other)
  return one.getFullYear() === two.getFullYear() && one.getMonth() === two.getMonth() && one.getDate() === two.getDate()
}

/** `HH:MM` on the local day of `now`, else `Mon D HH:MM`. */
export function clockLabel(at: number, now: number): string {
  return isSameDay(at, now) ? timeLabel(at) : `${dayLabel(at)} ${timeLabel(at)}`
}

/** A state with the clock time it was reported, as in `idle (12:04)`; undefined without a state. */
export function stateLabel(state: HighCommandState | undefined, now: number): string | undefined {
  return state === undefined ? undefined : `${state.word} (${clockLabel(state.at, now)}${state.source ? `; ${state.source}; last reported` : ''})`
}

/**
 * A state as the roster shows it, as in `idle at 12:04`, whole: the roster row cuts it only when the row is full.
 * Undefined without a state. The thread shows its source (threadState).
 */
export function rosterState(state: HighCommandState | undefined, now: number): string | undefined {
  return state === undefined ? undefined : `${state.word} at ${clockLabel(state.at, now)}`
}

/** A state as a thread shows it, as in `State idle at 12:04 · peer notice · last reported`; the source only when known. */
export function threadState(state: HighCommandState, now: number): string {
  return `State ${state.word} at ${clockLabel(state.at, now)}${state.source ? ` · ${state.source} · last reported` : ''}`
}

/**
 * Whether the text holds BASE64_RUN or more base64 characters in a row that mix upper case, lower case,
 * and digits, as encoded data does; a run of one letter or of hex digits is not a block. One pass.
 */
function hasBase64Block(text: string): boolean {
  let run = 0
  let kinds = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    const kind = code >= 65 && code <= 90 ? 1 : code >= 97 && code <= 122 ? 2 : code >= 48 && code <= 57 ? 4 : code === 43 || code === 47 ? 8 : 0
    run = kind === 0 ? 0 : run + 1
    kinds = kind === 0 ? 0 : kinds | kind
    if (run >= BASE64_RUN && (kinds & 7) === 7) return true
  }
  return false
}

/**
 * Whether the text matches the suspicious-text list; the mark it gives is for display only. The list is tested on
 * two forms of the text: each INVISIBLE character read as a space, as between two words, and each one removed,
 * as inside a word. A match in either form marks the text. A space matches every class that an INVISIBLE
 * character matches in the list, so the first form keeps each match of the text as it came.
 */
export function isSuspicious(text: string): boolean {
  return [text.replace(INVISIBLE, ' '), text.replace(INVISIBLE, '')].some(
    form => SUSPICIOUS.some(pattern => pattern.test(form)) || hasBase64Block(form),
  )
}

/**
 * How the roster, the thread, and `/highcommand` name a trust level, as in `verified sender`; no label for a peer
 * that only received sends.
 */
export function trustLabel(trust: HighCommandTrust | undefined): string | undefined {
  return trust === undefined ? undefined : `${trust} sender`
}

/** A count and its noun: `1 peer`, `2 peers`. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * The unread counts that the band and the status line show, as in `3 unread (retained) · 2 unread in agent lanes`:
 * the main inbox's count, and the agent lanes' count when it is above zero; '' when both are zero.
 */
export function unreadText(main: number, lanes = 0): string {
  return [main > 0 ? `${main} unread (retained)` : undefined, lanes > 0 ? `${lanes} unread in agent lanes` : undefined]
    .filter(part => part !== undefined).join(' · ')
}

/** The dim hint at the end of the band's row: the keys that give the band the keyboard. */
export const BAND_KEY_HINT = 'ctrl+x tab to choose'

/** The dim hint at the end of the pane's location row: how to give the pane the keys, and how to give them back. */
export const PANE_KEY_HINT = 'ctrl+x tab or click for keys · esc to prompt'

/**
 * Code points a terminal can draw two cells wide, in broad ranges: Hangul, CJK, full-width forms, the emoji of the
 * symbol blocks, and every code point past U+FFFF.
 */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x231a, 0x2b55], [0x2e80, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x10000, 0x10ffff],
]

/**
 * The terminal cells one line of text takes, counted high: a code point in WIDE counts two, any other one, so a
 * row that fits by this count fits on the screen.
 */
export function cellWidth(text: string): number {
  let cells = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    cells += WIDE.some(([first, last]) => code >= first && code <= last) ? 2 : 1
  }
  return cells
}

/**
 * A full peer identity: one line without control or format characters
 * (bidi controls, zero-width marks). Bracketed text belongs to the name.
 */
export function peerKey(name: string): string {
  return oneLine(sanitize(name).replace(FORMAT, ''))
}

/** The 32-bit FNV-1a hash of a text's UTF-16 units, as 8 hexadecimal digits. */
function fnv1a(text: string): string {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619)
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** A display label for a normalized peer identity, clipped without changing its state key. */
export function peerLabel(peer: string): string {
  return peer.length <= LIMITS.nameChars ? peer : `${clip(peer, LIMITS.nameChars - 11)} [${fnv1a(peer)}]`
}

/**
 * The text's start and end around `…`, in at most `max` cells (cellWidth): the start takes the odd cell. Look-alike
 * names mostly differ at their end, so this keeps both the shared start and the part that tells them apart.
 */
function clipMiddle(text: string, max: number): string {
  const chars = [...text]
  let head = ''
  let headCells = 0
  for (const char of chars) {
    if (headCells + cellWidth(char) > Math.ceil((max - 1) / 2)) break
    head += char
    headCells += cellWidth(char)
  }
  let tail = ''
  let tailCells = 0
  for (const char of chars.reverse()) {
    if (tailCells + cellWidth(char) > max - 1 - headCells) break
    tail = char + tail
    tailCells += cellWidth(char)
  }
  return `${head}…${tail}`
}

/** The text whole when it takes at most `max` cells (cellWidth), else its start and end around `…` (clipMiddle). */
function cutCells(text: string, max: number): string {
  return cellWidth(text) <= max ? text : clipMiddle(text, max)
}

/** Hexadecimal digits of the code that tells look-alike cut labels apart. */
const CODE_DIGITS = 4

/**
 * A peer's label in `cells` cells, at one of two steps, each from the name alone. Step 0: the name, or its start and end
 * when it is wider. Step 1: a shorter cut and the first CODE_DIGITS digits of the name's FNV-1a hash, as in
 * `rele…west [3f9a]`.
 */
function cellLabel(peer: string, cells: number, step: number): string {
  return step === 0 ? cutCells(peer, cells) : `${cutCells(peer, cells - CODE_DIGITS - 3)} [${fnv1a(peer).slice(0, CODE_DIGITS)}]`
}

/**
 * Labels in `cells` cells, at least 12, for the fixed roster columns. A peer shows its step 0 label (cellLabel) while
 * no other peer shows the same text, else its step 1 label, so a label passes to no other peer. A step 0 label that
 * reads as another peer's step 1 label also moves, so a name cannot copy a coded label. Peers whose step 1 labels still
 * match, which takes equal cuts and an equal code, are numbered in name order, apart from every other label.
 */
function cellLabels(peers: readonly string[], cells: number): Map<string, string> {
  const steps = new Map(peers.map(peer => [peer, 0]))
  const labelOf = (peer: string) => cellLabel(peer, cells, steps.get(peer)!)
  for (let isMoved = true; isMoved;) {
    isMoved = false
    const counts = new Map<string, number>()
    for (const peer of peers) counts.set(labelOf(peer), (counts.get(labelOf(peer)) ?? 0) + 1)
    for (const peer of peers) {
      if (steps.get(peer) === 0 && counts.get(labelOf(peer))! > 1) {
        steps.set(peer, 1)
        isMoved = true
      }
    }
  }
  const groups = new Map<string, string[]>()
  for (const peer of [...peers].sort()) groups.set(labelOf(peer), [...(groups.get(labelOf(peer)) ?? []), peer])
  const result = new Map<string, string>()
  const reserved = new Set(groups.keys())
  for (const [label, group] of groups) {
    if (group.length === 1) {
      result.set(group[0]!, label)
      continue
    }
    let index = 0
    for (const peer of group) {
      let resolved: string
      do {
        index += 1
        resolved = `${cutCells(peer, cells - 3 - String(index).length)} [${index}]`
      } while (reserved.has(resolved))
      reserved.add(resolved)
      result.set(peer, resolved)
    }
  }
  return new Map(peers.map(peer => [peer, result.get(peer)!]))
}

/**
 * Resolves even hash collisions across the current retained roster. With `cells`, labels fit that many cells
 * (cellLabels).
 */
export function peerLabels(peers: readonly string[], cells?: number): Map<string, string> {
  if (cells !== undefined) return cellLabels([...new Set(peers)], cells)
  const groups = new Map<string, string[]>()
  for (const peer of new Set(peers)) {
    const label = peerLabel(peer)
    groups.set(label, [...(groups.get(label) ?? []), peer])
  }
  const result = new Map<string, string>()
  const reserved = new Set(groups.keys())
  for (const [label, group] of groups) {
    group.sort()
    let index = 0
    for (const peer of group) {
      let resolved = label
      if (group.length > 1) {
        do { resolved = `${clip(label, 50)} [${++index}]` } while (reserved.has(resolved))
        reserved.add(resolved)
      }
      result.set(peer, resolved)
    }
  }
  return result
}

/**
 * Button keys for peer rows that stay with the peer when the roster order changes: `peer:` and the FNV-1a hash of the
 * full identity, with `-2`, `-3`, ... for the later names, in name order, that share a hash.
 */
export function peerKeys(peers: readonly string[]): Map<string, string> {
  const keys = new Map<string, string>()
  const taken = new Map<string, number>()
  for (const peer of [...new Set(peers)].sort()) {
    const hash = fnv1a(peer)
    const count = (taken.get(hash) ?? 0) + 1
    taken.set(hash, count)
    keys.set(peer, count === 1 ? `peer:${hash}` : `peer:${hash}-${count}`)
  }
  return keys
}

/** A conversation-local marker, preserved across module reloads. */
export function captureLabel(capture: { at: number; reset: boolean }, now: number): string {
  return `Capture window: ${clockLabel(capture.at, now)} · current conversation only. ${capture.reset ? 'Previous High Command history was not restored.' : 'Earlier history is not included.'}`
}

/** Fixed-width identity pages never separate the halves of a surrogate pair. */
export function identityPart(peer: string, page: number): string {
  const boundary = (at: number): number => {
    const char = peer.charCodeAt(at)
    return char >= 0xdc00 && char <= 0xdfff ? at - 1 : at
  }
  return peer.slice(boundary(page * 1000), boundary((page + 1) * 1000))
}
