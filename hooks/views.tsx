import type { BoxProps, ButtonProps, ElementConstructor, RenderElement, TextProps } from 'claude-code'

import type { HighCommandAgent, HighCommandCapture, HighCommandEntry } from '../types'
import { isNewer, labelOf, unreadTotal, type RosterRow, type Thread } from './inbox'
import { LIMITS } from './limits'
import {
  BAND_KEY_HINT,
  PANE_KEY_HINT,
  cellWidth,
  clockLabel,
  count,
  dayLabel,
  firstLine,
  identityPart,
  isSameDay,
  lineOf,
  peerKeys,
  peerLabel,
  peerLabels,
  rosterState,
  threadState,
  timeLabel,
  trustLabel,
  unreadText,
} from './text'

/** The elements High Command draws with; every surface's table has them. */
type HighCommandElements = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
}

/** What the pane draws: a roster (the main inbox or an agent lane), a thread, or a peer's identity. */
type PaneModel = {
  rows: RosterRow[]; now: number; thread: Thread | undefined
  evicted?: number; capture?: HighCommandCapture | null
  rosterPage?: number; laneId?: string; laneIds?: string[]; lanePage?: number; agents?: HighCommandAgent[]
  /** Each agent lane's unread count, by agent id. */
  laneUnread?: ReadonlyMap<string, number>
  /** The body's cells across (Pane.bodyColumns). Without it, roster rows take two lines and no key hint shows. */
  columns?: number
  /** Whether the Agent status block is open. */
  statusOpen?: boolean
}

/**
 * Each action returns its work, and each Button's onPress returns the action's promise: a press stays the
 * person's own input only while that work runs.
 */
export type PaneActions = {
  openThread: (peer: string) => Promise<void>
  /** Back from a thread to the roster page that draws its peer. */
  back: () => Promise<void>
  markRead: (peer: string) => Promise<void>
  readAll: () => Promise<void>
  page: (page: number) => Promise<void>
  /** Opens the Identity view at a part, or closes it (undefined). */
  identity: (page: number | undefined) => Promise<void>
  reason: (seq: number) => Promise<void>
  /** Shows the main inbox ('') or an agent's lane. */
  lane: (id: string) => Promise<void>
  /** Back from an agent lane's roster to the main inbox. */
  leaveLane: () => Promise<void>
  lanePage: (page: number) => Promise<void>
  rosterPage: (page: number) => Promise<void>
  /** Opens or closes the Agent status block. */
  agentStatus: () => Promise<void>
}

export type BandActions = { open: () => Promise<void>; readAll: () => Promise<void>; hide: () => Promise<void> }

const ORDER_NOTE = 'Order: observation time. Counts cover retained messages.'
const LANE_NOTE = 'Split-pane traffic is not shown. Sent and received messages are observed separately.'
const LIVENESS_NOTE = 'Roster snapshots do not confirm liveness.'
const SEND_NOTE = 'Sends show observed text; a reported result is not a receipt.'
const CORE_NOTE = 'Core evidence covers only the latest traced call, never reading or every send.'
const NOT_DELIVERED = '(not delivered)'

/** Body cells from which the roster draws fixed columns; below it, each roster row takes two lines. */
const COLUMNS_FROM = 90
/**
 * The fixed roster columns: gutter and peer, New, Time, Sender, and Last state at its least; Last message takes the
 * rest. Last state widens to the longest state on the page while Last message keeps MESSAGE_CELLS.
 */
const CELLS = { peer: 19, fresh: 3, time: 6, sender: 10, state: 13 } as const
/**
 * Cells Last message keeps at least when Last state widens: both warning marks, which start it, and the cell that a
 * cut at its end draws as `…`, so no cut reaches a mark.
 */
const MESSAGE_CELLS = cellWidth(`suspicious ${NOT_DELIVERED}`) + 1
/** Cells the latest message keeps at least beside the marks on line 2 of a two-line row; with fewer, it takes line 3. */
const PREVIEW_CELLS = 20
/** Cells of a peer label in the fixed columns. */
const LABEL_CELLS = 16
/** The cells of `1: ` that a digit hotkey draws before a plain Button's label, and the gutter of rows without one. */
const GUTTER = 3

/** The defined parts, joined with ` · `. */
function joined(parts: readonly (string | undefined)[]): string {
  return parts.filter(part => part !== undefined).join(' · ')
}

/** The kept parts, each one or more inline nodes, with ` · ` between two. */
function dotted(parts: readonly (readonly (RenderElement | string)[] | false | undefined)[]): (RenderElement | string)[] {
  return parts.filter(part => part !== false && part !== undefined).flatMap((part, index) => (index === 0 ? [...part] : [' · ', ...part]))
}

/** The cells a plain Button with a hotkey draws: `h: label`. */
function plainCells(label: string): number {
  return GUTTER + cellWidth(label)
}

/** The cells a Button with chrome draws on the terminal: `[ label ]`. */
function chromeCells(label: string): number {
  return 4 + cellWidth(label)
}

/**
 * The engine refuses a drawing past 100,000 characters serialized and draws its own in place of the pane, so a roster
 * view keeps to about 90,000. Its peer rows take at most ROWS_BUDGET, the agents of its lane page at most LANES_BUDGET,
 * and the rest of the view less than the 8,000 left. A thread page keeps its own budget (threadOf). A page ends before
 * the row that would pass its budget and says how many rows moved to the next page.
 */
const ROWS_BUDGET = 70_000
const LANES_BUDGET = 12_000
const MOVED_NOTE = 'moved to the next page to keep the pane within its drawing limit.'

/** Characters of a tree serialized as the band's bounds check counts them: each handler as 256. */
function serialized(tree: unknown): number {
  return JSON.stringify(tree, (_key, value: unknown) => typeof value === 'function' ? 'handler'.padEnd(256, '_') : value).length
}

/** A Box's or a Text's children as a drawing holds them: one flat list, without the booleans and empty values. */
function flatChildren(node: unknown): unknown[] {
  return Array.isArray(node) ? node.flatMap(flatChildren) : node === false || node === true || node === null || node === undefined ? [] : [node]
}

/**
 * Elements as a drawing serializes them, each Button with a press handle of the longest number in place of its
 * handler: the budgets measure rows with these, outside any render, and so in every place that pages.
 */
const MEASURE: HighCommandElements = {
  Box: ({ children, ...props }) => ({ type: 'Box', props, children: flatChildren(children) }) as unknown as RenderElement,
  Text: ({ children, ...props }) => ({ type: 'Text', props, children: flatChildren(children) }) as unknown as RenderElement,
  Button: ({ onPress: _onPress, ...props }) => ({ type: 'Button', props, press: { plugin: 'high-command', handle: Number.MAX_SAFE_INTEGER } }) as unknown as RenderElement,
}

/** The first item of each page: at most `size` items, whose costs stay within `budget`; a page holds at least one. */
function pageStarts(costs: readonly number[], size: number, budget: number): number[] {
  const starts = [0]
  let used = 0
  costs.forEach((cost, index) => {
    const start = starts.at(-1)!
    if (index > start && (index - start >= size || used + cost > budget)) {
      starts.push(index)
      used = 0
    }
    used += cost
  })
  return starts
}

/**
 * The page shown of `length` items cut at `starts`, when `page` was asked: within the pages there are, with the
 * bounds of its items and how many of them moved on, up to `size`, because the page ended at its budget.
 */
function pageIn(starts: readonly number[], length: number, size: number, page: number | undefined): { page: number; pages: number; from: number; to: number; moved: number } {
  const shown = Math.max(0, Math.min(page ?? 0, starts.length - 1))
  const from = starts[shown]!
  const to = starts[shown + 1] ?? length
  return { page: shown, pages: starts.length, from, to, moved: to < length ? Math.min(size - (to - from), length - to) : 0 }
}

/** The dim note under a page that ended at its budget: how many `noun`s moved to the next page. */
function movedLine(Text: HighCommandElements['Text'], moved: number, noun: string): RenderElement | false {
  return moved > 0 && <Text dimColor wrap="wrap">{`${count(moved, noun)} ${MOVED_NOTE}`}</Text>
}

/**
 * The first row of each roster page: at most LIMITS.rosterRows rows, within ROWS_BUDGET. A row costs the most it can
 * draw in either layout, at any place on the page and at any time, so the pages stay the same at every width.
 */
function rosterStarts(rows: readonly RosterRow[]): number[] {
  const peers = rows.map(row => row.peer)
  const [narrow, wide, keys] = [peerLabels(peers), peerLabels(peers, LABEL_CELLS), peerKeys(peers)]
  const open = async () => {}
  const costs = rows.map(row => {
    // A time of another day draws the longest clock labels; a row past the ninth draws its gutter Box.
    const args = { row, index: LIMITS.hotkeys, key: keys.get(row.peer)!, now: 0, open }
    return Math.max(
      serialized(twoLineRow(MEASURE, { ...args, label: narrow.get(row.peer)! }, undefined)),
      serialized(twoLineRow(MEASURE, { ...args, label: narrow.get(row.peer)! }, COLUMNS_FROM - 1)),
      serialized(columnsRow(MEASURE, { ...args, label: wide.get(row.peer)! }, CELLS.state)),
    )
  })
  return pageStarts(costs, LIMITS.rosterRows, ROWS_BUDGET)
}

/** The roster page shown when `page` was asked. */
function rosterPageIn(rows: readonly RosterRow[], page: number | undefined) {
  return pageIn(rosterStarts(rows), rows.length, LIMITS.rosterRows, page)
}

/** The roster page that draws `peer`'s row; undefined when the roster has no row for it. */
export function rosterPageOf(rows: readonly RosterRow[], peer: string): number | undefined {
  const index = rows.findIndex(row => row.peer === peer)
  return index < 0 ? undefined : rosterStarts(rows).findLastIndex(start => start <= index)
}

/** Every agent the pane can show a lane for, in id order: each local agent and each agent with a lane. */
export function laneIdsOf(laneIds: readonly string[], agents: readonly HighCommandAgent[]): string[] {
  return [...new Set([...laneIds, ...agents.map(agent => agent.id)])].sort()
}

/**
 * The lane page shown when `lanePage` was asked: at most LIMITS.laneButtons agents, within LANES_BUDGET. An agent costs
 * its lane Button at its longest and its status line, so the pages stay the same whatever is open or unread.
 */
function lanePageIn(ids: readonly string[], lanePage: number | undefined, agents: readonly HighCommandAgent[]) {
  const known = new Map(agents.map(agent => [agent.id, agent]))
  const { Button, Text } = MEASURE
  const costs = ids.map(id => {
    const agent = known.get(id)
    const label = `▸ ${peerLabel(nameOf(agent) ?? id)} (${peerLabel(id)}) · ${Number.MAX_SAFE_INTEGER} unread`
    const status = agent === undefined ? '' : statusLine(agent, id, 0)
    return serialized(<Button key={`lane:${id}`} label={label} variant="primary" onPress={async () => {}} />) + serialized(<Text wrap="wrap">{status}</Text>)
  })
  return pageIn(pageStarts(costs, LIMITS.laneButtons, LANES_BUDGET), ids.length, LIMITS.laneButtons, lanePage)
}

/** The ids on the lane page shown. */
export function laneIdsShown(ids: readonly string[], lanePage: number | undefined, agents: readonly HighCommandAgent[] = []): string[] {
  const { from, to } = lanePageIn(ids, lanePage, agents)
  return ids.slice(from, to)
}

/**
 * An agent's name, or undefined when it has none. A name of only spaces or invisible characters is stored as '' (peerKey),
 * and counts as none, so the agent shows its id.
 */
function nameOf(agent: HighCommandAgent | undefined): string | undefined {
  return agent?.name === undefined || agent.name === '' ? undefined : agent.name
}

/** An agent as its status line and a lane's location name it: `name (id)`, or the id when it has no name. */
function agentName(agent: HighCommandAgent | undefined, id: string): string {
  const name = nameOf(agent)
  return name !== undefined && name !== id ? `${peerLabel(name)} (${peerLabel(id)})` : peerLabel(id)
}

/** The current place in a roster's location line: the main inbox or an agent's lane. */
function laneTitle(model: PaneModel): string {
  if (model.laneId === undefined) return 'Main inbox'
  return `Agent observations: ${agentName(model.agents?.find(agent => agent.id === model.laneId), model.laneId)}`
}

/**
 * Row 1 of every view: Back where there is a level above, a dim prefix that truncates from its start, the current place
 * in bold, and the dim key hint when the row and the hint fit `columns`, the band's rule. While the place fits the row
 * beside Back, it does not shrink, so the prefix takes the whole cut. A place wider than that may wrap, so it still
 * shows whole.
 */
function locationRow(
  { Box, Text, Button }: HighCommandElements,
  prefix: string,
  place: string,
  columns: number | undefined,
  back?: { onPress: () => Promise<void>; autoFocus: boolean },
): RenderElement {
  const backCells = back === undefined ? 0 : plainCells('Back') + 2
  const cells = backCells + cellWidth(prefix) + 1 + cellWidth(place)
  const hint = columns !== undefined && cells + 2 + cellWidth(PANE_KEY_HINT) <= columns
  const isKept = columns !== undefined && backCells + 1 + cellWidth(place) <= columns
  return (
    <Box flexDirection="row" columnGap={2}>
      {back !== undefined && <Button key="pane:back" label="Back" hotkey="b" plain {...(back.autoFocus ? { autoFocus: true as const } : {})} onPress={back.onPress} />}
      <Box flexDirection="row" columnGap={1}>
        <Text dimColor wrap="truncate-start">{prefix}</Text>
        {isKept ? <Box flexShrink={0}><Text bold>{place}</Text></Box> : <Text bold>{place}</Text>}
      </Box>
      {hint && <Box flexGrow={1} justifyContent="flex-end"><Text dimColor wrap="truncate-end">{PANE_KEY_HINT}</Text></Box>}
    </Box>
  )
}

/** The dim context line: when capture began, this conversation only, the order; after a reset, that history is gone. */
function contextLine(Text: HighCommandElements['Text'], model: PaneModel): RenderElement | false {
  const capture = model.capture
  return capture !== undefined && capture !== null && (
    <Text dimColor wrap="wrap">
      {`Since ${clockLabel(capture.at, model.now)} · this conversation only · observation order${capture.reset ? ' · earlier history not restored' : ''}`}
    </Text>
  )
}

/** The notice of messages dropped for good, at full strength: it says whether the list is complete. */
function evictedLine(Text: HighCommandElements['Text'], model: PaneModel): RenderElement | false {
  return (model.evicted ?? 0) > 0 && <Text>{`History trimmed: ${count(model.evicted!, 'message')} permanently evicted.`}</Text>
}

/** The verbatim order note, last and dim. */
function footer({ Box, Text }: HighCommandElements): RenderElement {
  return <Box marginTop={1}><Text dimColor wrap="wrap">{ORDER_NOTE}</Text></Box>
}

/** One pager row: the Button back, if any, the dim position, and the Button on, if any. */
function pagerRow({ Box, Text }: HighCommandElements, before: RenderElement | false, position: string, after: RenderElement | false, marginTop = 0): RenderElement {
  return (
    <Box flexDirection="row" columnGap={2} {...(marginTop > 0 ? { marginTop } : {})}>
      {before}
      <Text dimColor wrap="truncate-end">{position}</Text>
      {after}
    </Box>
  )
}

/** Whether the latest message is a send that was not delivered. */
function isRefused(last: HighCommandEntry): boolean {
  return labelOf(last).word.endsWith(NOT_DELIVERED)
}

/**
 * The latest message of a roster row: the arrow, the kind, then the summary. With `hasMark`, a send that was not
 * delivered starts with `(not delivered)`, in color `error`; without it, the row draws that mark with its others. On a
 * read row only the summary is dim: the arrow, the kind and the marks keep their strength, and no dim parent holds a mark.
 */
function messageSpans(Text: HighCommandElements['Text'], last: HighCommandEntry, isRead: boolean, hasMark: boolean): (RenderElement | string)[] {
  const { arrow, word } = labelOf(last)
  const kind = isRefused(last) ? word.slice(0, -NOT_DELIVERED.length - 1) : word
  return [
    ...(hasMark && isRefused(last) ? [<Text color="error">{NOT_DELIVERED}</Text>, ' '] : []),
    `${arrow} ${kind === 'message' ? '' : `${kind}: `}`,
    styled(Text, last.summary, isRead ? { dimColor: true } : {}),
  ]
}

/** A Text that holds `text`, styled; the plain string when it has no style. */
function styled(Text: HighCommandElements['Text'], text: string, props: TextProps): RenderElement | string {
  return Object.keys(props).length === 0 ? text : <Text {...props}>{text}</Text>
}

type RosterRowArgs = { row: RosterRow; index: number; label: string; key: string; now: number; open: () => Promise<void> }

/** A peer's Button: its digit for the first nine rows of a page, plain so the digit shows. */
function peerButton({ Button }: HighCommandElements, { index, label, key, open }: RosterRowArgs): RenderElement {
  return <Button key={key} label={label} plain {...(index < LIMITS.hotkeys ? { hotkey: String(index + 1) } : {})} onPress={open} />
}

/**
 * A roster row in two lines, below COLUMNS_FROM cells. Line 1: who, how many new, when, and the state, which a narrow
 * pane cuts first. Line 2, under the name: the marks first (the sender label, `suspicious`, `(not delivered)`), in a
 * Text of their own that wraps, so no width of `columns` cuts one; then the latest message, which alone is cut at its
 * end. It shares line 2 while the marks leave it PREVIEW_CELLS, and takes a line of its own otherwise.
 */
function twoLineRow(ui: HighCommandElements, args: RosterRowArgs, columns: number | undefined): RenderElement {
  const { Box, Text } = ui
  const { row, index, now } = args
  const isRead = row.unread === 0
  const dim: TextProps = isRead ? { dimColor: true } : {}
  const weight: TextProps = isRead ? {} : { bold: true }
  const state = rosterState(row.state, now)
  const trust = trustLabel(row.trust)
  const button = peerButton(ui, args)
  const marks = dotted([
    // Every sender label is plain text: in tmux each teammate's pane makes every message `unverified sender`, and a
    // color there would hide a real `suspicious`.
    trust !== undefined && [trust],
    row.isSuspicious && [<Text color="warning">suspicious</Text>],
    isRefused(row.last) && [<Text color="error">{NOT_DELIVERED}</Text>],
  ])
  const markCells = cellWidth(joined([trust, row.isSuspicious ? 'suspicious' : undefined, isRefused(row.last) ? NOT_DELIVERED : undefined]))
  const message = messageSpans(Text, row.last, isRead, false)
  const isShared = columns !== undefined && GUTTER + markCells + cellWidth(' · ') + PREVIEW_CELLS <= columns
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        {index < LIMITS.hotkeys ? button : <Box paddingLeft={GUTTER}>{button}</Box>}
        <Text {...weight} wrap="truncate-end">
          {dotted([
            row.unread > 0 && [<Text bold>{`${row.unread} new`}</Text>],
            [styled(Text, clockLabel(row.last.at, now), dim)],
            state !== undefined && [styled(Text, state, dim)],
          ])}
        </Text>
      </Box>
      {marks.length === 0 ? (
        <Box paddingLeft={GUTTER}><Text {...weight} wrap="truncate-end">{message}</Text></Box>
      ) : isShared ? (
        <Box flexDirection="row" paddingLeft={GUTTER}>
          <Box flexShrink={0}><Text {...weight} wrap="wrap">{marks}</Text></Box>
          <Text {...weight} wrap="truncate-end">{[' · ', ...message]}</Text>
        </Box>
      ) : [
        <Box paddingLeft={GUTTER}><Text {...weight} wrap="wrap">{marks}</Text></Box>,
        <Box paddingLeft={GUTTER}><Text {...weight} wrap="truncate-end">{message}</Text></Box>,
      ]}
    </Box>
  )
}

/**
 * The cells of Last state on a roster page: the longest state, at least CELLS.state, and at most what leaves Last
 * message MESSAGE_CELLS of `columns`. A state wider than that is cut at its end, so only a full row cuts a state.
 */
function stateCells(states: readonly (string | undefined)[], columns: number): number {
  const others = CELLS.peer + CELLS.fresh + CELLS.time + CELLS.sender + 5
  const longest = Math.max(0, ...states.map(state => (state === undefined ? 0 : cellWidth(state))))
  return Math.max(CELLS.state, Math.min(longest, columns - others - MESSAGE_CELLS))
}

/**
 * The dim header row over the fixed roster columns; `state` is the cells of Last state. A Box can shrink by default,
 * so each fixed cell sets `flexShrink={0}`: only Last message gives up room, as in each row (columnsRow).
 */
function columnsHeader({ Box, Text }: HighCommandElements, state: number): RenderElement {
  return (
    <Box flexDirection="row" columnGap={1}>
      <Box width={CELLS.peer} flexShrink={0} paddingLeft={GUTTER}><Text dimColor>Peer</Text></Box>
      <Box width={CELLS.fresh} flexShrink={0} justifyContent="flex-end"><Text dimColor>New</Text></Box>
      <Box width={CELLS.time} flexShrink={0} justifyContent="flex-end"><Text dimColor>Time</Text></Box>
      <Box width={CELLS.sender} flexShrink={0}><Text dimColor>Sender</Text></Box>
      <Box width={state} flexShrink={0}><Text dimColor>Last state</Text></Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0}><Text dimColor>Last message</Text></Box>
    </Box>
  )
}

/**
 * A roster row in fixed columns, from COLUMNS_FROM cells: the peer (its label cut to 16 cells), the unread count, the
 * time (the date alone on another day), the sender level, the state in `stateWidth` cells (stateCells), and the latest
 * message. Any `suspicious` and `(not delivered)` marks start it, within the MESSAGE_CELLS it always keeps. Each fixed
 * cell, the gutter and peer cell too, keeps its width (`flexShrink={0}`); only Last message shrinks, and is cut there.
 */
function columnsRow(ui: HighCommandElements, args: RosterRowArgs, stateWidth: number): RenderElement {
  const { Box, Text } = ui
  const { row, index, now } = args
  const isRead = row.unread === 0
  const dim: TextProps = isRead ? { dimColor: true } : {}
  const state = rosterState(row.state, now)
  return (
    <Box flexDirection="row" columnGap={1}>
      <Box width={CELLS.peer} flexShrink={0} {...(index < LIMITS.hotkeys ? {} : { paddingLeft: GUTTER })}>{peerButton(ui, args)}</Box>
      <Box width={CELLS.fresh} flexShrink={0} justifyContent="flex-end">{row.unread > 0 && <Text bold>{String(row.unread)}</Text>}</Box>
      <Box width={CELLS.time} flexShrink={0} justifyContent="flex-end">
        <Text {...dim}>{isSameDay(row.last.at, now) ? timeLabel(row.last.at) : dayLabel(row.last.at)}</Text>
      </Box>
      <Box width={CELLS.sender} flexShrink={0}>{row.trust !== undefined && <Text>{row.trust}</Text>}</Box>
      <Box width={stateWidth} flexShrink={0}>{state !== undefined && <Text {...dim} wrap="truncate-end">{state}</Text>}</Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text {...(isRead ? {} : { bold: true })} wrap="truncate-end">
          {row.isSuspicious && [<Text color="warning">suspicious</Text>, ' ']}
          {messageSpans(Text, row.last, isRead, true)}
        </Text>
      </Box>
    </Box>
  )
}

/** Puts items of known cells on rows of at most `columns` cells, `gap` cells apart; a row holds at least one. */
function packed<T>(items: readonly { cells: number; node: T }[], columns: number | undefined, gap: number): T[][] {
  if (columns === undefined) return [items.map(item => item.node)]
  const rows: T[][] = []
  let used = 0
  for (const { cells, node } of items) {
    const last = rows.at(-1)
    if (last !== undefined && used + gap + cells <= columns) {
      last.push(node)
      used += gap + cells
    } else {
      rows.push([node])
      used = cells
    }
  }
  return rows
}

/** An agent's status line behind Agent status: its status and source, with the time of each, at `now`. */
function statusLine(agent: HighCommandAgent, id: string, now: number): string {
  const at = (time: number) => clockLabel(time, now)
  const last = agent.lastEvent === undefined ? '' : ` · lifecycle observation: ${agent.lastEvent.word} at ${at(agent.lastEvent.at)}`
  return `${agentName(agent, id)}: ${agent.status} · ${agent.source} at ${at(agent.at)}${last}`
}

/**
 * The agent lanes, in roster views only: one row of lane Buttons, packed to the width so no row needs a wrap, the
 * current lane marked `▸` (and primary), the lane note, the statuses behind Agent status, the agents that moved to the
 * next page when this one ended at LANES_BUDGET, and one pager row.
 */
function laneSection(ui: HighCommandElements, model: PaneModel, actions: PaneActions): RenderElement | false {
  const { Box, Text, Button } = ui
  const agents = new Map((model.agents ?? []).map(agent => [agent.id, agent]))
  const ids = laneIdsOf(model.laneIds ?? [], model.agents ?? [])
  if (ids.length === 0) return false
  const { page, pages, from, to, moved } = lanePageIn(ids, model.lanePage, model.agents ?? [])
  const shown = ids.slice(from, to)
  // A label is the agent's name, or its id; ` (id)` only where two drawn Buttons would read the same.
  const names = shown.map(id => peerLabel(nameOf(agents.get(id)) ?? id))
  const label = (name: string, id: string) => (names.filter(other => other === name).length > 1 || name === 'Main inbox' ? `${name} (${peerLabel(id)})` : name)
  const main = `${model.laneId === undefined ? '▸ ' : ''}Main inbox`
  const status = model.statusOpen === true ? 'Hide agent status' : 'Agent status'
  const buttons = [
    { cells: plainCells(main), node: <Button key="lane:main" label={main} hotkey="m" plain onPress={() => actions.lane('')} /> },
    ...shown.map((id, index) => {
      const unread = model.laneUnread?.get(id) ?? 0
      const isCurrent = model.laneId === id
      const text = `${isCurrent ? '▸ ' : ''}${label(names[index]!, id)}${unread > 0 ? ` · ${unread} unread` : ''}`
      return { cells: chromeCells(text), node: <Button key={`lane:${id}`} label={text} {...(isCurrent ? { variant: 'primary' as const } : {})} onPress={() => actions.lane(id)} /> }
    }),
    { cells: chromeCells(status), node: <Button key="lanes:status" label={status} onPress={actions.agentStatus} /> },
  ]
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Agent lanes</Text>
      {packed(buttons, model.columns, 1).map(row => <Box flexDirection="row" flexWrap="wrap" columnGap={1}>{row}</Box>)}
      <Text dimColor wrap="wrap">{LANE_NOTE}</Text>
      {model.statusOpen === true && (
        <Box flexDirection="column" paddingLeft={2}>
          <Text dimColor wrap="wrap">{LIVENESS_NOTE}</Text>
          {shown.flatMap(id => {
            const agent = agents.get(id)
            return agent === undefined ? [] : [<Text wrap="wrap">{statusLine(agent, id, model.now)}</Text>]
          })}
        </Box>
      )}
      {movedLine(Text, moved, 'agent')}
      {pages > 1 && (
        <Box flexDirection="row" columnGap={1}>
          {page > 0 && <Button key="lanes:previous" label="Previous agents" onPress={() => actions.lanePage(page - 1)} />}
          {page + 1 < pages && <Button key="lanes:next" label="More agents" onPress={() => actions.lanePage(page + 1)} />}
          <Text dimColor wrap="truncate-end">{`agents ${from + 1}-${to} of ${ids.length}`}</Text>
        </Box>
      )}
    </Box>
  )
}

/**
 * The main inbox or an agent lane: location, counts, context, the peer rows, the peers that moved to the next page
 * when this one ended at ROWS_BUDGET, their pager, the agent lanes, the order note.
 */
function rosterView(ui: HighCommandElements, model: PaneModel, actions: PaneActions): RenderElement {
  const { Box, Text, Button } = ui
  const peers = model.rows.map(row => row.peer)
  const unread = unreadTotal(model.rows)
  const { page, pages, from, to, moved } = rosterPageIn(model.rows, model.rosterPage)
  const shown = model.rows.slice(from, to)
  const isWide = model.columns !== undefined && model.columns >= COLUMNS_FROM
  const stateWidth = isWide ? stateCells(shown.map(row => rosterState(row.state, model.now)), model.columns!) : CELLS.state
  const labels = peerLabels(peers, isWide ? LABEL_CELLS : undefined)
  const keys = peerKeys(peers)
  const back = model.laneId === undefined ? undefined : { onPress: actions.leaveLane, autoFocus: false }
  return (
    <Box flexDirection="column">
      {locationRow(ui, 'High Command ›', laneTitle(model), model.columns, back)}
      <Box flexDirection="row" columnGap={2}>
        <Text>{`${unread} unread (retained) · ${count(model.rows.length, 'peer')}`}</Text>
        {unread > 0 && <Button key="pane:read-all" label="Read all" hotkey="r" plain onPress={actions.readAll} />}
      </Box>
      {contextLine(Text, model)}
      {evictedLine(Text, model)}
      {model.rows.length === 0 && <Text dimColor>No messages from teammates or other sessions in this capture window.</Text>}
      {isWide && shown.length > 0 && columnsHeader(ui, stateWidth)}
      {shown.map((row, index) => {
        const args = { row, index, label: labels.get(row.peer)!, key: keys.get(row.peer)!, now: model.now, open: () => actions.openThread(row.peer) }
        return isWide ? columnsRow(ui, args, stateWidth) : twoLineRow(ui, args, model.columns)
      })}
      {movedLine(Text, moved, 'peer')}
      {pages > 1 && pagerRow(
        ui,
        page > 0 && <Button key="roster:previous" label="Previous peers" hotkey="p" plain onPress={() => actions.rosterPage(page - 1)} />,
        `Peer page ${page + 1} of ${pages}`,
        page + 1 < pages && <Button key="roster:next" label="More peers" hotkey="n" plain onPress={() => actions.rosterPage(page + 1)} />,
      )}
      {laneSection(ui, model, actions)}
      {footer(ui)}
    </Box>
  )
}

type EntryArgs = { isFresh: boolean; isOpen: boolean; hasSendNote: boolean; hasDayLine: boolean }

/**
 * One thread entry: the send note above the first send of the page, a day line above the first entry of an earlier
 * day, a header of fixed cells (new, time, arrow, kind) that never shrink and the trust marks, which alone shrink and
 * wrap, the reported send result on a line of its own, the summary only when the sender wrote one that the body does
 * not start with, the body, and Send details.
 */
function entryView(ui: HighCommandElements, entry: HighCommandEntry, args: EntryArgs, actions: PaneActions): RenderElement {
  const { Box, Text, Button } = ui
  const { isFresh, isOpen } = args
  const weight: TextProps = isFresh ? { bold: true } : {}
  const { arrow, word } = labelOf(entry)
  const marks = dotted([
    entry.trust !== undefined && [trustLabel(entry.trust)!],
    entry.isSuspicious === true && [<Text color="warning">suspicious</Text>],
  ])
  const delivery = entry.delivery
  return (
    <Box flexDirection="column" marginTop={1}>
      {args.hasSendNote && <Box paddingLeft={4}><Text dimColor wrap="wrap">{SEND_NOTE}</Text></Box>}
      {args.hasDayLine && <Box paddingLeft={4}><Text dimColor>{dayLabel(entry.at)}</Text></Box>}
      <Box flexDirection="row" columnGap={1}>
        <Box width={3} flexShrink={0}>{isFresh && <Text bold>new</Text>}</Box>
        <Box width={5} flexShrink={0}><Text {...weight}>{timeLabel(entry.at)}</Text></Box>
        <Box width={1} flexShrink={0}><Text {...weight}>{arrow}</Text></Box>
        <Box width={15} flexShrink={0}><Text {...weight}>{entry.direction === 'out' ? 'send attempted' : word}</Text></Box>
        {marks.length > 0 && <Box flexShrink={1} minWidth={0}><Text wrap="wrap">{marks}</Text></Box>}
      </Box>
      {delivery !== undefined && (
        <Box paddingLeft={10}>
          <Text wrap="wrap" {...(delivery.isDelivered ? {} : { color: 'error' })}>
            {delivery.isDelivered ? 'reported send result: queued' : `reported send result: not delivered: ${delivery.reason}`}
          </Text>
        </Box>
      )}
      {entry.summary !== lineOf(firstLine(entry.body)) && <Box paddingLeft={4}><Text {...weight} wrap="wrap">{entry.summary}</Text></Box>}
      <Box paddingLeft={4}><Text wrap="wrap">{entry.body}</Text></Box>
      {entry.fullChars > entry.body.length && (
        <Box paddingLeft={4}><Text dimColor>{`(${count(entry.fullChars - entry.body.length, 'more character')} in the transcript.)`}</Text></Box>
      )}
      {(entry.refusal !== undefined || entry.core !== undefined) && (
        <Box paddingLeft={4}>
          <Button key={`reason:${entry.seq}`} label={isOpen ? 'Hide send details' : 'Show send details'} onPress={() => actions.reason(entry.seq)} />
        </Box>
      )}
      {isOpen && entry.refusal !== undefined && (
        <Box flexDirection="column" paddingLeft={4}>
          <Text wrap="wrap">{entry.refusal.body}</Text>
          {entry.refusal.fullChars > entry.refusal.body.length && (
            <Text dimColor>{`Refusal truncated: ${entry.refusal.fullChars} characters originally; ${entry.refusal.body.length} retained.`}</Text>
          )}
        </Box>
      )}
      {isOpen && entry.core !== undefined && (
        <Box flexDirection="column" paddingLeft={4}>
          <Text dimColor wrap="wrap">{CORE_NOTE}</Text>
          <Text>{`Latest traced core recipient (bounded): ${entry.core.to}`}</Text>
          <Text>{`Core queue outcome: ${entry.core.isDelivered ? 'accepted, not read' : `refused: ${entry.core.reason}`}`}</Text>
          <Text wrap="wrap">{entry.core.body}</Text>
          {entry.core.fullChars > entry.core.body.length && <Text>{`Core text truncated: ${entry.core.fullChars} characters originally.`}</Text>}
        </Box>
      )}
    </Box>
  )
}

/**
 * One peer's thread, newest entry first: location with Back, the state line, the facts line with Show identity and
 * Mark read (on a row of their own when the line does not fit), the context line, the entries, one pager row, the order note.
 */
function threadView(ui: HighCommandElements, model: PaneModel, thread: Thread, actions: PaneActions, label: string): RenderElement {
  const { Box, Text, Button } = ui
  const { row, since, shown, hidden, fresh } = thread
  const facts = dotted([
    row.trust !== undefined && [`Sender ${row.trust}`],
    [count(shown.length + hidden, 'retained message')],
    fresh > 0 && [`${fresh} new`],
    thread.pages > 1 && [`page ${thread.page + 1} of ${thread.pages}`],
  ])
  const factsText = joined([
    row.trust === undefined ? undefined : `Sender ${row.trust}`,
    count(shown.length + hidden, 'retained message'),
    fresh > 0 ? `${fresh} new` : undefined,
    thread.pages > 1 ? `page ${thread.page + 1} of ${thread.pages}` : undefined,
  ])
  const buttons = [
    <Button key="pane:identity" label="Show identity" hotkey="i" plain onPress={() => actions.identity(0)} />,
    row.unread > 0 && <Button key="pane:mark-read" label="Mark read" hotkey="r" plain onPress={() => actions.markRead(row.peer)} />,
  ]
  const buttonCells = 2 + plainCells('Show identity') + (row.unread > 0 ? 2 + plainCells('Mark read') : 0)
  const fits = model.columns === undefined || cellWidth(factsText) + buttonCells <= model.columns
  const firstSend = shown.find(entry => entry.direction === 'out')
  return (
    <Box flexDirection="column">
      {locationRow(ui, `High Command › ${laneTitle(model)} ›`, label, model.columns, { onPress: actions.back, autoFocus: true })}
      {row.state !== undefined && <Text dimColor wrap="wrap">{threadState(row.state, model.now)}</Text>}
      {fits ? (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text wrap="wrap">{facts}</Text>
          {buttons}
        </Box>
      ) : [
        <Text wrap="wrap">{facts}</Text>,
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>{buttons}</Box>,
      ]}
      {contextLine(Text, model)}
      {evictedLine(Text, model)}
      {shown.map((entry, index) => {
        const previous = shown[index - 1]
        return entryView(ui, entry, {
          isFresh: isNewer(entry, since),
          isOpen: thread.reasonSeq === entry.seq,
          hasSendNote: entry === firstSend,
          hasDayLine: !isSameDay(entry.at, model.now) && (previous === undefined || !isSameDay(previous.at, entry.at)),
        }, actions)
      })}
      {movedLine(Text, thread.moved, 'message')}
      {thread.pages > 1 && pagerRow(
        ui,
        thread.page > 0 && <Button key="pane:newer" label="Newer" hotkey="p" plain onPress={() => actions.page(thread.page - 1)} />,
        `Page ${thread.page + 1} of ${thread.pages} · ${count(hidden, 'retained message')} on other pages`,
        thread.page + 1 < thread.pages && <Button key="pane:older" label="Older" hotkey="n" plain onPress={() => actions.page(thread.page + 1)} />,
        1,
      )}
      {footer(ui)}
    </Box>
  )
}

/** A peer's full identity, as a level of its own under its thread: one 1,000-character part at a time. */
function identityView(ui: HighCommandElements, model: PaneModel, thread: Thread, actions: PaneActions, label: string): RenderElement {
  const { Box, Text, Button } = ui
  const peer = thread.row.peer
  const part = thread.identityPage ?? 0
  const parts = Math.ceil(peer.length / 1000)
  return (
    <Box flexDirection="column">
      {locationRow(ui, `High Command › ${laneTitle(model)} ›`, `${label} › Identity`, model.columns, { onPress: () => actions.identity(undefined), autoFocus: true })}
      <Text>{`Identity part ${part + 1} of ${parts} (${peer.length} characters):`}</Text>
      <Text wrap="wrap">{identityPart(peer, part)}</Text>
      {parts > 1 && (
        <Box flexDirection="row" columnGap={2}>
          {part > 0 && <Button key="identity:previous" label="Previous identity part" hotkey="p" plain onPress={() => actions.identity(part - 1)} />}
          {part + 1 < parts && <Button key="identity:next" label="Next identity part" hotkey="n" plain onPress={() => actions.identity(part + 1)} />}
        </Box>
      )}
    </Box>
  )
}

/** Includes JSON structure, escaped strings, and space for serialized button handlers. */
export function fitsBounds(tree: RenderElement): boolean {
  const pending = [{ node: tree as unknown, depth: 1 }]
  let nodes = 0
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!
    if (++nodes > LIMITS.drawingNodes || depth > LIMITS.drawingDepth) return false
    if (typeof node !== 'object' || node === null) continue
    const children: unknown = Reflect.get(node, 'children')
    if (Array.isArray(children)) for (const child of children) pending.push({ node: child, depth: depth + 1 })
  }
  try {
    return serialized(tree) <= LIMITS.drawingText
  } catch {
    return false
  }
}

/** The pane's tree: a roster (the main inbox or an agent lane), one peer's thread, or that peer's identity. */
export function paneTree(ui: HighCommandElements, model: PaneModel, actions: PaneActions): RenderElement {
  const thread = model.thread
  if (thread === undefined) return rosterView(ui, model, actions)
  const label = peerLabels(model.rows.map(row => row.peer)).get(thread.row.peer)!
  return thread.identityPage === undefined ? threadView(ui, model, thread, actions, label) : identityView(ui, model, thread, actions, label)
}

/** The terminal cells of a row of one text and Buttons drawn as `[ label ]`, with `gap` cells before each Button. */
function rowCells(text: string, labels: readonly string[], gap: number): number {
  return labels.reduce((cells, label) => cells + gap + cellWidth(label) + 4, cellWidth(text))
}

/**
 * The dim key hint after the last Button of a row of `cells` cells, or false. It shows only when the row, a gap of
 * one and the hint all fit the band's `columns`, so the row never wraps and keeps every Button; never without `columns`.
 */
function keyHint(Text: HighCommandElements['Text'], cells: number, columns: number | undefined): RenderElement | false {
  return columns !== undefined && cells + 1 + cellWidth(BAND_KEY_HINT) <= columns && <Text dimColor wrap="truncate-end">{BAND_KEY_HINT}</Text>
}

/**
 * The band row, one blank row below its top, above what other mods draw there. `waiting` holds only rows with unread
 * entries; `laneUnread` is the unread count of all agent lanes, above zero only with agentLanesInBand on. `columns`,
 * the band's width in cells, adds the key hint where the row has room for it.
 */
export function bandTree(
  { Box, Text, Button }: HighCommandElements,
  waiting: readonly RosterRow[],
  actions: BandActions,
  below: RenderElement,
  labels: Map<string, string>,
  laneUnread = 0,
  columns?: number,
): RenderElement {
  const named = waiting.slice(0, LIMITS.bandPeers).map(row => `${labels.get(row.peer)} ${row.unread}`)
  const more = waiting.length > LIMITS.bandPeers ? [`+${waiting.length - LIMITS.bandPeers} more`] : []
  const peers = [...named, ...more]
  const summary = `High Command · ${unreadText(unreadTotal(waiting), laneUnread)}${peers.length === 0 ? '' : ` — ${peers.join(' · ')}`}`
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1} marginTop={1}>
        <Text wrap="truncate-end">{summary}</Text>
        <Button key="band:open" label="Open" hotkey="o" onPress={actions.open} />
        <Button key="band:read-all" label="Read all" hotkey="r" onPress={actions.readAll} />
        <Button key="band:hide" label="Hide" hotkey="h" onPress={actions.hide} />
        {keyHint(Text, rowCells(summary, ['Open', 'Read all', 'Hide'], 1), columns)}
      </Box>
      {below}
    </Box>
  )
}

/** Keeps only the counts and Open, below the same blank row, when the full band exceeds the shared budget; `columns` as in bandTree. */
export function compactBandTree({ Box, Text, Button }: HighCommandElements, waiting: readonly RosterRow[], actions: BandActions, below: RenderElement, laneUnread = 0, columns?: number): RenderElement {
  const summary = `High Command · ${unreadText(unreadTotal(waiting), laneUnread)}`
  const hint = keyHint(Text, rowCells(summary, ['Open'], 0), columns)
  return <Box flexDirection="column">
    <Box flexDirection="row" marginTop={1}>
      <Text>{summary}</Text>
      <Button key="band:open" label="Open" hotkey="o" onPress={actions.open} />
      {hint && <Box marginLeft={1}>{hint}</Box>}
    </Box>
    {below}
  </Box>
}
