/** Every bound of High Command, in one place. */
export const LIMITS = {
  /** Entries kept in all; the oldest drop first. */
  entries: 200,
  /** Entries kept for one peer; a busy peer drops its own oldest entries first. */
  peerEntries: 50,
  /** Characters of JSON text that one agent lane's entries keep; past it, that lane drops its own oldest entries first. */
  laneChars: 500_000,
  /**
   * Characters of JSON text that all agent lanes keep together: their copy in `$.state` is one value, and Claude Code
   * 2.1.296 refuses a value over 4,194,304 characters. Past it, the entries observed first drop; each lane keeps its newest.
   */
  lanesChars: 4_000_000,
  /** Characters of JSON text in one saved value that Claude Code 2.1.296 accepts: a `$.state` value past it is refused. */
  savedChars: 4_194_304,
  /** Peers kept; the ones reported least recently drop first. */
  peers: 100,
  /**
   * Conversations besides the current one whose inbox the process keeps in module memory, for a branch or a resume;
   * the one used least recently drops first.
   */
  snapshots: 10,
  /** Milliseconds between two reads of the session id after a switch, after the read at 0 ms, until the switch settles (watch). */
  switchReadMs: 500,
  /** Periods of switchReadMs after a switch in which the session id is read at most: 600 of 500 ms take 5 minutes. */
  switchReads: 600,
  /** Milliseconds that a slash command or a /config change waits at most for the copy that a settled switch writes (settleFirst). */
  settleWaitMs: 2000,
  /** Characters of a body kept; the transcript keeps the rest. */
  bodyChars: 2000,
  /** Characters of a summary line. */
  summaryChars: 120,
  /** Characters of a displayed peer label; identity keys keep the full normalized name. */
  nameChars: 60,
  /** Characters of a ListAgents state word. */
  stateChars: 24,
  /** Peer rows on one roster page. */
  rosterRows: 50,
  /** Agent lane Buttons on one lane page of the pane. */
  laneButtons: 10,
  /** Entries drawn in one thread. */
  threadEntries: 20,
  /**
   * The engine's bounds on one drawing: characters of text, nodes (strings count), and depth. The engine
   * refuses a drawing past any of them, so the band checks the drawing it wraps against them.
   */
  drawingText: 100_000,
  drawingNodes: 20_000,
  drawingDepth: 32,
  /** Peers named in the band. */
  bandPeers: 3,
  /** Roster rows that get a digit hotkey. */
  hotkeys: 9,
  /**
   * Milliseconds after a result row that waits (a ListAgents call, and a SendMessage call whose text or input is not
   * enough) at which High Command reads its structured record from `$.session.messages()`. Claude Code stores the record
   * a moment after the row. After the last read, the call keeps the text that the model read.
   */
  lookupMs: [0, 50, 100, 250, 1000, 3000],
  /** Rows that one such read asks for when it cannot read on from the call's own response row. */
  lookupLast: 8,
  /**
   * The try of lookupMs from which a read asks for the newest lookupLast rows on its own: for a call whose response row
   * High Command did not see, and, besides the read on from that row, for a call whose result row is there with no
   * stored record. Before it, High Command asks for the newest rows only when the read on from the row is refused, and
   * for a call whose response row it did not see at a slash command or a /config change, which take its last read.
   */
  lookupLastFromMs: 250,
  /** Milliseconds that a delivery, a turn end, opening the pane, or the row's own hook waits at most for those reads. */
  lookupFirstMs: 2000,
  /** Milliseconds that a slash command or a /config change waits at most for those reads before it goes on. */
  lookupFlushMs: 1000,
  /** Result rows that wait for those reads at once; past it, the oldest keeps its text. */
  waitingRows: 256,
  /** Tool calls whose input High Command keeps until their result row comes. */
  rowInputs: 512,
  /** Tool calls that High Command remembers as recorded, so that none records twice. */
  rowsSeen: 2000,
  /** Local agents whose conversation High Command keeps, from the agent's first row. */
  rowAgents: 256,
  /** Milliseconds between two reads of the local agent list that agent rows cause. */
  agentReadMs: 1000,
} as const
