/** A peer's last reported state. */
export type HighCommandState = {
  /** 'idle', 'interrupted', 'failed', 'ended', 'shut down', or a ListAgents state word. */
  word: string
  source?: string
  /** $.clock.now() when the state was reported. */
  at: number
}

/**
 * How far Claude Code vouches for an inbound sender name: 'verified' for a team mailbox
 * entry the harness wrote under that name, 'local' for another session's or agent's message that Claude
 * Code delivered, 'unverified' for every other origin, a name only a plugin claims included.
 */
export type HighCommandTrust = 'verified' | 'local' | 'unverified'

/** One receive observation ('in') or send attempt ('out') in its conversation lane. */
export type HighCommandEntry = {
  /** Lane-unique and increasing from 1: the recording order. */
  seq: number
  /** The full normalized peer identity: the thread this entry belongs to. */
  peer: string
  direction: 'in' | 'out'
  /** 'result': a teammate's final answer. 'failure': a teammate's failure. */
  kind: 'message' | 'result' | 'failure'
  /** One line, at most LIMITS.summaryChars characters. */
  summary: string
  /** The sanitized body, cut at LIMITS.bodyChars characters. */
  body: string
  /** The length of the sanitized body before the cut. */
  fullChars: number
  /** $.clock.now() when High Command observed the event. */
  at: number
  /** Inbound entries only: the trust level of the sender name, set from origin fields alone. */
  trust?: HighCommandTrust
  /** Inbound entries only: the text matches the suspicious-text list; a display mark. */
  isSuspicious?: true
  /** Agent lane inbound entries only: the main conversation's own message to that agent, never unread. */
  fromMain?: true
  /** Cumulative retention loss, carried atomically by the newest recorded entry. */
  evictedTotal?: number
  /** The detailed refusal, bounded separately from its one-line preview. */
  refusal?: { body: string; fullChars: number }
  /** Evidence from the latest downstream call only, never a complete send history. */
  core?: { to: string; body: string; fullChars: number; isDelivered: boolean; reason?: string }
  /** Outbound entries only: the reported outcome, separate from core evidence. */
  delivery?: { isDelivered: true } | { isDelivered: false; reason: string }
}

/** What High Command knows about a peer besides its messages. */
export type HighCommandPeer = {
  /** $.clock.now() of the last report about this peer; the peer cap keeps the newest. */
  seenAt: number
  state?: HighCommandState
  /** The `from` address the newest cross-session frame named for this peer, and $.clock.now() when it was reported. */
  address?: {
    value: string
    at: number
    /** Address observation order for timestamp ties; absent in older saved state. */
    order?: number
  }
}

/** The thread the pane shows, with the peer's read mark from the moment it opened. */
export type HighCommandThread = {
  peer: string
  page?: number
  identityPage?: number
  reasonSeq?: number
  /** Inbound entries with a higher seq draw as new while the thread stays open. */
  since: number
  /** The newest seq when the person opened the thread: an append that it saw never closes it. */
  from: number
}

export type HighCommandLane = {
  rosterPage?: number
  entries: HighCommandEntry[]
  peers: Record<string, HighCommandPeer>
  readThrough: Record<string, number>
  openThread: HighCommandThread | null
  /**
   * The seq of the newest entry recorded that can be unread; it only grows and outlives the entry's eviction.
   * Absent before the lane's first append.
   */
  inboundThrough?: number
}

export type HighCommandAgent = {
  id: string
  name?: string
  status: string
  at: number
  source: 'roster snapshot' | 'lifecycle observation'
  lastEvent?: { word: string; at: number }
}

/**
 * The capture window: when it began, and whether it began after a reset that dropped earlier history. A branch keeps
 * its parent's window, and `branch` says when it branched and how many kept messages it took from the parent. `depth`
 * counts the /branch steps from the conversation where the window began: 1 for its branch, 2 for a branch of that.
 */
export type HighCommandCapture = { at: number; reset: boolean; branch?: { at: number; messages: number; depth: number } }

/**
 * The copy of one conversation's inbox that `$.state` holds: what a reload of the mod takes back. The hooks module keeps
 * the inbox itself in memory, and the pane and the band draw from there. `session` and `epoch` name the inbox it copies.
 */
export type HighCommandView = {
  session: string
  /** The number of the inbox in the module that wrote it; a branch copy and a fresh inbox each take a new one. */
  epoch: number
  /** Grows with each write: Claude Code draws the pane and the band again when it changes. */
  revision: number
  entries: HighCommandEntry[]
  peers: Record<string, HighCommandPeer>
  readThrough: Record<string, number>
  /** The newest seq that a press of Hide had seen; 0 before any press. It only grows. */
  hiddenThrough: number
  /** The seq of the newest inbound entry recorded; it only grows and outlives the entry's eviction. */
  inboundThrough: number
  capture: HighCommandCapture | null
  openThread: HighCommandThread | null
  rosterPage: number
  selectedLane: string | null
  lanePage: number
  /** Whether the pane's Agent status block is open. */
  agentStatus: boolean
  /** The local agents of the process, which every conversation shows. */
  agents: Record<string, HighCommandAgent>
}

/** The copy of one conversation's agent lanes, apart from HighCommandView: each saved value has a size limit. */
export type HighCommandLaneView = {
  session: string
  epoch: number
  lanes: Record<string, HighCommandLane>
  /**
   * Per agent lane, the newest seq that a press of Hide had seen while agentLanesInBand is on; a mark only grows.
   */
  hiddenLanes: Record<string, number>
}

declare module 'claude-code' {
  interface PluginState {
    'high-command': {
      view: HighCommandView
      laneView: HighCommandLaneView
      // The values of 1.2.2, which kept the inbox in `$.state` itself. After an update, when neither copy above holds
      // anything, the module reads them once to take the inbox over, and never writes them.
      entries: HighCommandEntry[]
      peers: Record<string, HighCommandPeer>
      readThrough: Record<string, number>
      openThread: HighCommandThread | null
      hiddenThrough: number
      inboundThrough: number
      lanes: Record<string, HighCommandLane>
      hiddenLanes: Record<string, number>
      capture: HighCommandCapture | null
      selectedLane: string | null
      lanePage: number
      agentStatus: boolean
      rosterPage: number
      agents: Record<string, HighCommandAgent>
    }
  }
}
