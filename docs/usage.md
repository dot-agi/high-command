# High Command usage guide

## What High Command records

- **Messages to your session**: deliveries to your main conversation from agent-team teammates, from subagents that message it by name, and from your other Claude Code sessions. A named subagent's message is recorded when its prompt holds a complete `<agent-message>` frame, both while the session is idle and during a turn (see [Known limits](#known-limits)). Task notifications, scheduled prompts, and your own Remote Control prompts are not recorded. Messages for local agents go to a separate lane for each agent.
- **Messages from your session**: each plain-text SendMessage attempt that a model makes, with its reported result and a separate lane for each local sending agent. A send addressed by a local agent ID keeps that ID alongside the agent's name, so it takes a thread apart from that agent's messages to you. A message to an agent that has no name, a message that another mod in your session sends, and a send by an agent that a mod started are not recorded (see [Known limits](#known-limits)). A structured message, such as a `shutdown_request`, `shutdown_response`, or `plan_approval_response` object, is not recorded either (see [Known limits](#known-limits)). A message to your session that a mod in the sender's session composed is recorded, as `unverified sender` unless the team harness wrote it to a verified mailbox.
- **Peer states**: `idle`, `interrupted`, `failed`, `ended`, or `shut down` from teammates' notices, and `busy`, `idle`, `offline`, or another state word from the sessions Claude lists. A listed peer gets its state on its roster row once it has messages. When two listed rows share a name, the state on that peer's row may not be current (see [Known limits](#known-limits)).

A message that another mod consumes, or that you decline in an approval dialog, never reaches Claude, so High Command does not record it.

## Unread and new messages

A message to your session is unread until you open its peer's thread, press **Mark read** in that thread, or press **Read all** in the pane or the band. Messages your session sends are never unread.

When you open a thread, the messages that were unread are marked `new`, and so is each message that arrives while the thread is open. The marks stay until you go back to the roster.

While unread messages wait, the status line under the prompt says `high-command: {n} unread (retained)`. It is the mod's own line, so another mod's band cannot hide it. It clears when nothing is unread, and after `/clear`, `/resume`, or `/branch`.

## Sender labels and marks

Each message to you carries one sender label. Claude Code's own record of where the message came from sets it. The message text can only lower it: a message that names a different teammate than the one that sent it is `unverified sender`.

| Label | Meaning |
| --- | --- |
| `verified sender` | A teammate whose message the team harness wrote under that member's name. |
| `local sender` | Another session or agent whose message Claude Code delivered. The label does not prove that the sender runs on this machine: Claude Code does not report the sender's host, so this can be a remote session. The name is that sender's claim. |
| `unverified sender` | Everything else: a teammate in its own split pane, a message that a mod in the sender's session wrote outside a verified team mailbox, a delivery Claude Code could not place, and a message that names a different teammate than the one that sent it. |

A peer's row, the header of its thread, and `/highcommand` show the weakest label among its unread messages, so a newer message cannot hide the label of one you have not read. When none is unread, they show the label of its newest message to you. A peer you only sent messages to has no label.

A message is marked `suspicious` when its text matches a short fixed list of patterns: some wordings that tell an agent to ignore its earlier instructions, to change the permission mode, to run a download in a shell, or to read a credential file, and a long base64 block. The check ignores these invisible characters: Unicode format characters (category Cf, such as a zero-width space or a soft hyphen), the combining grapheme joiner U+034F, and the variation selectors U+FE00 to U+FE0F and U+E0100 to U+E01EF. It tests the text once with each of them read as a space and once with each removed, and marks the message when either test matches. Other invisible characters, look-alike letters from another alphabet, and one wording with these characters both inside a word and between two words can still avoid the mark. Other wording with the same aim, such as `Ignore all preceding instructions`, gets no mark, so a message without the mark can still try to steer an agent. The thread shows the mark on the message. A peer's roster row shows it while any unread message of that peer has it, and when its newest message to you has it. The mark hides no text, changes no delivery, and changes nothing that Claude reads, and `/highcommand` does not show it.

High Command never orders, highlights, or counts a message by a priority or urgency that its sender claims.

## Surfaces

| Surface | Band | Pane | `/highcommand` |
| --- | --- | --- | --- |
| Terminal | Yes | Yes | Yes |
| Desktop app | Yes | Yes | Yes |
| VS Code panel | No | Yes | Yes |
| Mobile app | No | Yes | Yes |
| `claude -p` | No | No | Yes, for the messages of that run only |

## Commands

| Command | Result |
| --- | --- |
| `/highcommand` | Prints the summary: one row per peer with its unread count, the time of its latest message, its state, and the kind of its latest message. Runs at once, even during a turn. |
| `/highcommand open` | Opens the pane on the first page of the main inbox roster. In `claude -p`, it explains that no pane can draw. |

## The pane

The roster lists peers you received messages from or tried to message: peers with unread messages first, then the peer with the most recent message. Each row shows, in one line, the unread count, the sender label and any `suspicious` mark, the time of the latest message, the peer's state, and the latest message. A narrow pane cuts the end of the line first. Press a peer, or its digit, to open its thread. The digits follow the roster order, so they move when a new message arrives.

A thread shows up to 20 messages per page with that peer, newest first. `←` marks a message to you and `→` a send attempt. A long message shows its first 2,000 characters and says how many more are in the transcript. **Older** and **Newer** page through the kept messages. A notice under the thread counts the messages on other pages, and a notice at the top of the pane counts the messages dropped for good.

A send shows `send attempted` with the recipient and text that High Command observed, and the reported send result. **Send details** shows the refusal reason, up to 2,000 characters. When available, it also shows the core lines: the recipient, text, and queue outcome that Claude Code itself received for the latest call. A core outcome covers that one call only. It does not prove that the recipient read the message. `/highcommand` labels sends as attempts.

Both ways to open the pane show the main inbox, even while an agent transcript is in view. Once opened, the pane keeps the lane you pick and does not follow the agent transcript you view. Press an agent's button in the agent selector to see its lane, and **Main inbox** to return to the main conversation. Agent lane counts and read actions are separate. The agent selector shows 10 agents per page: each local agent and each agent with a lane. Each agent's status shows under its button.

## The band

While unread messages wait, the band shows the total and up to three peers, the most recent first. **Open** shows the first page of the main inbox roster, even while an agent transcript is visible. The pane opens without the keyboard, because the band holds it: press Ctrl+X, then Tab, until its border is focused, or click the pane to give it the keys. **Read all** clears every unread count. **Hide** puts the band away until a newer message arrives; it marks nothing read, and the status line keeps the count. The band gives way to Claude Code's surveys.

## Keys

| Key | Where | Action |
| --- | --- | --- |
| Ctrl+X, then Tab | Anywhere | Move the keyboard to the band or the pane. This is Claude Code's own focus chord. |
| `o` | Band | Open the pane |
| `r` | Band or pane roster | Read all |
| `h` | Band | Hide the band until a newer message arrives |
| `1`-`9` | Pane roster | Open a thread |
| `b` | Pane thread | Back |
| `r` | Pane thread | Mark read, only while **Mark read** is visible |
| Esc | Band or pane | Give the keyboard back to the prompt |

Release Ctrl before you press Tab, because many terminals read Ctrl+Tab as next tab. In Emacs terminals, Ctrl+X goes to Emacs: click the band, run `/highcommand open`, or rebind `abovePrompt:focus` with [`/keybindings`](https://code.claude.com/docs/en/keybindings#above-prompt-actions).

Letter and digit keys work only while the band or the pane has the keyboard. Focus moves through each band button before it reaches the pane, so press Ctrl+X, then Tab, until the pane border shows focus. `/highcommand open` opens the pane directly. Opening a thread marks its kept messages read, so `r` works in a thread only when **Mark read** shows again, after that peer sends a new message.

## Known limits

- **Retained history**: the main inbox and each agent lane keep 200 messages in all and 50 per peer. A peer past 50 messages loses its own oldest ones first. Past 200 in all, the oldest messages drop. A notice counts the messages dropped for good, and unread counts cover kept messages only. A thread shows up to 20 messages per page, fewer when they are long. **Older** and **Newer** page through every kept message. Opening a thread marks all of that peer's kept messages read, also those on other pages. The roster shows 50 peers per page. Peer states are kept for the 100 peers reported most recently. A message keeps its first 2,000 characters, and its thread says how many more are in the transcript.
- **Agent lanes**: messages that local agents send and receive go to a separate lane for each agent. Each lane has its own counts and read marks, and `/highcommand` lists them apart from the main inbox. The band, the status line, and **Hide** cover the main inbox only, so an unread message in an agent lane does not show there. A message between your main conversation and a local agent can show twice, once in the main inbox and once in that agent's lane. High Command does not see messages between teammates that run in their own split panes.
- **Sends by mod-started agents**: Claude Code reports a send by an agent that a mod started as that mod's send. High Command records no mod's sends, so these sends do not show in that agent's lane or in `/highcommand`. Messages to that agent still show in its lane. Its messages to your main conversation or to another local agent still show in the main inbox or in that agent's lane.
- **Space for agent lanes**: High Command saves all agent lanes of a conversation as one value. Claude Code 2.1.296 refuses a saved value over 4,194,304 characters of JSON text. About nine full lanes of 2,000-character messages reach that size, so a lane can stop recording before it holds 200 messages. A new agent message then still reaches its recipient unchanged. High Command does not record it and writes `high-command: session.receive: could not record a delivery ...` or `high-command: session.send: could not record a message to ...`. Near that size, a lane button can also fail with a `high-command: ui.press: ...` toast. The main inbox is saved apart and keeps recording. Read the missed messages in that agent's transcript. `/clear`, `/resume`, or `/branch` starts a new capture window, which empties every lane and the main inbox.
- **Local agent status**: the status under each agent button in the pane, and in `/highcommand`, names its source. A `roster snapshot` status comes from Claude Code's local agent list. High Command reads that list when you open the pane or run `/highcommand`, when an agent starts, and when an agent ends a turn. Between reads, the status can be old. When two reads overlap, the older one can bring back an agent that the newer one removed. Open the pane or run `/highcommand` again after agent activity settles. A `lifecycle observation` says how an agent's last turn ended, such as `turn answered` or `turn error`. When the list does not hold an agent that ended a turn, an open pane shows that observation as the agent's status until the next read of the list. It describes a finished turn, so it does not prove that the agent still runs. A teammate in its own split pane can keep its last status after it crashes. `/highcommand` lists up to 100 local agents. The pane pages through all of them, 10 at a time.
- **Peer states**: a peer's roster row shows only states from teammates' notices and ListAgents results, never the local agent status. A state is the last one reported, with its time, so it does not prove that the peer is in that state now. When two rows of one ListAgents result have the same name, High Command cannot tell whose state is whose. When the result lists its rows as data, High Command takes no state for that name, so a state recorded earlier, such as `offline`, stays on that peer's row. When the result holds only the printed listing, that name gets the state of the last such row that has one.
- **Peer names**: High Command tells peers apart by name. Two senders with the same name share one roster row. Names that differ only in spacing or in invisible characters count as one name. A name longer than 60 characters shows cut, with a short code that keeps cut names apart. **Identity** in the thread shows the full name. A send that Claude addresses by a local agent ID files under `name [ID]`. That agent's messages to you file under its name alone, so the two take separate roster rows and counts.
- **Send results**: a send shows the recipient and text that High Command observed, and the result reported back to High Command. **Send details** shows what Claude Code itself received, which another mod may have changed, and whether Claude Code queued the message. When a mod answers the send itself, Send details cannot show this. When a mod sends the message more than once, Send details covers only one of those sends. A refused send shows the first 120 characters of the reason, on one line, in its header. **Send details** keeps up to 2,000 characters of the reason, with its line breaks, and says when it was cut. A queued message is not proof that the peer read it.
- **Sends changed by earlier mods**: a mod that runs before High Command can change a send's recipient and text. High Command then shows the changed recipient and text, and files the send under the changed recipient. It cannot show what Claude first wrote. Check the SendMessage call in the transcript.
- **Structured sends**: Claude Code passes only plain-text SendMessage messages to High Command. A SendMessage whose message is a `shutdown_request`, `shutdown_response`, or `plan_approval_response` object does not reach it. Neither its attempt nor its result appears in the main inbox, an agent lane, or `/highcommand`. Check the transcript for these sends.
- **Subagent messages**: a named subagent's message to your main conversation is always `local sender`. This holds even when a mod started that subagent or wrote the message, because Claude Code does not pass that fact on. High Command counts such a message only when the prompt that reaches it holds a complete `<agent-message>` frame and no frame of another kind. A mod that runs after High Command can remove that frame. High Command then files the changed text under the one name that the frames gave, or under `unnamed peer` when they gave none or several. A sender name in the changed text, such as a `from` field, does not change this.
- **Damaged frames**: Claude Code can wrap a peer's message in a frame, such as `<teammate-message>`, whose attributes name the sender. A malformed attribute, a frame with no closing tag, or text beside complete frames makes High Command write an `incomplete frame parsing` line. A complete frame with a malformed attribute keeps the attributes that High Command could read, such as the sender name and summary. The sender label rules still apply to that name. A frame with no closing tag, and text beside complete frames, become a message from the delivery's sender, or from `unnamed peer`, without frame attributes. Check the transcript for the original frame. A delivery that Claude Code could not place is recorded only when it holds a complete frame.
- **Display order**: the pane and `/highcommand` sort messages by observation time, the time High Command first saw each one, before other mods and Claude Code handled it. That is not always the order in which messages reached Claude. Read marks, **Hide**, which messages drop first, and the label of a peer with nothing unread follow recording sequence, the order in which High Command finished recording messages.
- **Narrow panes**: a roster row is one line, and a narrow pane cuts its end. The unread count, sender label, and `suspicious` mark come first, so the state and the latest message are cut before them.
- **Band space**: when other mods draw a lot in the area above the prompt, the band shrinks to the count and **Open**. When even that would pass Claude Code's limits for one drawing, the band does not show. The status line still counts unread messages. The band also gives way while a Claude Code survey shows.
- **Summary as a list**: when a peer name holds a `|` after an odd number of backslashes, `/highcommand` prints a list instead of a table. A table cell cannot show such a name as written.
- **Cut-off failure lines**: when High Command cannot record a send, the `high-command: session.send: could not record a message to ...` line names the recipient before the cause. The terminal draws the first 2,000 characters of a line. Remote surfaces and the debug log keep 10,000. A very long recipient can push the cause past that point. The SendMessage result in the transcript still says whether the message was queued.
- **No earlier history**: High Command starts empty in each new session and conversation. `/clear`, `/resume`, and `/branch` empty it again, so a resumed conversation shows none of its earlier messages. The pane and `/highcommand` say when the capture window began. After these commands, they also say that earlier history was not restored.
- **Display only**: High Command changes nothing that Claude reads. Its inbox leaves out idle notices with no content, but Claude still reads them, so the inbox saves no model turns or tokens.

## Troubleshooting

| Sign | Cause and fix |
| --- | --- |
| No `/highcommand` command | The mod did not load. Run `claude plugin test` in an empty folder to check that mods can load, and check that the `mods active` line in `/plugin` names high-command. A `high-command: session.start: could not register /highcommand: ...` line names the cause. |
| `claude plugin test` says hooks modules are turned off | Mods cannot load. `turned off here` means a setting or your organization's policy blocks them. `turned off in this process` means installed mods are off: start `claude` once with network access, then run the check again. If the message stays, installed mods are turned off remotely, and no setting on your machine turns them back on. |
| `high-command: session.receive: could not record a delivery ...`, or the same line with `prompt.submit` for a subagent's message | A message reached Claude, but High Command could not record it. The message itself is safe. A repeat of the same failure goes to the debug log only (`claude --debug`). |
| `high-command: ui.render (Pane): ...` in the pane | The pane could not draw. The line names the cause. |
| A `high-command: ui.press: ...` toast | A button could not finish its work. The toast names the button's action and the cause. |
| `unnamed peer` rows | The delivery named no sender. With `claude --debug`, each one writes `high-command: session.receive: a <kind> delivery named no sender`, or the same line with `prompt.submit` for a subagent's message. Please report it with your Claude Code version. |
| `unverified sender` on every teammate | Your teammates run in split panes, which write through a file that Claude Code cannot check. |
| A debug line names high-command after you decline a message | Claude Code reports the declined delivery under each mod that passed it on. High Command records nothing for that message. |
| States never appear | Peer states come from teammates' notices and from ListAgents results that Claude gets. Local agent status is separate: open the pane or run `/highcommand` to read it again. |
| `high-command: <event>: could not update the status line: ...` | The status line could not be updated, so it can show an old count. The line names the cause. High Command tries again at the next message to or from your session, and when you open a thread or press **Mark read** or **Read all**. |
| A harmless message is marked `suspicious` | The mark comes from a short fixed list of patterns, so a normal message can match. Nothing is blocked. |
| The band is gone but the status line still counts messages | You pressed **Hide**, and the band comes back with the next message. The band also gives way while a Claude Code survey shows, and when another mod draws so much below it that the band would pass Claude Code's limits for one drawing. In each case `/highcommand open` shows the pane. |
