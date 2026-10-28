/**
 * pi-mission — a session task board with subtasks and dependency-aware ordering.
 *
 * The problem: during a long agent session, rabbit holes and ad-hoc tasks pile
 * up faster than anyone remembers them. The agent records every task the moment
 * work appears (including the side quests), marks what starts and finishes, and
 * /mission brings up a searchable popup list of the board: what runs now, what
 * worked on, and what tasks and subtasks remain — remaining work ordered by the
 * dependency graph. Enter on a task drives its next action through the agent,
 * so the board state always lives in the transcript (branch-aware).
 *
 * The popup follows pi's own picker composition (examples/extensions/preset.ts):
 * Container + DynamicBorder around a SelectList, fuzzyFilter for type-to-find,
 * built-in ctx.ui.select/input dialogs for actions, overlay placement.
 *
 * State lives in tool-result `details` (branch-aware) and is reconstructed from
 * the session on load — the same pattern as examples/extensions/todo.ts.
 *
 * Load: keep this directory in ~/.pi/agent/extensions/pi-mission/.
 * Self-test: node selftest.mjs (drives the tool without a model).
 */
import { DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Container, type SelectItem, SelectList, Text, type TuiMouseEvent, type TuiMouseEventResult, decodeKittyPrintable, fuzzyFilter, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Status = "pending" | "active" | "done" | "dropped";

interface Task {
	id: number;
	title: string;
	status: Status;
	/** high/normal/low (default normal). Absent on snapshots from before the field. */
	priority?: "high" | "normal" | "low";
	/** Supertask id for a subtask, null for a top-level task (one nesting level). */
	parent: number | null;
	/** Ids that must be done first. */
	dependsOn: number[];
	createdAt: number;
	/** Last mutation (any action) — the recency signal for "what is current". */
	updatedAt?: number;
	startedAt?: number;
	doneAt?: number;
}

type MissionAction = "add" | "dep" | "prio" | "start" | "done" | "drop" | "list";

/**
 * Persistence: one append-only JSONL file per session, <session-id>.jsonl under
 * the store directory (PI_MISSION_STORE overrides the location) — the same
 * per-file pattern pi uses for session transcripts. Each line is the board
 * snapshot after one change (latest line wins on replay), so writes never
 * read-merge and a board can only ever be read from its own session's file.
 */
const storeDir = (): string => process.env.PI_MISSION_STORE ?? join(getAgentDir(), "mission-boards");

const sessionLog = (session: string): string => join(storeDir(), `${session}.jsonl`);

const appendSnapshot = (session: string, tasks: Task[], nextId: number): void => {
	mkdirSync(storeDir(), { recursive: true });
	appendFileSync(sessionLog(session), `${JSON.stringify({ ts: Date.now(), tasks, nextId })}\n`);
};

/** The session's board as of its last change: the last parseable log line. */
const readSnapshot = (session: string): { tasks: Task[]; nextId: number } | undefined => {
	let text: string;
	try {
		text = readFileSync(sessionLog(session), "utf8");
	} catch {
		return undefined;
	}
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!lines[i].trim()) continue;
		try {
			const snap = JSON.parse(lines[i]);
			if (Array.isArray(snap.tasks)) return snap;
		} catch {
			// a torn trailing line from a crash mid-append: skip it
		}
	}
	return undefined;
};

/**
 * Handoff sources for /mission-handoff: every earlier session board that still
 * has unfinished (pending/active) work, newest first. Boards stay
 * session-scoped by design — this only gathers the candidates; carrying tasks
 * over is always an explicit request.
 */
const handoffSources = (currentSession: string): { session: string; tasks: Task[] }[] => {
	const out: { session: string; tasks: Task[] }[] = [];
	const seen = new Set<string>();
	try {
		const files = readdirSync(storeDir()).filter((f) => f.endsWith(".jsonl"));
		files.sort((a, b) =>
			statSync(join(storeDir(), b)).mtimeMs - statSync(join(storeDir(), a)).mtimeMs ||
			(a < b ? 1 : -1));
		for (const f of files) {
			const session = f.slice(0, -".jsonl".length);
			if (session === currentSession) continue;
			// a newer board's copy of a title wins over an older one's
			const open = (readSnapshot(session)?.tasks ?? [])
				.filter((t) => (t.status === "pending" || t.status === "active") && !seen.has(t.title));
			for (const t of open) seen.add(t.title);
			if (open.length > 0) out.push({ session, tasks: open });
		}
	} catch {
		// no store directory or unreadable entry: nothing to hand off
	}
	return out;
};



/* One entry of a batch add (tasks[]) — the same fields as a single add. */
type AddItem = {
	title?: string;
	capture?: string;
	parent?: number;
	depends_on?: number[];
	priority?: "high" | "normal" | "low";
};

interface MissionDetails {
	action: MissionAction;
	tasks: Task[];
	nextId: number;
	error?: string;
}

const MissionParams = Type.Object({
	action: Type.Union([
		Type.Literal("add"),
		Type.Literal("dep"),
		Type.Literal("prio"),
		Type.Literal("start"),
		Type.Literal("done"),
		Type.Literal("drop"),
		Type.Literal("list"),
	]),
	title: Type.Optional(Type.String({ description: "Explicit task name (add; used as-is when given)" })),
	capture: Type.Optional(Type.String({ description: "Raw thought when no explicit name is given (add); a concise name is generated with a bargain-tier model" })),
	tasks: Type.Optional(Type.Array(Type.Object({
		title: Type.Optional(Type.String({ description: "Explicit task name (used as-is when given)" })),
		capture: Type.Optional(Type.String({ description: "Raw thought when no explicit name is given; a concise name is generated with a bargain-tier model" })),
		parent: Type.Optional(Type.Number({ description: "Supertask id when adding a subtask" })),
		depends_on: Type.Optional(Type.Array(Type.Number(), { description: "Ids that must be done first" })),
		priority: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("normal"), Type.Literal("low")],
			{ description: "Task priority (default normal)" })),
	}), { description: "Add several tasks in one call (add); one entry per task, ids assigned in order. " +
		"Prerequisite ids must already exist on the board — use dep afterwards to link tasks added together" })),
	id: Type.Optional(Type.Number({ description: "Task id (dep/prio/start/done/drop)" })),
	parent: Type.Optional(Type.Number({ description: "Supertask id when adding a subtask (add)" })),
	depends_on: Type.Optional(Type.Array(Type.Number(), { description: "Ids that must be done first (add/dep)" })),
	priority: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("normal"), Type.Literal("low")],
		{ description: "Task priority (add/prio; default normal)" })),
});

const MARK: Record<Status, string> = { done: "✓", active: "●", pending: "○", dropped: "✗" };

const findTask = (tasks: Task[], id: number): Task | undefined => tasks.find((t) => t.id === id);

/** Prerequisites that are not done (dropped counts as satisfied — a dropped
 * prerequisite must not block forever). */
const waitingOn = (tasks: Task[], t: Task): number[] =>
	t.dependsOn.filter((d) => {
		const dt = findTask(tasks, d);
		return dt !== undefined && dt.status !== "done" && dt.status !== "dropped";
	});

/**
 * Would adding prerequisite edge d -> id close a cycle? Edges point from a
 * prerequisite to its dependent, so a new edge d -> id is safe unless id
 * already reaches d through dependents.
 */
const reaches = (tasks: Task[], from: number, to: number): boolean => {
	const stack = [from];
	const seen = new Set<number>();
	while (stack.length > 0) {
		const cur = stack.pop() as number;
		if (cur === to) return true;
		if (seen.has(cur)) continue;
		seen.add(cur);
		for (const t of tasks) if (t.dependsOn.includes(cur)) stack.push(t.id);
	}
	return false;
};

/**
 * Remaining (pending) tasks in dependency order: repeatedly take the
 * earliest-created pending task whose pending prerequisites are already
 * emitted. Greedy — the least reordering that satisfies the graph. The graph is
 * kept acyclic at mutation time, so the loop always emits everything.
 */
const remainingOrder = (tasks: Task[]): Task[] => {
	const pending = tasks.filter((t) => t.status === "pending");
	const pendingIds = new Set(pending.map((t) => t.id));
	const emitted = new Set<number>();
	const out: Task[] = [];
	while (out.length < pending.length) {
		const next = pending.find(
			(t) => !emitted.has(t.id) && t.dependsOn.every((d) => !pendingIds.has(d) || emitted.has(d)),
		);
		if (!next) break;
		emitted.add(next.id);
		out.push(next);
	}
	return out;
};

interface Row {
	kind: "title" | "section" | "done" | "active" | "pending" | "dropped";
	text: string;
	task?: Task;
}

const hhmm = (ms?: number): string => (ms ? new Date(ms).toTimeString().slice(0, 5) : "");

const afterNote = (tasks: Task[], t: Task): string => {
	const w = waitingOn(tasks, t);
	return w.length > 0 ? ` (after ${w.map((d) => `#${d}`).join(",")})` : "";
};

/** The board as rows: one hierarchy per top-level task, subtasks indented. */
/** Rows for one top-level task and its subtasks (subtasks indented). */
const groupRows = (tasks: Task[], t: Task): Row[] => {
	const subs = tasks.filter((s) => s.parent === t.id);
	const settled = subs.filter((s) => s.status !== "pending");
	const order = [...settled, ...remainingOrder(subs)];
	const line = (x: Task, indent: string): Row => ({
		kind: x.status,
		task: x,
		text: `${indent}${MARK[x.status]} #${x.id} ${x.title}` +
			(x.priority && x.priority !== "normal" ? ` (${x.priority})` : "") +
			(x.status === "active" ? ` (started ${hhmm(x.startedAt)})` : x.status === "done" ? ` (${hhmm(x.doneAt)})` : "") +
			afterNote(tasks, x),
	});
	return [line(t, ""), ...order.map((s) => line(s, "   "))];
};

/** Top-level tasks in board order: active, remaining (dependency order), done, dropped. */
const boardTops = (tasks: Task[]): Task[] => {
	const tops = tasks.filter((t) => t.parent === null);
	return [
		...tops.filter((t) => t.status === "active"),
		...remainingOrder(tops),
		...tops.filter((t) => t.status === "done"),
		...tops.filter((t) => t.status === "dropped"),
	];
};

const boardRows = (tasks: Task[]): Row[] => {
	const top = tasks.filter((t) => t.parent === null);
	const done = top.filter((t) => t.status === "done");
	const active = top.filter((t) => t.status === "active");
	const dropped = top.filter((t) => t.status === "dropped");
	const pending = remainingOrder(top);

	if (tasks.length === 0) {
		return [{ kind: "title", text: "mission: no tasks — record the next piece of work the moment it appears" }];
	}
	const rows: Row[] = [
		{
			kind: "title",
			text: `mission: ${done.length} done · ${active.length} active · ${pending.length} remaining`,
		},
	];
	const sections: Array<[string, Task[]]> = [
		["current:", active],
		["remaining (dependency order):", pending],
		["done:", done],
		["dropped:", dropped],
	];
	for (const [label, list] of sections) {
		if (list.length === 0) continue;
		rows.push({ kind: "section", text: label });
		for (const t of list) rows.push(...groupRows(tasks, t));
	}
	return rows;
};

const boardText = (tasks: Task[]): string => boardRows(tasks).map((r) => r.text).join("\n");

/** Popup sort modes, cycled with the session picker's sort key (ctrl+s). */
type SortMode = "board" | "recent" | "oldest" | "priority" | "status";

const prioRank = (t: Task): number => (t.priority === "high" ? 0 : t.priority === "low" ? 2 : 1);

/** Focus order: active, ready, blocked, done, dropped. */
const statusRank = (tasks: Task[], t: Task): number => {
	if (t.status === "active") return 0;
	if (t.status === "pending") return waitingOn(tasks, t).length > 0 ? 2 : 1;
	if (t.status === "done") return 3;
	return 4;
};

/** Order top-level tasks for the popup. JS sort is stable: equal keys keep board order. */
const sortTops = (tasks: Task[], tops: Task[], sort: SortMode): Task[] => {
	const copy = [...tops];
	if (sort === "recent") copy.sort((a, b) => b.createdAt - a.createdAt);
	else if (sort === "oldest") copy.sort((a, b) => a.createdAt - b.createdAt);
	else if (sort === "priority") copy.sort((a, b) => prioRank(a) - prioRank(b));
	else if (sort === "status") copy.sort((a, b) => statusRank(tasks, a) - statusRank(tasks, b));
	return copy;
};

/**
 * Popup rows: task groups in sort order, reduced by view and fold state.
 * view "open" hides done and dropped groups, "current" keeps active groups.
 * Folding a top-level task hides its subtask rows. Exported for the selftest.
 */
export const popupRows = (
	tasks: Task[],
	view: "all" | "open" | "current",
	folded: Set<number>,
	sort: SortMode = "board",
): Row[] => {
	const rows: Row[] = [];
	for (const t of sortTops(tasks, boardTops(tasks), sort)) {
		if (view === "open" && (t.status === "done" || t.status === "dropped")) continue;
		if (view === "current" && t.status !== "active") continue;
		for (const r of groupRows(tasks, t)) {
			if (r.task && r.task.parent !== null && folded.has(r.task.parent)) continue;
			rows.push(r);
		}
	}
	return rows;
};

/** Second-column note for a popup item: hierarchy and progress. */
const itemDescription = (tasks: Task[], t: Task): string => {
	const parts: string[] = [];
	if (t.priority && t.priority !== "normal") parts.push(t.priority);
	if (t.parent !== null) parts.push(`subtask of #${t.parent}`);
	const kids = tasks.filter((s) => s.parent === t.id);
	if (kids.length > 0) {
		parts.push(`subtasks ${kids.filter((s) => s.status === "done").length}/${kids.length}`);
	}
	if (t.status === "active" && t.startedAt) parts.push(`started ${hhmm(t.startedAt)}`);
	if (t.status === "done" && t.doneAt) parts.push(hhmm(t.doneAt));
	const w = waitingOn(tasks, t);
	if (w.length > 0) parts.push(`after ${w.map((d) => `#${d}`).join(",")}`);
	return parts.join("  ");
};

/**
 * Actions that apply to a task's state; the rest are hidden in the menu
 * (ctx.ui.select has no disabled option). A dropped task has no actions.
 */
export const menuActions = (status: Status): string[] => {
	if (status === "dropped") return [];
	const actions: string[] = [];
	if (status === "pending") actions.push("start");
	if (status !== "done") actions.push("done", "priority");
	actions.push("drop");
	return actions;
};

/** What the popup hands back to the command. */
type MissionPick = { kind: "add" } | { kind: "task"; id: number } | null;

/** Popup view modes, cycled with the tree's filter keys (ctrl+o). */
type ViewMode = "all" | "open" | "current";
let boardView: ViewMode = "all";
let boardSort: SortMode = "board";

/** SelectItem plus the text the fuzzy filter matches on. */
type MissionItem = SelectItem & { search: string };

/** Bargain-tier model for task naming (override: PI_MISSION_NAME_MODEL=provider/model-id). */
const NAME_MODEL_ID = process.env.PI_MISSION_NAME_MODEL
	?? "openrouter/xiaomi/mimo-v2.6-flash";

/** Granularity dial (PI_MISSION_GRANULARITY): how much work becomes a task. */
const GRANULARITY_RULES: Record<string, string> = {
	fine: "Granularity is fine: record every step, chore, and side quest as its own task.",
	normal: "Granularity is normal: record each distinct piece of work as a task; use subtasks for its steps.",
	coarse: "Granularity is coarse: record only multi-step work items as tasks; fold small steps into the parent task instead of creating tasks.",
};
const granularityRule = (): string =>
	GRANULARITY_RULES[process.env.PI_MISSION_GRANULARITY ?? "normal"] ?? GRANULARITY_RULES.normal;

/**
 * Name a captured thought with a bargain-tier model: 3-7 words, plain verb
 * first. Fail-open — on any failure the cleaned capture text becomes the name,
 * so task creation never blocks on naming.
 */
const generateName = async (
	ctx: ExtensionContext,
	capture: string,
	existing: string[],
): Promise<{ title: string; usage?: AgentToolResult<never>["usage"] }> => {
	const fallback = capture.trim().slice(0, 80);
	try {
		const [provider, ...rest] = NAME_MODEL_ID.split("/");
		// Only the bargain-tier model is used — never fall back to the session
		// model: on an expensive model, naming must not burn its tokens. No model
		// found means the cleaned capture becomes the name.
		const model = ctx.modelRegistry.find(provider, rest.join("/"));
		if (!model) return { title: fallback };
		const response = await ctx.modelRegistry.complete(model, {
			systemPrompt:
				"You name tasks for a developer's task board. Return only the name: " +
				"3 to 7 words, verb first, plain English. " +
				// The high-impact subset of Simplified Technical English for short
				// titles: one plain verb (no phrasal verbs, no noun forms), a concrete
				// object, and one consistent word per thing.
				"Use one plain verb, never a phrasal verb (investigate, not look into) " +
				"or a noun form (analyze, not analysis of). " +
				"Name the concrete thing, not a vague one. " +
				"Use the same word for the same thing as the existing names. " +
				"No quotes, no numbering, no trailing period.",
			messages: [{
				role: "user",
				content: [{
					type: "text",
					text: `Raw capture:\n${capture}\n\nExisting task names:\n${existing.slice(-12).join("\n") || "(none)"}`,
				}],
				timestamp: Date.now(),
			}],
		});
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join(" ");
		const line = (text.split("\n").find((l) => l.trim()) ?? "").trim();
		const cleaned = line.replace(/^["'`\[(]+|["'`)\].,;:]+$/g, "").trim();
		return { title: cleaned || fallback, usage: response.usage };
	} catch {
		return { title: fallback };
	}
};

/**
 * The /mission popup: pi's picker composition — Container + DynamicBorder around
 * a searchable SelectList. Typing fuzzy-filters (rabbit holes are found by
 * title), arrows move (mouse clicks too), Enter acts on the row, Esc clears the
 * filter and then closes.
 */
class MissionPopup {
	private tasks: Task[];
	private theme: Theme;
	private tui: { requestRender: () => void };
	private keybindings: KeybindingsManager;
	private done: (result: MissionPick) => void;
	private filter = "";
	private items: MissionItem[] = [];
	private folded = new Set<number>();
	private view: ViewMode = boardView;
	private sort: SortMode = boardSort;
	private selectedValue: string | null = null;
	private container: Container | null = null;
	private selectList: SelectList | null = null;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		tasks: Task[],
		theme: Theme,
		tui: { requestRender: () => void },
		keybindings: KeybindingsManager,
		done: (result: MissionPick) => void,
		initialSelected?: string,
	) {
		this.tasks = tasks;
		this.theme = theme;
		this.tui = tui;
		this.keybindings = keybindings;
		this.done = done;
		this.selectedValue = initialSelected ?? null;
		this.build();
	}

	private build(): void {
		const th = this.theme;
		const rows = popupRows(this.tasks, this.view, this.folded, this.sort);
		const unfiltered: MissionItem[] = [
			{
				value: "__add__",
				label: "＋ add task",
				description: "record a rabbit hole the moment it appears",
				search: "add task new rabbit hole",
			},
			...rows.map((r) => {
				const t = r.task as Task;
				return {
					value: `t${t.id}`,
					label: r.text,
					description: itemDescription(this.tasks, t),
					search: `${t.title} #${t.id}`,
				};
			}),
		];
		const items: MissionItem[] = this.filter === ""
			? unfiltered
			: fuzzyFilter(unfiltered, this.filter, (i) => i.search);
		this.items = items;

		const container = new Container();
		container.addChild(new DynamicBorder((str) => th.fg("accent", str)));
		const counts = boardRows(this.tasks)[0].text;
		container.addChild(new Text(th.fg("accent", th.bold(counts)) +
			(this.view !== "all" ? th.fg("muted", `   view: ${this.view}`) : "") +
			(this.sort !== "board" ? th.fg("muted", `   sort: ${this.sort}`) : "") +
			(this.filter ? th.fg("muted", `   filter: ${this.filter}`) : "")));
		const selectList = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (text) => th.fg("accent", text),
			selectedText: (text) => th.fg("accent", text),
			description: (text) => th.fg("muted", text),
			scrollInfo: (text) => th.fg("muted", text),
			noMatch: (text) => th.fg("warning", text),
		}, { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 56 });
		selectList.onSelect = (item) => {
			if (item.value === "__add__") this.done({ kind: "add" });
			else this.done({ kind: "task", id: Number(item.value.slice(1)) });
		};
		selectList.onCancel = () => this.done(null);
		// Selection stability (the /tree picker's lesson): keep the same row
		// selected across filter/view rebuilds when it is still visible.
		selectList.onSelectionChange = (item) => {
			this.selectedValue = item.value;
		};
		// Open on the current task: the most recently touched active one (a stale
		// active is the known failure mode, so recency decides among them), else
		// the most recently touched one, else the add row. A selection hidden by a
		// fold snaps to its group row so ← then → can always unfold again.
		let target = this.selectedValue;
		if (target === null) {
			const tasksInRows = popupRows(this.tasks, this.view, this.folded, this.sort)
				.map((r) => r.task)
				.filter((t): t is Task => t !== undefined);
			const recency = (t: Task) => t.updatedAt ?? t.createdAt;
			const active = tasksInRows.filter((t) => t.status === "active");
			const pool = active.length > 0 ? active : tasksInRows;
			const current = pool.reduce<Task | undefined>(
				(a, t) => (!a || recency(t) > recency(a) ? t : a),
				undefined,
			);
			target = current ? `t${current.id}` : "__add__";
			this.selectedValue = target;
		}
		let keep = items.findIndex((i) => i.value === target);
		if (keep < 0 && target.startsWith("t")) {
			const t = findTask(this.tasks, Number(target.slice(1)));
			const group = t ? `t${t.parent ?? t.id}` : "__add__";
			keep = items.findIndex((i) => i.value === group);
			if (keep >= 0) this.selectedValue = group;
		}
		if (keep > 0) selectList.setSelectedIndex(keep);
		container.addChild(selectList);
		container.addChild(new Text(th.fg("dim", "type to filter • ↑↓/mouse move • ←/→ fold/unfold • ⌃o view • ⌃s sort • enter act • esc clear/close")));
		container.addChild(new DynamicBorder((str) => th.fg("accent", str)));

		this.container = container;
		this.selectList = selectList;
		this.invalidate();
	}

	private rebuild(): void {
		this.build();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (!this.container || (this.cachedLines !== undefined && this.cachedWidth === width)) {
			return this.cachedLines ?? [];
		}
		this.cachedLines = this.container.render(width).map((line) => truncateToWidth(line, width));
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		// The /tree picker's chord keys: fold/unfold and view cycling never touch
		// the printable filter buffer (alt/ctrl arrows and ctrl+o are not text).
		const groupOf = (): number | null => {
			const item = this.selectList?.getSelectedItem();
			if (!item || !item.value.startsWith("t")) return null;
			const t = findTask(this.tasks, Number(item.value.slice(1)));
			return t ? (t.parent ?? t.id) : null;
		};
		// Plain ←/→ fold/unfold — free in this list (the tree needs alt/ctrl only
		// because it binds plain arrows to paging). Its chords keep working for
		// muscle memory.
		const fold = () => {
			const g = groupOf();
			if (g !== null && this.tasks.some((s) => s.parent === g)) {
				this.folded.add(g);
				this.rebuild();
			}
		};
		const unfold = () => {
			const g = groupOf();
			if (g !== null && this.folded.has(g)) {
				this.folded.delete(g);
				this.rebuild();
			}
		};
		if (matchesKey(data, "left") || this.keybindings.matches(data, "app.tree.foldOrUp")) {
			fold();
			return;
		}
		if (matchesKey(data, "right") || this.keybindings.matches(data, "app.tree.unfoldOrDown")) {
			unfold();
			return;
		}
		const modes: ViewMode[] = ["all", "open", "current"];
		if (this.keybindings.matches(data, "app.tree.filter.cycleForward") ||
			this.keybindings.matches(data, "app.tree.filter.cycleBackward")) {
			const dir = this.keybindings.matches(data, "app.tree.filter.cycleForward") ? 1 : -1;
			this.view = modes[(modes.indexOf(this.view) + dir + modes.length) % modes.length];
			boardView = this.view;
			this.rebuild();
			return;
		}
		// Sort cycling on the session picker's sort key (ctrl+s).
		const sorts: SortMode[] = ["board", "recent", "oldest", "priority", "status"];
		if (this.keybindings.matches(data, "app.session.toggleSort")) {
			this.sort = sorts[(sorts.indexOf(this.sort) + 1) % sorts.length];
			boardSort = this.sort;
			this.rebuild();
			return;
		}
		if (matchesKey(data, "escape") && this.filter !== "") {
			this.filter = "";
			this.rebuild();
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.filter !== "") {
				this.filter = this.filter.slice(0, -1);
				this.rebuild();
			}
			return;
		}
		// Bracketed paste goes to the filter (pasting a search term).
		const pasteStart = data.indexOf("\x1b[200~");
		if (pasteStart !== -1) {
			const end = data.indexOf("\x1b[201~");
			const text = data.slice(pasteStart + 6, end === -1 ? undefined : end);
			if (text) {
				this.filter += text.replace(/[\r\n]+/g, " ");
				this.rebuild();
			}
			return;
		}
		// Page/home/end for long boards — SelectList itself handles only
		// ↑↓/Enter/Esc. Page step matches the visible row count.
		const jump = (target: number) => {
			if (this.items.length === 0) return;
			const idx = Math.max(0, Math.min(this.items.length - 1, target));
			this.selectList?.setSelectedIndex(idx);
			this.selectedValue = this.items[idx].value;
			this.invalidate();
			this.tui.requestRender();
		};
		const cur = Math.max(0, this.items.findIndex((i) => i.value === this.selectedValue));
		if (this.keybindings.matches(data, "tui.select.pageUp")) return jump(cur - 10);
		if (this.keybindings.matches(data, "tui.select.pageDown")) return jump(cur + 10);
		if (matchesKey(data, "home")) return jump(0);
		if (matchesKey(data, "end")) return jump(this.items.length - 1);
		// Typing filters. decodeKittyPrintable covers kitty-protocol terminals
		// (Ghostty sends letters as CSI-u sequences); a whole printable chunk
		// covers coalesced typing and non-bracketed paste.
		const printable = (s: string) => s.length > 0 && [...s].every((c) => c >= " " && c !== "\x7f");
		const ch = decodeKittyPrintable(data) ?? (printable(data) ? data : undefined);
		if (ch !== undefined) {
			this.filter += ch;
			this.rebuild();
			return;
		}
		// Selection can change inside the list (arrows, mouse): drop the cached
		// lines so the marker moves on screen (the preset.ts lesson: it renders
		// uncached for the same reason).
		this.selectList?.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// Route through the container: it offsets y per child, so the list rows get
		// local coordinates (raw forwarding clicks the row above — border+header).
		const result = this.container?.handleMouse(event);
		this.invalidate();
		this.tui.requestRender();
		return result;
	}
}

export default function (pi: ExtensionAPI) {
	// In-memory state, rebuilt from tool-result details on session events.
	let tasks: Task[] = [];
	let nextId = 1;

	/**
	 * Append the board snapshot after a change. Called after every board change;
	 * the log is the session's board history (latest line = current board).
	 * Fail-open: persistence never blocks board work.
	 */
	const persist = (ctx: ExtensionContext): void => {
		try {
			appendSnapshot(ctx.sessionManager.getSessionId(), tasks, nextId);
		} catch {
			// ignore — the transcript snapshot remains the source of truth
		}
	};

	const reconstructState = (ctx: ExtensionContext) => {
		tasks = [];
		nextId = 1;
		let fromBranch = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "mission") continue;
			const details = msg.details as MissionDetails | undefined;
			if (details) {
				tasks = details.tasks;
				nextId = details.nextId;
				fromBranch = true;
			}
		}
		if (fromBranch) return;
		// Session-bound persistence (the /tree model): replay this session's own
		// append log. Boards never cross sessions — a fresh session starts empty.
		const snap = readSnapshot(ctx.sessionManager.getSessionId());
		if (snap) {
			tasks = snap.tasks;
			nextId = snap.nextId;
		}
	};
	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// Autonomy: the agent maintains the board as it works — the tool does not
	// wait to be asked. The user's popup actions arrive as "Mission override"
	// messages and are manual state changes. Only injected while the mission tool
	// is active for the run.
	pi.on("before_agent_start", (event) => {
		if (event.systemPromptOptions.selectedTools?.includes("mission")) {
			event.systemPromptOptions.sections.mission =
				"Maintain the mission board autonomously with the `mission` tool: add a task the moment " +
				"work appears (including rabbit holes and ad-hoc requests), start it when work begins, " +
				"mark it done when it completes, and keep prerequisites accurate. Do not wait to be asked. " +
				"The board is the source of truth for work items — anything that is a task (planned, started, " +
				"or remaining) goes on the mission board, not into a scratch or todo list. " +
				`${granularityRule()} ` +
				"A message that starts with \"Mission override\" is a manual state change from the user — " +
				"apply it exactly and do not relitigate it.";
		} else {
			delete event.systemPromptOptions.sections.mission;
		}
	});

	const snapshot = (action: MissionAction, text: string, error?: string) => ({
		content: [{ type: "text" as const, text }],
		details: {
			action,
			tasks: tasks.map((t) => ({ ...t })),
			nextId,
			...(error ? { error } : {}),
		} as MissionDetails,
	});

	pi.registerTool({
		name: "mission",
		label: "Mission",
		description:
			"Track the session's tasks on a mission board. The board is the source of truth for work " +
			"items — anything that is a task (planned, started, or remaining) belongs here, not in a " +
			"scratch or todo list. Maintain it autonomously during your work: " +
			"add a task the moment work appears — including rabbit holes and ad-hoc tasks — start it " +
			"when work begins, and mark it done when it completes. Do not wait to be asked. " +
			"Messages that start with 'Mission override' are manual state changes from the user — " +
			"apply them exactly. " +
			"Actions: add (title? for an explicit name, or capture? with a raw thought — a concise " +
			"name is generated with a bargain-tier model; parent? for a subtask, depends_on? for prerequisites, " +
			"priority? high/normal/low; tasks? adds several in one call — one entry per task), " +
			"dep (id, depends_on — set prerequisites, rejects cycles), " +
			"prio (id, priority — high/normal/low), " +
			"start (id), done (id), drop (id), list. " +
			"Use list to see what runs now, what finished, and what remains in dependency order. " +
			"The user views the board with /mission, or the alt+k / ctrl+shift+k shortcut.",
		parameters: MissionParams,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const setDeps = (t: Task, deps: number[]): string | undefined => {
				for (const d of deps) {
					if (d === t.id) return `task #${t.id} cannot depend on itself`;
					if (!findTask(tasks, d)) return `unknown prerequisite #${d}`;
					if (reaches(tasks, t.id, d)) return `prerequisite #${d} would create a dependency cycle`;
				}
				t.dependsOn = [...new Set(deps)];
				t.updatedAt = Date.now();
				return undefined;
			};

			switch (params.action) {
				case "add": {
					// One item or many (tasks[]): the same shape per item. The batch is
					// validated up front so a bad item never half-applies it.
					const items: AddItem[] = params.tasks && params.tasks.length > 0
						? params.tasks as AddItem[]
						: [{ title: params.title, capture: params.capture, parent: params.parent,
							depends_on: params.depends_on, priority: params.priority }];
					for (const [n, item] of items.entries()) {
						const where = items.length > 1 ? ` (task ${n + 1})` : "";
						if (!item.title && !item.capture?.trim()) {
							return snapshot("add", `Error: title or capture required${where}`, "title or capture required");
						}
						if (item.parent !== undefined) {
							const p = findTask(tasks, item.parent);
							if (!p || p.parent !== null) {
								return snapshot("add", `Error: parent #${item.parent} must be an existing top-level task${where}`, "bad parent");
							}
						}
						for (const d of item.depends_on ?? []) {
							// A brand-new task cannot close a cycle, so existence is the only check.
							if (!findTask(tasks, d)) {
								return snapshot("add", `Error: unknown prerequisite #${d}${where}`, `unknown prerequisite #${d}`);
							}
						}
					}
					let usage: AgentToolResult<never>["usage"];
					const notes: string[] = [];
					for (const item of items) {
						// Explicit name wins. Otherwise a bargain-tier model names the capture.
						let title = item.title ?? "";
						if (!title) {
							const named = await generateName(_ctx, (item.capture as string).trim(), tasks.map((t) => t.title));
							title = named.title;
							usage = named.usage ?? usage;
						}
						const parent = item.parent !== undefined ? findTask(tasks, item.parent) : undefined;
						const task: Task = {
							id: nextId++,
							title,
							status: "pending",
							priority: item.priority,
							parent: parent ? parent.id : null,
							dependsOn: [...new Set(item.depends_on ?? [])],
							createdAt: Date.now(),
							updatedAt: Date.now(),
						};
						tasks.push(task);
						notes.push(`${parent ? "subtask" : "task"} #${task.id}: ${task.title}${item.title ? "" : " (named from capture)"}`);
					}
					persist(_ctx);
					const result = notes.length === 1
						? snapshot("add", `Added ${notes[0]}`)
						: snapshot("add", `Added ${notes.length} tasks: ${notes.join("; ")}`);
					return usage ? { ...result, usage } : result;
				}

				case "dep": {
					const t = params.id !== undefined ? findTask(tasks, params.id) : undefined;
					if (!t) return snapshot("dep", `Error: task #${params.id ?? "?"} not found`, "not found");
					const err = setDeps(t, params.depends_on ?? []);
					if (err) return snapshot("dep", `Error: ${err}`, err);
					const shown = t.dependsOn.length > 0 ? t.dependsOn.map((d) => `#${d}`).join(",") : "none";
					persist(_ctx);
					return snapshot("dep", `Task #${t.id} prerequisites set to ${shown}`);
				}

				case "prio": {
					const t = params.id !== undefined ? findTask(tasks, params.id) : undefined;
					if (!t) return snapshot("prio", `Error: task #${params.id ?? "?"} not found`, "not found");
					if (!params.priority) {
						return snapshot("prio", "Error: priority required (high/normal/low)", "priority required");
					}
					t.priority = params.priority;
					t.updatedAt = Date.now();
					persist(_ctx);
					return snapshot("prio", `Task #${t.id} priority set to ${params.priority}`);
				}

				case "start": {
					const t = params.id !== undefined ? findTask(tasks, params.id) : undefined;
					if (!t) return snapshot("start", `Error: task #${params.id ?? "?"} not found`, "not found");
					if (t.status === "done" || t.status === "dropped") {
						return snapshot("start", `Task #${t.id} is already ${t.status}`);
					}
					t.status = "active";
					t.startedAt = t.startedAt ?? Date.now();
					t.updatedAt = Date.now();
					if (t.parent !== null) {
						const parent = findTask(tasks, t.parent);
						if (parent && parent.status === "pending") {
							parent.status = "active";
							parent.startedAt = parent.startedAt ?? Date.now();
						}
					}
					persist(_ctx);
					const w = waitingOn(tasks, t);
					const note = w.length > 0 ? ` — note: waiting on ${w.map((d) => `#${d}`).join(",")}` : "";
					return snapshot("start", `Started #${t.id}: ${t.title}${note}`);
				}

				case "done": {
					const t = params.id !== undefined ? findTask(tasks, params.id) : undefined;
					if (!t) return snapshot("done", `Error: task #${params.id ?? "?"} not found`, "not found");
					if (t.status === "done") return snapshot("done", `Task #${t.id} is already done`);
					t.status = "done";
					t.doneAt = Date.now();
					t.updatedAt = Date.now();
					persist(_ctx);
					const open = tasks.filter((s) => s.parent === t.id && s.status !== "done" && s.status !== "dropped");
					const note = open.length > 0 ? ` — note: open subtasks ${open.map((s) => `#${s.id}`).join(",")}` : "";
					return snapshot("done", `Done #${t.id}: ${t.title}${note}`);
				}

				case "drop": {
					const t = params.id !== undefined ? findTask(tasks, params.id) : undefined;
					if (!t) return snapshot("drop", `Error: task #${params.id ?? "?"} not found`, "not found");
					t.status = "dropped";
					t.updatedAt = Date.now();
					persist(_ctx);
					return snapshot("drop", `Dropped #${t.id}: ${t.title}`);
				}

				case "list":
				default:
					return snapshot("list", boardText(tasks));
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("mission ")) + theme.fg("muted", String(args.action));
			if (args.title) text += ` ${theme.fg("dim", `"${args.title}"`)}`;
			if (args.tasks?.length) text += ` ${theme.fg("dim", `+${args.tasks.length}`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as MissionDetails | undefined;
			const fallback = result.content[0];
			const plain = fallback?.type === "text" ? fallback.text : "";
			if (!details) return new Text(plain, 0, 0);
			if (details.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			if (details.action === "list") {
				const rows = boardRows(details.tasks);
				const shown = expanded ? rows : rows.slice(0, 8);
				let text = rows.length === 0 ? theme.fg("dim", "No tasks") : "";
				for (const row of shown) {
					const line = row.kind === "title" ? theme.fg("accent", row.text)
						: row.kind === "section" ? theme.fg("muted", row.text)
						: row.kind === "active" ? theme.fg("text", row.text)
						: theme.fg("dim", row.text);
					text += (text ? "\n" : "") + line;
				}
				if (!expanded && rows.length > shown.length) {
					text += `\n${theme.fg("dim", `… ${rows.length - shown.length} more`)}`;
				}
				return new Text(text, 0, 0);
			}
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", plain), 0, 0);
		},
	});

	// The board popup, shared by the /mission command and the keyboard shortcuts.
	const openBoard = async (ctx: ExtensionContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(boardText(tasks), "info");
				return;
			}

			let initial: string | undefined;
			for (;;) {
				const picked = await ctx.ui.custom<MissionPick>(
					(tui, theme, kb, done) => new MissionPopup(tasks, theme, tui, kb, done, initial),
					{ overlay: true, overlayOptions: { width: "72%", minWidth: 44, maxHeight: "64%" } },
				);
				if (!picked) return;

				if (picked.kind === "add") {
					const title = await ctx.ui.input("Add a task", "rough thought — a concise name is generated");
					if (!title) return;
					await pi.sendUserMessage(`Mission: add task (capture: ${JSON.stringify(title)}, generate a concise name)`);
					ctx.ui.notify("Task sent to the agent", "info");
					return;
				}

				const task = findTask(tasks, picked.id);
				if (!task) return;
				// Only offer actions that apply to this task's state.
				const actions = menuActions(task.status);
				if (actions.length === 0) {
					ctx.ui.notify(`Task #${task.id} is dropped — no actions apply`, "info");
					initial = `t${task.id}`;
					continue;
				}
				const action = await ctx.ui.select(`Task #${task.id} — ${task.title}`, actions);
				// Cancel re-opens the board at the same row (the /tree picker pattern).
				if (!action) {
					initial = `t${task.id}`;
					continue;
				}
				if (action === "priority") {
					const priority = await ctx.ui.select(`Priority for #${task.id} — ${task.title}`, ["high", "normal", "low"]);
					if (!priority) {
						initial = `t${task.id}`;
						continue;
					}
					await pi.sendUserMessage(`Mission override: set task #${task.id} (${task.title}) priority to ${priority}`);
					ctx.ui.notify(`Sent to the agent: ${priority} priority on #${task.id}`, "info");
					return;
				}
				// State changes leave as manual overrides of the autonomous board.
				const msg = action === "start"
					? `Mission override: start task #${task.id} (${task.title})`
					: action === "done"
						? `Mission override: mark task #${task.id} (${task.title}) done`
						: `Mission override: drop task #${task.id} (${task.title})`;
				await pi.sendUserMessage(msg);
				ctx.ui.notify(`Sent to the agent: ${action} #${task.id}`, "info");
				return;
			}
	};

	pi.registerCommand("mission", {
		description: "Show the mission list popup: current work, what was done, and remaining tasks in dependency order",
		handler: async (_args, ctx) => openBoard(ctx),
	});

	// Carrying unfinished work over from a previous session is explicit and
	// user-driven. The command only composes the request; the agent makes the one
	// batch add, so the change lands in a tool result and survives branch replay.
	pi.registerCommand("mission-handoff", {
		description: "Carry over earlier sessions' unfinished tasks to this session's board",
		handler: async (_args, ctx) => {
			const found = handoffSources(ctx.sessionManager.getSessionId());
			if (found.length === 0) {
				ctx.ui.notify("No unfinished tasks in earlier session boards", "info");
				return;
			}
			const onBoard = new Set(tasks.map((t) => t.title));
			const sources = found
				.map((s) => ({ session: s.session, tasks: s.tasks.filter((t) => !onBoard.has(t.title)) }))
				.filter((s) => s.tasks.length > 0);
			if (sources.length === 0) {
				ctx.ui.notify("Earlier sessions' unfinished tasks are already on this board", "info");
				return;
			}
			const open = sources.flatMap((s) => s.tasks);
			await pi.sendUserMessage(
				`Mission: add the unfinished tasks of earlier sessions to this board with one ` +
				`batch add (mission action add, tasks: [{ title }, …]): ` +
				sources.flatMap((s) =>
					s.tasks.map((t) => `#${t.id} ${JSON.stringify(t.title)} (${t.status}) from session ${s.session}`),
				).join(", ") +
				` — sources: ${sources.map((s) => join(storeDir(), `${s.session}.jsonl`)).join(", ")}`,
			);
			ctx.ui.notify(
				`Sent to the agent: ${open.length} unfinished task${open.length === 1 ? "" : "s"} ` +
				`from session${sources.length === 1 ? "" : "s"} ${sources.map((s) => s.session).join(", ")}`,
				"info",
			);
		},
	});

	// ⌃K is taken (tui.editor.deleteToLineEnd). ⌥M matches the extension name;
	// ⌥J keeps the game convention (the mission list is the quest journal —
	// Elder Scrolls, BG3, Witcher, FFXIV); ⌃⇧K is the closest feel to ⌃K
	// (CSI-u terminals such as Ghostty).
	pi.registerShortcut("alt+j", { description: "Show the task/mission board", handler: (ctx) => openBoard(ctx) });
	pi.registerShortcut("alt+m", { description: "Show the mission list", handler: (ctx) => openBoard(ctx) });
	pi.registerShortcut("ctrl+shift+k", { description: "Show the mission board", handler: (ctx) => openBoard(ctx) });
}
