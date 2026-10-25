import { atom, read } from 'claude-code'
import type { AgentInfo, CommandRunResult, EngineInterface, Register, SessionReceiveOrigin, SessionSendResult, Timer, TraceEntry } from 'claude-code'

import type { HighCommandAgent, HighCommandCapture, HighCommandEntry, HighCommandLane, HighCommandPeer, HighCommandThread, HighCommandView } from '../types'
import { agentSenderOf, isAgentMessage, parseDelivery, spawnerOf, UNNAMED, type NewEntry, type PeerReport } from './envelope'
import {
  appendEntries,
  coreEvidence,
  applyReports,
  fitLanes,
  hideLanes,
  keepsThread,
  lanesSeen,
  lanesUnread,
  markOf,
  markRead,
  newestInboundSeq,
  newestSeq,
  newestUnreadableSeq,
  outboundEntry,
  recipientOf,
  rosterOf,
  threadOf,
  unreadTotal,
  type RosterRow,
} from './inbox'
import { LIMITS } from './limits'
import { parseListing, parseStructuredListing } from './listing'
import { summaryText } from './summary'
import { count, sanitize, peerKey, peerKeys, peerLabels, unreadText } from './text'
import { bandTree, compactBandTree, fitsBounds, laneIdsOf, laneIdsShown, paneTree, rosterPageOf, type BandActions, type PaneActions } from './views'

const DESCRIPTION = 'High Command: messages from teammates and other sessions (/highcommand open shows the pane)'
const PANE = { id: 'high-command', title: 'High Command', focus: true } as const
const USAGE = 'Usage: /highcommand shows the inbox summary. /highcommand open opens the High Command pane.'
const NO_PANES =
  'command.run: this session draws no panes (claude -p or an SDK host). Use /highcommand for the summary.'

/** The origin kinds whose deliveries can hold messages from peers; `unclassified` counts only with a frame. */
const MESSAGE_ORIGINS: ReadonlySet<string> = new Set(['peer', 'coordinator', 'peer-send-message', 'unclassified'])

const VIEW = { plugin: 'high-command', key: 'view' } as const
const LANE_VIEW = { plugin: 'high-command', key: 'laneView' } as const

/** The values of 1.2.2, read once after an update (adoptOld). */
const OLD_ENTRIES = { plugin: 'high-command', key: 'entries' } as const
const OLD_PEERS = { plugin: 'high-command', key: 'peers' } as const
const OLD_READ_THROUGH = { plugin: 'high-command', key: 'readThrough' } as const
const OLD_OPEN_THREAD = { plugin: 'high-command', key: 'openThread' } as const
const OLD_HIDDEN_THROUGH = { plugin: 'high-command', key: 'hiddenThrough' } as const
const OLD_INBOUND_THROUGH = { plugin: 'high-command', key: 'inboundThrough' } as const
const OLD_LANES = { plugin: 'high-command', key: 'lanes' } as const
const OLD_HIDDEN_LANES = { plugin: 'high-command', key: 'hiddenLanes' } as const
const OLD_CAPTURE = { plugin: 'high-command', key: 'capture' } as const
const OLD_SELECTED_LANE = { plugin: 'high-command', key: 'selectedLane' } as const
const OLD_LANE_PAGE = { plugin: 'high-command', key: 'lanePage' } as const
const OLD_AGENT_STATUS = { plugin: 'high-command', key: 'agentStatus' } as const
const OLD_ROSTER_PAGE = { plugin: 'high-command', key: 'rosterPage' } as const
const OLD_AGENTS = { plugin: 'high-command', key: 'agents' } as const

/**
 * The mirror of the current inbox in `$.state`. The pane and the band read it, so Claude Code draws them again after
 * each mirror write, but they draw the inbox in module memory: a late mirror write cannot show another conversation.
 */
const view = atom(VIEW, {
  session: '', epoch: 0, revision: 0, entries: [], peers: {}, readThrough: {}, hiddenThrough: 0, inboundThrough: 0, capture: null,
  openThread: null, rosterPage: 0, selectedLane: null, lanePage: 0, agentStatus: false, agents: {},
})

/**
 * One conversation's inbox. Module memory holds it, and it survives /branch, /resume, and /clear, so the reset of
 * `$.state` at a switch cannot race it. Each hook and press changes it at once, without an await in between (edit).
 */
type Inbox = {
  /** A new number for each new inbox, a branch copy included: a press from a drawing of another inbox marks nothing. */
  epoch: number
  entries: HighCommandEntry[]
  peers: Record<string, HighCommandPeer>
  readThrough: Record<string, number>
  hiddenThrough: number
  inboundThrough: number
  lanes: Record<string, HighCommandLane>
  hiddenLanes: Record<string, number>
  capture: HighCommandCapture | null
  openThread: HighCommandThread | null
  rosterPage: number
  selectedLane: string | null
  lanePage: number
  agentStatus: boolean
}

/** Inboxes made since this module loaded. */
let epochs = 0

function emptyInbox(): Inbox {
  epochs += 1
  return {
    epoch: epochs, entries: [], peers: {}, readThrough: {}, hiddenThrough: 0, inboundThrough: 0, lanes: {}, hiddenLanes: {},
    capture: null, openThread: null, rosterPage: 0, selectedLane: null, lanePage: 0, agentStatus: false,
  }
}

/**
 * The inbox of each conversation this process saw, by session id, the one used last at the end: a branch copies its
 * parent's, and a resume takes its own back. It keeps the current one and LIMITS.snapshots others.
 */
const inboxes = new Map<string, Inbox>()
/** The session whose inbox the hooks change and the pane and the band draw; '' when Claude Code did not say. */
let current: string | undefined
/** The session that ended last at a switch, until the next conversation starts: the parent of a branch. */
let lastEnded: string | undefined
/**
 * The switch that session.end noted, until classic.SessionStart or settle takes it: its reason and the session that
 * ended. With managed settings or a Team or Enterprise sign-in, Claude Code passes no classic event to installed mods,
 * so only settle sees the switch.
 */
let pending: { reason: 'clear' | 'resume'; ended: string } | undefined
/** The session that settle moved to since the last session.end: a classic.SessionStart for it changes no inbox. */
let settled: string | undefined
/** The local agents of the process: every conversation shows them. */
let agents: Record<string, HighCommandAgent> = {}
/** Counts the changes of module data: the mirror and the status line write only after one. */
let changes = 0

/** Changes `inbox` at once and counts the change. */
function edit(inbox: Inbox, change: Partial<Inbox>): void {
  Object.assign(inbox, change)
  changes += 1
}

/** Files `inbox` under `id` as the one used last, and drops the inboxes used least recently past the bound. */
function keep(id: string, inbox: Inbox): Inbox {
  inboxes.delete(id)
  inboxes.set(id, inbox)
  for (const old of inboxes.keys()) if (inboxes.size > LIMITS.snapshots + 1 && old !== id) inboxes.delete(old)
  changes += 1
  return inbox
}

/** The inbox of the session `id`, a new empty one when the process holds none. */
function inboxOf(id: string): Inbox {
  return inboxes.get(id) ?? keep(id, emptyInbox())
}

/** The current conversation's inbox. */
function inboxNow(): Inbox {
  return inboxOf(current ?? '')
}

/**
 * The inbox a press acts on: the one its drawing showed, while that conversation is still the current one and its
 * inbox the same; else undefined, and the press does nothing.
 */
function pressed(drawn: Drawn): Inbox | undefined {
  const inbox = current === drawn.session ? inboxes.get(drawn.session) : undefined
  return inbox?.epoch === drawn.epoch ? inbox : undefined
}

/** What a drawing showed: its conversation and inbox, and the newest seq it drew, also per agent lane. */
type Drawn = { session: string; epoch: number; through: number; lanes: ReadonlyMap<string, number> }

function drawnOf(inbox: Inbox, list: readonly HighCommandEntry[]): Drawn {
  const lanes = new Map(Object.entries(inbox.lanes).map(([id, lane]) => [id, newestSeq(lane.entries)]))
  return { session: current ?? '', epoch: inbox.epoch, through: newestSeq(list), lanes }
}

/** The entries of `list` that a drawing through seq `through` showed: a mark never covers a message drawn later. */
function seenOf(list: readonly HighCommandEntry[], through: number): HighCommandEntry[] {
  return list.filter(entry => entry.seq <= through)
}

function emptyLane(): HighCommandLane {
  return { entries: [], peers: {}, readThrough: {}, openThread: null }
}

function laneOf(inbox: Inbox, id: string): HighCommandLane {
  return Object.hasOwn(inbox.lanes, id) ? inbox.lanes[id]! : emptyLane()
}

/** Characters that the copy of the lanes adds around them: its session id, its epoch, and its keys. */
const LANE_VIEW_FRAME = 256

/** Characters of the copy of `lanes` and `hiddenLanes` as one saved value. */
function savedSize(lanes: Readonly<Record<string, HighCommandLane>>, hiddenLanes: Readonly<Record<string, number>>): number {
  return JSON.stringify(lanes).length + JSON.stringify(hiddenLanes).length + LANE_VIEW_FRAME
}

/**
 * Lanes and their Hide marks cut to the space of one saved value, for lanes that no change built, as those of 1.2.2:
 * fitLanes first, then the Hide marks go, so that the band counts those lanes again, and then the lanes whose newest
 * message is oldest. `isCut` says whether a Hide mark or a lane went; `dropped` counts the lanes.
 */
function fitSaved(lanes: Readonly<Record<string, HighCommandLane>>, hiddenLanes: Readonly<Record<string, number>>): { lanes: Record<string, HighCommandLane>; hiddenLanes: Record<string, number>; isCut: boolean; dropped: number } {
  const fitted = fitLanes(lanes)
  if (savedSize(fitted, hiddenLanes) <= LIMITS.savedChars) return { lanes: fitted, hiddenLanes: { ...hiddenLanes }, isCut: false, dropped: 0 }
  const kept = new Map(Object.entries(fitted))
  let size = savedSize(fitted, {})
  let dropped = 0
  const oldestFirst = [...kept].sort(([, a], [, b]) => (a.entries.at(-1)?.at ?? 0) - (b.entries.at(-1)?.at ?? 0))
  for (const [id, lane] of oldestFirst) {
    if (size <= LIMITS.savedChars) break
    kept.delete(id)
    size -= JSON.stringify(id).length + JSON.stringify(lane).length + 2
    dropped += 1
  }
  return { lanes: Object.fromEntries(kept), hiddenLanes: {}, isCut: true, dropped }
}

/**
 * Sets the agent lanes and their Hide marks of `inbox`, unless their copy would pass the space of one saved value.
 * fitLanes drops old lane messages, but each lane keeps its newest message, so very many lanes can still pass it: the
 * change then throws before memory changes, and the hook or the press says so.
 */
function setLanes(inbox: Inbox, lanes: Record<string, HighCommandLane>, hiddenLanes = inbox.hiddenLanes): void {
  const size = JSON.stringify(lanes).length + JSON.stringify(hiddenLanes).length + LANE_VIEW_FRAME
  if (size > LIMITS.savedChars) {
    throw new Error(`the agent lanes would pass the ${count(LIMITS.savedChars, 'character')} that Claude Code saves in one value, so the change is not kept`)
  }
  edit(inbox, { lanes, hiddenLanes })
}

/** Changes one agent lane; fitLanes keeps all lanes within the space of one saved value where it can (setLanes). */
function changeLane(inbox: Inbox, id: string, change: (lane: HighCommandLane) => HighCommandLane): void {
  const next = new Map(Object.entries(inbox.lanes))
  next.set(id, change(next.get(id) ?? emptyLane()))
  setLanes(inbox, fitLanes(Object.fromEntries(next), id))
}

/** Changes every agent lane at once; `change` gets each lane and its id. */
function changeLanes(inbox: Inbox, change: (lane: HighCommandLane, id: string) => HighCommandLane): void {
  setLanes(inbox, fitLanes(Object.fromEntries(Object.entries(inbox.lanes).map(([id, lane]) => [id, change(lane, id)]))))
}

function changeThread(inbox: Inbox, id: string | undefined, change: (thread: HighCommandThread | null) => HighCommandThread | null): void {
  if (id === undefined) edit(inbox, { openThread: change(inbox.openThread) })
  else changeLane(inbox, id, lane => ({ ...lane, openThread: change(lane.openThread) }))
}

function ensureCapture(inbox: Inbox, at: number): void {
  if (inbox.capture === null) edit(inbox, { capture: { at, reset: false } })
}

/** The open threads, roster pages, lane picked, and lane page of `inbox` start over, as after a reset of `$.state`. */
function startOver(inbox: Inbox): Inbox {
  const lanes = Object.fromEntries(Object.entries(inbox.lanes).map(([id, { openThread: _thread, rosterPage: _page, ...lane }]) => [id, { ...lane, openThread: null }]))
  edit(inbox, { lanes, openThread: null, rosterPage: 0, selectedLane: null, lanePage: 0, agentStatus: false })
  return inbox
}

/** A branch of `parent`: a copy of its inbox under a new epoch, where the views start over (startOver). */
function branchOf(parent: Inbox): Inbox {
  epochs += 1
  return startOver({ ...parent, epoch: epochs })
}

/** Reads status without treating a repeated split-pane roster word as liveness evidence. */
async function refreshAgents($: EngineInterface, event: string): Promise<void> {
  try {
    const at = await $.clock.now()
    const list = await $.agent.list()
    const next = new Map(Object.entries(agents).filter(([, value]) => value.at > at))
    for (const agent of list) if (!next.has(agent.id)) next.set(agent.id, {
      id: agent.id, name: agent.name === undefined ? undefined : peerKey(agent.name),
      status: agent.status, at, source: 'roster snapshot',
      lastEvent: Object.hasOwn(agents, agent.id) ? agents[agent.id]?.lastEvent : undefined,
    })
    agents = Object.fromEntries(next)
    changes += 1
  } catch (error) {
    diagnose($, `high-command: ${event}: could not refresh local agents: ${causeOf(error)}`)
  }
}

/** Transcript diagnostics already written since this module loaded. */
const logged = new Set<string>()

function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Writes a diagnostic to the transcript once per module load; a repeat goes to the debug log alone. */
function diagnose($: EngineInterface, line: string): void {
  if (logged.has(line)) {
    $.ui.log(line.replace(/^high-command: /, ''), { to: 'debug' })
    return
  }
  logged.add(line)
  $.ui.log(line.replace(/^high-command: /, ''))
}

/** Whether this module took the inbox back from `$.state`, or found no copy there: only then may it write the mirror. */
let isAdopted = false
/** The take-back under way or done; undefined until the first hook, and again after one that could not read the copy. */
let ready: Promise<boolean> | undefined

/**
 * Takes the inbox back once per module load (adopt), before any write. Resolves false while the copy in `$.state`
 * cannot be read: the hook then records nothing and writes nothing, and the next hook tries again. So memory that is
 * empty after a reload never writes over the copy that the module before it left.
 */
function ensureReady($: EngineInterface, event: string): Promise<boolean> {
  if (ready === undefined) {
    const adopting = adopt($, event)
    ready = adopting
    void adopting.then(isDone => {
      if (!isDone && ready === adopting) ready = undefined
    })
  }
  return ready
}

/**
 * Takes back the inbox that `$.state` mirrors when this module has none for the current session, as after a reload of
 * the mod, which empties module memory, keeps `$.state`, and runs session.start again. A mirror of another session
 * stays out, and one that names no session counts as this session's. Resolves whether it could read the copy.
 */
async function adopt($: EngineInterface, event: string): Promise<boolean> {
  if (current === undefined) {
    // Without the id, no copy can be told apart from another session's: take nothing back, and try again later.
    try {
      current = await $.session.id()
    } catch (error) {
      diagnose($, `high-command: ${event}: could not read the session id: ${causeOf(error)}`)
      return false
    }
  }
  const id = current
  if (inboxes.has(id)) {
    isAdopted = true
    return true
  }
  const inbox = emptyInbox()
  try {
    const main = (await $.state.get(VIEW)).value
    const laneView = (await $.state.get(LANE_VIEW)).value
    const isOwn = (session: string | undefined) => session === undefined || session === id
    if (main !== undefined && isOwn(main.session)) {
      edit(inbox, {
        entries: main.entries ?? [], peers: main.peers ?? {}, readThrough: main.readThrough ?? {},
        hiddenThrough: main.hiddenThrough ?? 0, inboundThrough: main.inboundThrough ?? 0, capture: main.capture ?? null,
        openThread: main.openThread ?? null, rosterPage: main.rosterPage ?? 0, selectedLane: main.selectedLane ?? null,
        lanePage: main.lanePage ?? 0, agentStatus: main.agentStatus ?? false,
      })
      agents = main.agents ?? {}
    }
    if (laneView !== undefined && isOwn(laneView.session)) edit(inbox, { lanes: laneView.lanes ?? {}, hiddenLanes: laneView.hiddenLanes ?? {} })
    // Until both copies have landed, the values of 1.2.2 still hold what a missing copy would have held.
    if (main === undefined || laneView === undefined) await adoptOld($, inbox, event, main === undefined, laneView === undefined)
  } catch (error) {
    diagnose($, `high-command: ${event}: could not take back the inbox: ${causeOf(error)}`)
    return false
  }
  keep(id, inbox)
  isAdopted = true
  return true
}

/**
 * Takes over into `inbox` the values that 1.2.2 kept in `$.state` itself, after an update by /reload-plugins: the
 * values belong to the current session, since Claude Code resets them at each switch. `isMain` and `isLanes` say which
 * copy has not landed yet, and so which part to take: until a copy lands, each load takes its part from these values.
 * The lanes take the space of one saved value at most (fitSaved), so that their copy can land.
 */
async function adoptOld($: EngineInterface, inbox: Inbox, event: string, isMain: boolean, isLanes: boolean): Promise<void> {
  if (isMain) {
    const main = {
      entries: (await $.state.get(OLD_ENTRIES)).value, peers: (await $.state.get(OLD_PEERS)).value,
      readThrough: (await $.state.get(OLD_READ_THROUGH)).value, openThread: (await $.state.get(OLD_OPEN_THREAD)).value,
      hiddenThrough: (await $.state.get(OLD_HIDDEN_THROUGH)).value, inboundThrough: (await $.state.get(OLD_INBOUND_THROUGH)).value,
      capture: (await $.state.get(OLD_CAPTURE)).value, selectedLane: (await $.state.get(OLD_SELECTED_LANE)).value,
      lanePage: (await $.state.get(OLD_LANE_PAGE)).value, agentStatus: (await $.state.get(OLD_AGENT_STATUS)).value,
      rosterPage: (await $.state.get(OLD_ROSTER_PAGE)).value, agents: (await $.state.get(OLD_AGENTS)).value,
    }
    if (Object.values(main).some(value => value !== undefined)) {
      edit(inbox, {
        entries: main.entries ?? [], peers: main.peers ?? {}, readThrough: main.readThrough ?? {}, openThread: main.openThread ?? null,
        hiddenThrough: main.hiddenThrough ?? 0, inboundThrough: main.inboundThrough ?? 0, capture: main.capture ?? null,
        selectedLane: main.selectedLane ?? null, lanePage: main.lanePage ?? 0, agentStatus: main.agentStatus ?? false, rosterPage: main.rosterPage ?? 0,
      })
      agents = main.agents ?? agents
    }
  }
  if (isLanes) {
    const lanes = (await $.state.get(OLD_LANES)).value
    const hiddenLanes = (await $.state.get(OLD_HIDDEN_LANES)).value
    if (lanes === undefined && hiddenLanes === undefined) return
    const fitted = fitSaved(lanes ?? {}, hiddenLanes ?? {})
    if (fitted.isCut) {
      const dropped = fitted.dropped === 0 ? '' : ` and ${count(fitted.dropped, 'lane')} whose newest message was oldest`
      diagnose($, `high-command: ${event}: the agent lanes of 1.2.2 pass the space of one saved value, so High Command dropped their Hide marks${dropped}`)
    }
    edit(inbox, { lanes: fitted.lanes, hiddenLanes: fitted.hiddenLanes })
  }
}

/** The `changes` count that the mirror last wrote. */
let mirrored = -1
/** Mirror writes issued, and the newest one that answered. */
let writes = 0
let answered = 0
/** The lane value the mirror wrote last; undefined once Claude Code resets `$.state` or a lane write may be stale. */
let laneMirror: { session: string; epoch: number; lanes: Record<string, HighCommandLane>; hiddenLanes: Record<string, number> } | undefined

/** The mirror writes under way (publish), until each lands or fails: the copy of a settled switch waits for them too (startCopy). */
const publishing = new Set<Promise<void>>()

/** Writes the mirror (writeMirror), and notes the write in `publishing` while it is under way. */
function publish($: EngineInterface): Promise<void> {
  const run = writeMirror($)
  publishing.add(run)
  const done = () => { publishing.delete(run) }
  void run.then(done, done)
  return run
}

/**
 * Writes the current inbox to `$.state`, each value whole: the main view, and the lanes when they changed. Each write
 * holds the data of the moment it leaves, so the last one wins with current data. A write that answers after a newer
 * one may have landed last, so it writes the data again.
 */
async function writeMirror($: EngineInterface): Promise<void> {
  if (!isAdopted || changes === mirrored) return
  for (;;) {
    mirrored = changes
    const session = current ?? ''
    const inbox = inboxNow()
    writes += 1
    const write = writes
    const sent = laneMirror
    // A failed lane write is reported once the main view is written, so it never keeps a main message from the copy.
    let laneFailure: { error: unknown } | undefined
    if (sent === undefined || sent.session !== session || sent.epoch !== inbox.epoch || sent.lanes !== inbox.lanes || sent.hiddenLanes !== inbox.hiddenLanes) {
      const lanes = { session, epoch: inbox.epoch, lanes: inbox.lanes, hiddenLanes: inbox.hiddenLanes }
      laneMirror = lanes
      try {
        await $.state.set(LANE_VIEW, lanes)
      } catch (error) {
        laneMirror = undefined
        laneFailure = { error }
      }
    }
    const main: HighCommandView = {
      session, epoch: inbox.epoch, revision: write, entries: inbox.entries, peers: inbox.peers, readThrough: inbox.readThrough,
      hiddenThrough: inbox.hiddenThrough, inboundThrough: inbox.inboundThrough, capture: inbox.capture, openThread: inbox.openThread,
      rosterPage: inbox.rosterPage, selectedLane: inbox.selectedLane, lanePage: inbox.lanePage, agentStatus: inbox.agentStatus, agents,
    }
    await $.state.set(VIEW, main)
    if (write > answered) {
      answered = write
      if (laneFailure !== undefined) throw laneFailure.error
      return
    }
    laneMirror = undefined
  }
}

/** Writes the mirror after a change; a failure is diagnosed under `event`. */
async function mirror($: EngineInterface, event: string): Promise<void> {
  try {
    await publish($)
  } catch (error) {
    diagnose($, `high-command: ${event}: could not update the view: ${causeOf(error)}`)
  }
}

/** The `changes` count that the status line last showed. */
let pinned = -1

/**
 * Pins the unread count as this plugin's status line, which no other mod's band can hide, or clears the line at zero,
 * once per change of module data. The count comes from module memory as the call leaves, so the newest call carries
 * the newest count. `isForced` pins whatever the line shows: a reload may drop the line. `withLanes` (agentLanesInBand)
 * adds the unread count of all agent lanes. A failure is diagnosed under `event`.
 */
function syncStatus($: EngineInterface, event: string, isForced = false, withLanes = false): void {
  if (!isForced && changes === pinned) return
  pinned = changes
  try {
    const inbox = inboxNow()
    $.ui.status(unreadText(unreadTotal(rosterOf(inbox.entries, {}, inbox.readThrough)), withLanes ? lanesUnread(inbox.lanes) : 0) || undefined)
  } catch (error) {
    diagnose($, `high-command: ${event}: could not update the status line: ${causeOf(error)}`)
  }
}

/**
 * Takes the switch that session.end noted when no classic.SessionStart reports it, at the first hook after
 * `$.session.id()` stops answering the session that ended. Until then the switch is still under way, and nothing
 * changes. Then, once: a clear starts an empty inbox; a resume takes back the inbox that this process kept for the
 * session, else starts an empty one. Here a branch cannot be told from a resume of another process's conversation, so
 * it starts empty too, and shows nothing of another conversation. Without the guard, a branch never settles here:
 * `$.session.id()` answers the parent until classic.SessionStart has run. `write` says when the copy of the inbox goes
 * to `$.state` (CopyWrite, startCopy).
 */
async function settle($: EngineInterface, event: string, withLanes: boolean, write: CopyWrite = 'await'): Promise<void> {
  const waiting = pending
  if (waiting === undefined) return
  let id: string
  try {
    id = await $.session.id()
  } catch (error) {
    diagnose($, `high-command: ${event}: could not read the session id: ${causeOf(error)}`)
    return
  }
  if (pending !== waiting || id === waiting.ended) return
  let now: number | undefined
  try { now = await $.clock.now() } catch (error) { diagnose($, `high-command: ${event}: could not set capture window: ${causeOf(error)}`) }
  // Another hook, classic.SessionStart, or a newer session.end took the switch meanwhile.
  if (pending !== waiting) return
  pending = undefined
  settled = id
  lastEnded = undefined
  laneMirror = undefined
  const known = waiting.reason === 'resume' ? inboxes.get(id) : undefined
  current = id
  const inbox = keep(id, known !== undefined ? startOver(known) : emptyInbox())
  if (now !== undefined) {
    if (known === undefined) edit(inbox, { capture: { at: now, reset: true } })
    else ensureCapture(inbox, now)
  }
  syncStatus($, event, true, withLanes)
  const copy = noteCopy()
  if (write === 'timer') $.clock.after(0, () => { void startCopy($, copy, event) })
  else if (write === 'start') void startCopy($, copy, event)
  else await startCopy($, copy, event)
}

/**
 * When a settle writes its copy of the inbox to `$.state` (startCopy): `await`, before the settle resolves; `timer`, in
 * a timer at 0 ms, as a drawing may not write `$.state`; `start`, at once, while the caller waits for it (settleFirst).
 */
type CopyWrite = 'await' | 'timer' | 'start'

/** The copy of the inbox that a settle writes to `$.state`: its write once begun (startCopy). */
type SettleCopy = { written?: Promise<void> }

/**
 * The copy that the last settle writes, from the settle until that write has landed or failed (noteCopy). A slash
 * command or a /config change waits for it (settleFirst), and writes it at once when a drawing left it to its timer.
 */
let settleCopy: SettleCopy | undefined

/** Notes a new copy of a settle in `settleCopy`, not begun yet. */
function noteCopy(): SettleCopy {
  const copy: SettleCopy = {}
  settleCopy = copy
  return copy
}

/**
 * Writes `copy` once, and resolves once that write has landed or failed: whoever starts it first writes it with its own
 * `$`, the timer of a drawing or a hook, and each later call gets the same write. The write is a mirror write under
 * `event`, then a wait for every mirror write under way (publishing): a write that another hook began after the settle
 * holds its data, and may not have landed yet. Then the note goes.
 */
function startCopy($: EngineInterface, copy: SettleCopy, event: string): Promise<void> {
  copy.written ??= (async () => {
    await mirror($, event)
    await Promise.allSettled([...publishing])
    if (settleCopy === copy) settleCopy = undefined
  })()
  return copy.written
}

/** ensureReady, then settle a switch that no classic.SessionStart reported. Resolves what ensureReady resolves. */
async function ensureCurrent($: EngineInterface, event: string, withLanes: boolean, write: CopyWrite = 'await'): Promise<boolean> {
  if (!(await ensureReady($, event))) return false
  if (pending !== undefined) await settle($, event, withLanes, write)
  return true
}

/**
 * Settles a pending switch before a slash command or a /config change goes on (settle), then waits until the copy of
 * the inbox that a settle writes has landed (settleCopy), LIMITS.settleWaitMs at most. Either can reload the mod, as
 * /reload-plugins and a change of an option do: the reload empties module memory, and Claude Code reset `$.state` at
 * the switch, so the copy must be in `$.state` first. A copy that a drawing left to its timer is written here at once.
 * With no switch pending and no copy under way, it calls nothing and waits for nothing.
 */
async function settleFirst($: EngineInterface, event: string, withLanes: boolean): Promise<void> {
  if (pending !== undefined) await ensureCurrent($, event, withLanes, 'start')
  const copy = settleCopy
  if (copy === undefined) return
  let passed = () => {}
  const deadline = new Promise<void>(resolve => { passed = resolve })
  const timer = $.clock.after(LIMITS.settleWaitMs, () => passed())
  try {
    await Promise.race([startCopy($, copy, event), deadline])
  } finally {
    timer.cancel()
  }
}

/** The timers of the last switch that session.end noted (watch). */
let watcher: Timer | undefined

/**
 * Settles the switch that session.end noted without waiting for another hook: on a surface with no band and with the
 * pane closed, none may come before a reload of the mod, which would find `$.state` reset and the inbox gone. It reads
 * `$.session.id()` (ensureCurrent) once at 0 ms, then every LIMITS.switchReadMs, one read at a time. It stops once the
 * switch settled, by these timers, another hook, or classic.SessionStart, and after LIMITS.switchReads periods. A newer
 * switch stops it.
 */
function watch($: EngineInterface, withLanes: boolean): void {
  watcher?.cancel()
  const waiting = pending
  if (waiting === undefined) return
  const timers: Timer[] = []
  const stop = () => { for (const timer of timers) timer.cancel() }
  let periods = 0
  let isReading = false
  const readId = () => {
    if (pending !== waiting) {
      stop()
      return
    }
    if (isReading) return
    isReading = true
    void ensureCurrent($, 'session.end', withLanes).finally(() => {
      isReading = false
      if (pending !== waiting) stop()
    })
  }
  timers.push($.clock.after(0, readId))
  timers.push($.clock.every(LIMITS.switchReadMs, () => {
    periods += 1
    if (periods > LIMITS.switchReads) {
      stop()
      return
    }
    readId()
  }))
  watcher = { cancel: stop }
}

/** The entries of the main inbox or of a lane, and the roster built from them, as `/highcommand` and the pane read them. */
function rosterIn(inbox: Inbox, laneId?: string): { list: HighCommandEntry[]; rows: RosterRow[] } {
  if (laneId !== undefined) {
    const lane = laneOf(inbox, laneId)
    return { list: lane.entries, rows: rosterOf(lane.entries, lane.peers, lane.readThrough) }
  }
  return { list: inbox.entries, rows: rosterOf(inbox.entries, inbox.peers, inbox.readThrough) }
}

/**
 * Appends fresh entries. The open thread closes when this append drops its peer from the window, so the pane shows
 * the roster and stays there when that peer writes again; keepsThread keeps a thread opened after this append.
 * `inboundThrough`, and a lane's own `inboundThrough`, keep the newest inbound seq after its entry leaves the window,
 * so a Hide that it outdates stays ended.
 */
function append(inbox: Inbox, fresh: readonly NewEntry[], at: number, laneId?: string): void {
  if (laneId !== undefined) {
    changeLane(inbox, laneId, lane => {
      const list = appendEntries(lane.entries, fresh, at)
      return {
        ...lane, entries: list, inboundThrough: Math.max(lane.inboundThrough ?? 0, newestUnreadableSeq(list)),
        openThread: lane.openThread === null || keepsThread(lane.openThread, lane.entries, list) ? lane.openThread : null,
      }
    })
    return
  }
  const before = inbox.entries
  const list = appendEntries(before, fresh, at)
  const open = inbox.openThread
  edit(inbox, {
    entries: list, inboundThrough: Math.max(inbox.inboundThrough, newestInboundSeq(list)),
    openThread: open === null || keepsThread(open, before, list) ? open : null,
  })
}

function saveReports(inbox: Inbox, reports: readonly PeerReport[], at: number, laneId?: string): void {
  if (laneId === undefined) edit(inbox, { peers: applyReports(inbox.peers, reports, at) })
  else changeLane(inbox, laneId, lane => ({ ...lane, peers: applyReports(lane.peers, reports, at) }))
}

/**
 * Records the entries and peer states of one queued delivery in `inbox`, and says in the debug log when it names no
 * sender. `event` is the hook that saw it: session.receive, or prompt.submit for a local agent's message. `sender`,
 * when given, files all of the delivery under that name, whatever names its text claims.
 */
function recordDelivery($: EngineInterface, inbox: Inbox, event: string, text: string, origin: SessionReceiveOrigin, at: number, laneId?: string, sender?: string): void {
  const parsed = parseDelivery(text, origin, sender)
  if (parsed.incomplete) diagnose($, `high-command: ${event}: incomplete frame parsing; consult the transcript for original framing`)
  if ([...parsed.entries, ...parsed.reports].some(item => item.peer === UNNAMED)) {
    $.ui.log(`${event}: a ${origin.kind} delivery named no sender; it shows as "${UNNAMED}"`, { to: 'debug' })
  }
  if (parsed.entries.length === 0 && parsed.reports.length === 0) return
  // In an agent lane, a coordinator delivery is the main conversation's own message to that agent: never unread.
  const fresh = laneId !== undefined && origin.kind === 'coordinator' ? parsed.entries.map(entry => ({ ...entry, fromMain: true as const })) : parsed.entries
  if (fresh.length > 0) append(inbox, fresh, at, laneId)
  if (parsed.reports.length > 0) saveReports(inbox, parsed.reports, at, laneId)
}

/** The local agents for a subagent message's sender label; a failure keeps the label and goes to the debug log. */
async function agentsForLabel($: EngineInterface): Promise<readonly AgentInfo[]> {
  try {
    return await $.agent.list()
  } catch (error) {
    $.ui.log(`prompt.submit: could not read local agents: ${causeOf(error)}; the message keeps the local sender label`, { to: 'debug' })
    return []
  }
}

/** Records the observed send attempt and its result in the inbox of `session`; an attempt to an agent with no name is left out. */
async function recordSend($: EngineInterface, session: string, to: string, text: string, sent: SessionSendResult, trace: readonly TraceEntry<'session.send'>[], at: number, laneId?: string): Promise<void> {
  const listed = await $.agent.list()
  const inbox = inboxes.get(session)
  if (inbox === undefined) return
  const lane = laneId === undefined ? undefined : laneOf(inbox, laneId)
  const peer = recipientOf(to, lane?.peers ?? inbox.peers, listed, lane?.entries ?? inbox.entries)
  if (peer === undefined) return
  append(inbox, [{ ...outboundEntry(peer, text, sent), core: coreEvidence(trace) }], at, laneId)
}

/** Records the peer states a ListAgents listing names in the inbox of `session`, or says in the debug log that no row gave one. */
async function recordListing($: EngineInterface, session: string, { reports, rowCount }: ReturnType<typeof parseListing>, laneId?: string): Promise<void> {
  reports.forEach(report => { report.source ??= 'formatted listing' })
  if (reports.length > 0) {
    const at = await $.clock.now()
    const inbox = inboxes.get(session)
    if (inbox !== undefined) saveReports(inbox, reports, at, laneId)
  } else if (rowCount > 0) {
    $.ui.log(
      `tool.call ListAgents: no listing row gave a peer state (${count(rowCount, 'row')} read); peer states are unchanged`,
      { to: 'debug' },
    )
  }
}

/** Opens the main inbox roster; answers why the pane is not drawn, or undefined when it is. */
async function openPane($: EngineInterface): Promise<string | undefined> {
  await refreshAgents($, 'ui.open')
  try { ensureCapture(inboxNow(), await $.clock.now()) } catch (error) { diagnose($, `high-command: ui.open: could not set capture window: ${causeOf(error)}`) }
  edit(inboxNow(), { selectedLane: '', rosterPage: 0, openThread: null })
  await publish($)
  const opened = await $.ui.open(PANE)
  return opened.isPlaced ? undefined : `the pane waits to be drawn: ${opened.reason}`
}

/** `/highcommand open`: the pane, or the reason there is none. */
async function openFromCommand($: EngineInterface): Promise<CommandRunResult> {
  try {
    if ((await $.session.surfaces()).length === 0) return { text: NO_PANES }
    const problem = await openPane($)
    return problem === undefined ? {} : { text: `command.run: ${problem}` }
  } catch (error) {
    return { text: `command.run: the pane did not open: ${causeOf(error)}` }
  }
}

/**
 * Runs a button's work; a failure becomes a toast that names the action. The press counts as the person's
 * own input only while its onPress work runs, so each handler returns this promise: a `$.ui.open` after
 * awaits is then asked, and the pane is placed at any width. A switch that no classic.SessionStart reported
 * settles first, so a press on a drawing of the conversation that ended does nothing (pressed).
 */
function press($: EngineInterface, action: string, withLanes: boolean, work: () => Promise<unknown>): Promise<void> {
  const run = pending === undefined ? work() : settle($, 'ui.press', withLanes).then(work)
  return run.then(() => undefined, (error: unknown) => $.ui.toast(`ui.press: ${action}: ${causeOf(error)}`))
}

/**
 * Marks `peer`, or every peer when none is given, read through its newest inbound entry that the drawing `drawn`
 * showed, in the lane `laneId` or the main inbox of `inbox`.
 */
function markPeersRead(inbox: Inbox, drawn: Drawn, peer?: string, laneId?: string): void {
  if (laneId !== undefined) changeLane(inbox, laneId, lane => ({ ...lane, readThrough: markRead(lane.readThrough, seenOf(lane.entries, drawn.through), peer) }))
  else edit(inbox, { readThrough: markRead(inbox.readThrough, seenOf(inbox.entries, drawn.through), peer) })
}

/**
 * What a press changes, for the status line: read marks (`marks`), agent lane content (`lane`), which can evict lane
 * messages (fitLanes), or only the view (`view`).
 */
type PressKind = 'marks' | 'lane' | 'view'

/**
 * Refreshes the status line after a press of `kind`, then writes the mirror. Read marks count in the main inbox, and in
 * an agent lane only when the line counts agent lanes (`withLanes`); a lane change counts only then too. A failed
 * mirror write rejects, so the press shows it.
 */
async function afterPress($: EngineInterface, kind: PressKind, laneId: string | undefined, withLanes: boolean): Promise<void> {
  const counts = kind === 'marks' ? laneId === undefined || withLanes : kind === 'lane' && laneId !== undefined && withLanes
  if (counts) syncStatus($, 'ui.press', false, withLanes)
  await publish($)
}

/**
 * Moves the pane's focus ring onto the element `key` after a view change, so the person keeps their place. The keys
 * are the person's to give: a site that does not hold them refuses, and the view change stands.
 */
async function focusOn($: EngineInterface, key: string | undefined): Promise<void> {
  if (key === undefined) return
  try {
    await $.ui.focus({ requestId: PANE.id, key })
  } catch {
    // Refused: the person holds the keys elsewhere, or the element is gone. Nothing to report.
  }
}

/**
 * Shows the roster page that draws `peer`'s row and returns that row's key. The thread can move the row to another
 * page: opening it marks the peer read, which sorts it behind the unread peers. Without the row (its messages left the
 * window), the page stays and there is no key.
 */
function showPeerRow(inbox: Inbox, laneId: string | undefined, peer: string): string | undefined {
  const { rows } = rosterIn(inbox, laneId)
  const page = rosterPageOf(rows, peer)
  if (page === undefined) return undefined
  if (laneId === undefined) edit(inbox, { rosterPage: page })
  else changeLane(inbox, laneId, lane => ({ ...lane, rosterPage: page }))
  return peerKeys(rows.map(row => row.peer)).get(peer)
}

/** Whether the lane page shown draws the agent `id`'s lane Button. */
function isLaneShown(inbox: Inbox, id: string): boolean {
  const all = Object.values(agents)
  return laneIdsShown(laneIdsOf(Object.keys(inbox.lanes), all), inbox.lanePage, all).includes(id)
}

/** Where the ring goes once the lane `id` ('' for the main inbox) shows: Back of its open thread, else `key`. */
function laneFocus(inbox: Inbox, id: string, key: string): string {
  const open = id === '' ? inbox.openThread : laneOf(inbox, id).openThread
  return open === null ? key : 'pane:back'
}

/**
 * The pane's buttons. Each acts on the inbox its drawing showed (`drawn`), and does nothing once another conversation
 * or another inbox is current (pressed).
 */
function paneActions($: EngineInterface, withLanes: boolean, drawn: Drawn, laneId?: string): PaneActions {
  /**
   * Runs `change` on the drawn inbox, then refreshes the status line and writes the mirror (afterPress); nothing once
   * the inbox changed. `change` answers the key that the focus ring moves to, if any.
   */
  const act = (action: string, kind: PressKind, change: (inbox: Inbox) => string | undefined | void) => press($, action, withLanes, async () => {
    const inbox = pressed(drawn)
    if (inbox === undefined) return
    const key = change(inbox)
    await afterPress($, kind, laneId, withLanes)
    if (typeof key === 'string') await focusOn($, key)
  })
  return {
    openThread: peer => act('open thread', 'marks', inbox => {
      const marks = laneId === undefined ? inbox.readThrough : laneOf(inbox, laneId).readThrough
      changeThread(inbox, laneId, () => ({ peer, since: markOf(marks, peer), from: drawn.through }))
      markPeersRead(inbox, drawn, peer, laneId)
      return 'pane:back'
    }),
    // Up one level, to the roster page that draws the peer that was open, with the ring on its row.
    back: () => act('back', 'lane', inbox => {
      const closed: { peer?: string } = {}
      changeThread(inbox, laneId, open => {
        closed.peer = open?.peer
        return null
      })
      return closed.peer === undefined ? undefined : showPeerRow(inbox, laneId, closed.peer)
    }),
    markRead: peer => act('mark read', 'marks', inbox => markPeersRead(inbox, drawn, peer, laneId)),
    readAll: () => act('read all', 'marks', inbox => markPeersRead(inbox, drawn, undefined, laneId)),
    page: page => act('page', 'lane', inbox => changeThread(inbox, laneId, open => open === null ? null : { ...open, page })),
    // Opening the Identity level puts the ring on its Back; closing it puts the ring back on Show identity.
    identity: identityPage => act('identity', 'lane', inbox => {
      const before: { wasOpen?: boolean } = {}
      changeThread(inbox, laneId, open => {
        before.wasOpen = open?.identityPage !== undefined
        return open === null ? null : { ...open, identityPage }
      })
      if (identityPage === undefined) return 'pane:identity'
      return before.wasOpen === false ? 'pane:back' : undefined
    }),
    reason: reasonSeq => act('send details', 'lane', inbox => changeThread(inbox, laneId, open => open === null ? null : { ...open, reasonSeq: open.reasonSeq === reasonSeq ? undefined : reasonSeq })),
    lane: id => act('select lane', 'view', inbox => {
      edit(inbox, { selectedLane: id })
      return laneFocus(inbox, id, id === '' ? 'lane:main' : `lane:${id}`)
    }),
    // Up one level from an agent lane, to the main inbox, with the ring on the Button of the lane that was open.
    leaveLane: () => act('back', 'view', inbox => {
      edit(inbox, { selectedLane: '' })
      return laneFocus(inbox, '', laneId !== undefined && isLaneShown(inbox, laneId) ? `lane:${laneId}` : 'lane:main')
    }),
    rosterPage: page => act('peer page', 'lane', inbox => {
      if (laneId === undefined) edit(inbox, { rosterPage: page })
      else changeLane(inbox, laneId, lane => ({ ...lane, rosterPage: page }))
    }),
    lanePage: page => act('agent page', 'view', inbox => edit(inbox, { lanePage: page })),
    agentStatus: () => act('agent status', 'view', inbox => edit(inbox, { agentStatus: !inbox.agentStatus })),
  }
}

/**
 * The band's buttons; with agentLanesInBand (`withLanes`), Read all and Hide also cover agent lanes. Read all and Hide
 * cover what the drawing `drawn` showed, and do nothing once another conversation or another inbox is current.
 */
function bandActions($: EngineInterface, withLanes: boolean, drawn: Drawn): BandActions {
  return {
    open: () =>
      press($, 'the pane did not open', withLanes, async () => {
        const problem = await openPane($)
        if (problem !== undefined) $.ui.toast(`ui.press: ${problem}`)
      }),
    readAll: () =>
      press($, 'read all', withLanes, async () => {
        const inbox = pressed(drawn)
        if (inbox === undefined) return
        if (withLanes) changeLanes(inbox, (lane, id) => ({ ...lane, readThrough: markRead(lane.readThrough, seenOf(lane.entries, drawn.lanes.get(id) ?? 0)) }))
        markPeersRead(inbox, drawn)
        await afterPress($, 'marks', undefined, withLanes)
      }),
    hide: () =>
      press($, 'hide', withLanes, async () => {
        const inbox = pressed(drawn)
        if (inbox === undefined) return
        if (withLanes) setLanes(inbox, inbox.lanes, hideLanes(inbox.hiddenLanes, drawn.lanes))
        edit(inbox, { hiddenThrough: Math.max(inbox.hiddenThrough, drawn.through) })
        await publish($)
      }),
  }
}

export const register: Register = (on, options) => {
  /** The `agentLanesInBand` option: the band and the status line add the unread count of all agent lanes. */
  const withLanes = options.agentLanesInBand === true

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'highcommand', description: DESCRIPTION, argumentHint: '[open]', immediate: true })
    } catch (error) {
      diagnose($, `high-command: session.start: could not register /highcommand: ${causeOf(error)}`)
    }
    if (!(await ensureCurrent($, 'session.start', withLanes))) return next(e)
    try { ensureCapture(inboxNow(), await $.clock.now()) } catch (error) { diagnose($, `high-command: session.start: could not set capture window: ${causeOf(error)}`) }
    syncStatus($, 'session.start', true, withLanes)
    await mirror($, 'session.start')
    return next(e)
  })

  // At /clear, /resume, and /branch, Claude Code runs session.end, then resets $.state, then runs classic.SessionStart.
  // The inbox stays in module memory, so the hook only remembers the session that ends: the parent of a branch. It
  // also notes the switch for settle, in case no classic.SessionStart comes, and starts the timers that settle it once
  // the id changed (watch). Any other reason is an exit with no switch after it, so the hook does nothing then.
  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear' && e.reason !== 'resume') return next(e)
    pending = { reason: e.reason, ended: e.sessionId }
    settled = undefined
    await ensureReady($, 'session.end')
    lastEnded = e.sessionId
    laneMirror = undefined
    watch($, withLanes)
    return next(e)
  })

  // Any source sets the current session from `e.session_id`: at a branch, `$.session.id()` still answers the parent
  // here. A branch copies its parent's inbox (the session that ended last), a resume takes its own inbox back when
  // this process kept it, and a clear, or a resume or branch with nothing kept, starts a new empty inbox. Then the hook
  // writes the mirror again, so the last mirror write after the switch holds the new conversation's inbox. When settle
  // already moved to this conversation, the hook changes no inbox: settle gave the same one, and what was recorded
  // since then stays.
  on('classic.SessionStart', async ($, e, next) => {
    const isSwitch = e.source === 'fork' || e.source === 'resume' || e.source === 'clear'
    if (!(await ensureReady($, 'classic.SessionStart'))) {
      if (!isSwitch) return next(e)
      // The copy that could not be read is the inbox of the conversation that ended, so the next one may write its own.
      ready = Promise.resolve(true)
      isAdopted = true
    }
    const id = e.session_id
    if (isSwitch) {
      const isSettled = settled === id
      pending = undefined
      settled = undefined
      if (isSettled) {
        lastEnded = undefined
        syncStatus($, 'classic.SessionStart', false, withLanes)
        await mirror($, 'classic.SessionStart')
        return next(e)
      }
    }
    const parent = e.source === 'fork' && lastEnded !== undefined ? inboxes.get(lastEnded) : undefined
    const known = e.source === 'resume' ? inboxes.get(id) : undefined
    if (isSwitch) lastEnded = undefined
    current = id
    laneMirror = undefined
    const inbox = keep(id, parent !== undefined ? branchOf(parent) : known !== undefined ? startOver(known) : isSwitch ? emptyInbox() : inboxOf(id))
    // A branch counts what it copied, in the same moment: the parent can record more while the clock answers.
    const copied = parent === undefined ? undefined : {
      window: inbox.capture, messages: inbox.entries.length + Object.values(inbox.lanes).reduce((sum, lane) => sum + lane.entries.length, 0),
    }
    try {
      const now = await $.clock.now()
      if (copied !== undefined) {
        const window = copied.window ?? { at: now, reset: true }
        edit(inbox, { capture: { ...window, branch: { at: now, messages: copied.messages, depth: (window.branch?.depth ?? 0) + 1 } } })
      } else if (isSwitch && known === undefined) edit(inbox, { capture: { at: inbox.capture?.at ?? now, reset: true } })
      else ensureCapture(inbox, now)
    } catch (error) {
      diagnose($, `high-command: classic.SessionStart: could not set capture window: ${causeOf(error)}`)
    }
    syncStatus($, 'classic.SessionStart', parent !== undefined || known !== undefined, withLanes)
    await mirror($, 'classic.SessionStart')
    return next(e)
  })

  on('session.receive', async ($, e, next) => {
    if (!MESSAGE_ORIGINS.has(e.origin.kind)) return next(e)
    if (!(await ensureCurrent($, 'session.receive', withLanes))) return next(e)
    // The message belongs to the conversation that is current as it arrives, even when a switch comes before it records.
    const session = current ?? ''
    let at: number | undefined
    try { at = await $.clock.now(); ensureCapture(inboxOf(session), at) } catch (error) { diagnose($, `high-command: session.receive: could not observe delivery time: ${causeOf(error)}`) }
    const queued = await next(e)
    if (queued.consumed !== undefined) return queued
    const inbox = inboxes.get(session)
    try {
      if (at !== undefined && inbox !== undefined) recordDelivery($, inbox, 'session.receive', queued.text, e.origin, at, e.agentId)
    } catch (error) {
      diagnose($, `high-command: session.receive: could not record a delivery (${e.origin.kind}): ${causeOf(error)}`)
    }
    if (e.agentId === undefined || withLanes) syncStatus($, 'session.receive', false, withLanes)
    await mirror($, 'session.receive')
    return queued
  })

  // In Claude Code 2.1.296 a named subagent's SendMessage to the main conversation skips session.receive:
  // Claude Code submits its <agent-message> as a peer prompt, while the session is idle or into a running
  // turn. A message from another session passed session.receive first, so only an agent message counts here.
  // A mod beneath can rewrite it without the frame; the text that entered is then filed under the one sender
  // that the frames named, or under `unnamed peer`, and a name that the rewritten text claims does not count.
  // The prompt's origin does not say whether a mod started the sender, so the local agent list can lower its label;
  // the list is read before the mods beneath run, while an agent that ends meanwhile is still listed.
  on('prompt.submit', { origin: { kind: 'peer' } }, async ($, e, next) => {
    if (!isAgentMessage(e.text)) return next(e)
    if (!(await ensureCurrent($, 'prompt.submit', withLanes))) return next(e)
    const session = current ?? ''
    let at: number | undefined
    try { at = await $.clock.now(); ensureCapture(inboxOf(session), at) } catch (error) { diagnose($, `high-command: prompt.submit: could not observe delivery time: ${causeOf(error)}`) }
    const named = agentSenderOf(e.text, e.origin)
    const listed = named === undefined ? undefined : agentsForLabel($)
    const entered = await next(e)
    if (entered.drop !== undefined) return entered
    try {
      if (at !== undefined) {
        let sender: string | undefined
        if (!isAgentMessage(entered.text)) {
          sender = named
          const filing = sender === undefined ? `its frames named no single sender, so it is filed under "${UNNAMED}"` : 'it is filed under the sender that the frame named'
          $.ui.log(`prompt.submit: a mod rewrote a subagent message without its <agent-message> frame; ${filing}`, { to: 'debug' })
          sender ??= UNNAMED
        }
        const plugin = named === undefined || listed === undefined ? undefined : spawnerOf(await listed, named)
        const origin = plugin === undefined ? e.origin : { kind: 'peer' as const, plugin }
        const inbox = inboxes.get(session)
        if (inbox !== undefined) recordDelivery($, inbox, 'prompt.submit', entered.text, origin, at, undefined, sender)
      }
    } catch (error) {
      diagnose($, `high-command: prompt.submit: could not record a delivery (${e.origin.kind}): ${causeOf(error)}`)
    }
    syncStatus($, 'prompt.submit', false, withLanes)
    await mirror($, 'prompt.submit')
    return entered
  })

  on('session.send', async ($, e, next) => {
    if (e.origin.kind !== 'model') return next(e)
    if (!(await ensureCurrent($, 'session.send', withLanes))) return next(e)
    const session = current ?? ''
    let at: number | undefined
    try { at = await $.clock.now(); ensureCapture(inboxOf(session), at) } catch (error) { diagnose($, `high-command: session.send: could not observe send time: ${causeOf(error)}`) }
    const sent = await next(e)
    try {
      if (at !== undefined) {
        await recordSend($, session, e.to, e.text, sent, next.trace, at, e.agentId)
      }
    } catch (error) {
      diagnose($, `high-command: session.send: could not record a message to ${sanitize(e.to)}: ${causeOf(error)}`)
    }
    if (e.agentId === undefined || withLanes) syncStatus($, 'session.send', false, withLanes)
    await mirror($, 'session.send')
    return sent
  })

  on('tool.call', { tool: 'ListAgents' }, async ($, e, next) => {
    if (!(await ensureCurrent($, 'tool.call ListAgents', withLanes))) return next(e)
    const session = current ?? ''
    const out = await next(e)
    const result: unknown = out.isError === true ? undefined : out.result
    const structured = parseStructuredListing(result)
    const listing = typeof result === 'object' && result !== null && 'listing' in result ? result.listing : undefined
    if (structured === undefined && typeof listing !== 'string') return out
    try {
      if (structured !== undefined) {
        await recordListing($, session, structured, e.agentId)
      } else if (typeof listing === 'string') await recordListing($, session, parseListing(listing), e.agentId)
    } catch (error) {
      diagnose($, `high-command: tool.call ListAgents: could not record peer states: ${causeOf(error)}`)
    }
    // Peer states make a lane longer, so fitLanes can evict lane messages.
    if (e.agentId !== undefined && withLanes) syncStatus($, 'tool.call ListAgents', false, true)
    await mirror($, 'tool.call ListAgents')
    return out
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (!(await ensureCurrent($, 'agent.spawn', withLanes))) return result
    await refreshAgents($, 'agent.spawn')
    await mirror($, 'agent.spawn')
    return result
  })

  // A main turn records nothing, but the first one after a switch that no classic.SessionStart reported settles it.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && pending === undefined) return result
    if (await ensureCurrent($, 'turn.complete', withLanes) && e.agentId !== undefined) {
      await refreshAgents($, 'turn.complete')
      try {
        const at = await $.clock.now()
        const observed = new Map(Object.entries(agents))
        const agent = observed.get(e.agentId)
        const word = e.reason === 'answer' ? 'turn answered' : `turn ${e.reason}`
        if ((agent?.lastEvent?.at ?? -Infinity) <= at) observed.set(e.agentId, {
          ...agent, id: e.agentId, status: agent?.status ?? word, at: agent?.at ?? at,
          source: agent?.source ?? 'lifecycle observation', lastEvent: { word, at },
        })
        agents = Object.fromEntries(observed)
        changes += 1
      } catch (error) { diagnose($, `high-command: turn.complete: could not record lifecycle observation: ${causeOf(error)}`) }
      await mirror($, 'turn.complete')
    }
    return result
  })

  // Every slash command, /highcommand included, settles a pending switch first and waits for the copy of the inbox
  // that a settle writes, also one that a drawing left to its timer, then runs as typed: a command can reload the mod,
  // as /reload-plugins does (settleFirst). With no switch pending and no copy under way, the hook calls nothing.
  on('command.run', async ($, e, next) => {
    await settleFirst($, 'command.run', withLanes)
    return next(e)
  })

  // Every /config change does the same first: a change of an option reloads the mod (settleFirst). The change then
  // goes on as it came: the hook never refuses it and never changes its value.
  on('config.set', async ($, e, next) => {
    await settleFirst($, 'config.set', withLanes)
    return next(e)
  })

  on('command.run', { command: 'highcommand' }, async ($, e) => {
    const argument = e.args.trim()
    if (!(await ensureCurrent($, 'command.run', withLanes))) return { text: 'command.run: could not take back the inbox from $.state' }
    if (argument === 'open') return openFromCommand($)
    if (argument !== '') return { text: USAGE }
    try {
      await refreshAgents($, 'command.run')
      const now = await $.clock.now()
      const inbox = inboxNow()
      ensureCapture(inbox, now)
      const { list, rows } = rosterIn(inbox)
      const text = summaryText(rows, list.length, now, { evicted: list.at(-1)?.evictedTotal, capture: inbox.capture, agents: Object.values(agents), lanes: inbox.lanes })
      await mirror($, 'command.run')
      return { text }
    } catch (error) {
      return { text: `command.run: could not build the summary: ${causeOf(error)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: 'high-command' }, async ($, e) => {
    const ui = $.ui.resolve(e)
    try {
      if (!(await ensureCurrent($, 'ui.render', withLanes, 'timer'))) throw new Error('could not take back the inbox from $.state')
      await read($, view)
      const inbox = inboxNow()
      const chosen = inbox.selectedLane
      const laneId = chosen === '' ? undefined : chosen ?? e.props.view.agentId
      const { list, rows } = rosterIn(inbox, laneId)
      const lane = laneId === undefined ? undefined : laneOf(inbox, laneId)
      const thread = threadOf(list, rows, lane === undefined ? inbox.openThread : lane.openThread)
      const drawn = drawnOf(inbox, list)
      const laneIds = Object.keys(inbox.lanes)
      const laneUnread = new Map(Object.entries(inbox.lanes).map(([id, known]) => [id, unreadTotal(rosterOf(known.entries, {}, known.readThrough))]))
      const now = await $.clock.now()
      return paneTree(ui, { rows, now, thread, laneId, rosterPage: lane === undefined ? inbox.rosterPage : lane.rosterPage, lanePage: inbox.lanePage,
        laneIds, agents: Object.values(agents), laneUnread, capture: inbox.capture, evicted: list.at(-1)?.evictedTotal ?? 0,
        columns: e.props.bodyColumns, statusOpen: inbox.agentStatus,
      }, paneActions($, withLanes, drawn, laneId))
    } catch (error) {
      const { Text } = ui
      return <Text color="red">{`high-command: ui.render (Pane): ${causeOf(error)}`}</Text>
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const below = await next(e)
    if (!(await ensureCurrent($, 'ui.render', withLanes, 'timer'))) return below
    await read($, view)
    const inbox = inboxNow()
    const list = inbox.entries
    // A Hide holds while the person had seen every inbound entry: those in the window and those recorded before.
    const isHidden = inbox.hiddenThrough >= Math.max(inbox.inboundThrough, newestInboundSeq(list))
    // With agentLanesInBand, it holds only while the person had also seen each agent lane's newest unread entry.
    const all = withLanes ? inbox.lanes : {}
    if (isHidden && (!withLanes || lanesSeen(all, inbox.hiddenLanes))) return below
    const rows = rosterOf(list, {}, inbox.readThrough)
    const waiting = rows.filter(row => row.unread > 0)
    const laneUnread = withLanes ? lanesUnread(all) : 0
    if (waiting.length === 0 && laneUnread === 0) return below
    // Other mods draw `below`; when the band would push it past the engine's bounds, it drops the key hint, then
    // keeps only the counts and Open, then yields.
    const ui = $.ui.resolve(e)
    const actions = bandActions($, withLanes, drawnOf(inbox, list))
    const labels = peerLabels(rows.map(row => row.peer))
    const columns = e.props.bodyColumns
    const bands = [
      () => bandTree(ui, waiting, actions, below, labels, laneUnread, columns),
      () => bandTree(ui, waiting, actions, below, labels, laneUnread),
      () => compactBandTree(ui, waiting, actions, below, laneUnread, columns),
      () => compactBandTree(ui, waiting, actions, below, laneUnread),
    ]
    for (const draw of bands) {
      const band = draw()
      if (fitsBounds(band)) return band
    }
    return below
  })
}
