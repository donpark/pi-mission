// Self-test for pi-mission: loads index.ts through pi's own jiti (with the same
// packages pi resolves), then drives the mission tool without a model.
// Run: node selftest.mjs
import assert from "node:assert";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Persist to a scratch store for the test.
const storeFile = path.join(os.tmpdir(), "pi-mission-selftest-store.json");
process.env.PI_MISSION_STORE = storeFile;
fs.rmSync(storeFile, { force: true });

const ctxStub = { sessionManager: { getSessionId: () => "test-session" } };

// The packages the extension imports at runtime: pi's managed install when
// present, else the repo's node_modules (CI runs `npm install --no-save jiti
// typebox @earendil-works/pi-tui @earendil-works/pi-coding-agent` first).
const releases = path.join(process.env.HOME, ".pi/agent/install/releases");
const hasRuntime = (p) => fs.existsSync(path.join(p, "typebox")) && fs.existsSync(path.join(p, "jiti"));
let piModules;
try {
	piModules = fs.readdirSync(releases)
		.map((d) => path.join(releases, d, "node_modules"))
		.filter(hasRuntime)
		.sort()
		.pop();
} catch {
	// no managed pi install
}
if (!piModules) {
	const local = path.join(here, "..", "..", "node_modules");
	if (hasRuntime(local)) piModules = local;
}
assert.ok(piModules, "runtime node_modules not found — install pi, or: npm install --no-save jiti typebox @earendil-works/pi-tui @earendil-works/pi-coding-agent");

// Alias each bare specifier to its entry FILE. Exports-map packages (typebox,
// pi-coding-agent) do not resolve as absolute directories or via require.resolve.
const entry = (...parts) => {
	const p = path.join(piModules, ...parts);
	assert.ok(fs.existsSync(p), `entry not found: ${p}`);
	return p;
};
const alias = {
	typebox: entry("typebox", "build", "index.mjs"),
	"@earendil-works/pi-tui": entry("@earendil-works", "pi-tui", "dist", "index.js"),
	"@earendil-works/pi-coding-agent": entry("@earendil-works", "pi-coding-agent", "dist", "index.js"),
};

const jitiLib = require(path.join(piModules, "jiti"));
const createJiti = jitiLib.createJiti ?? jitiLib.default?.createJiti;
const jiti = createJiti(pathToFileURL(path.join(here, "selftest.mjs")).href, { alias });
const mod = await jiti.import(path.join(here, "index.ts"));

// Stub ExtensionAPI: capture registrations and event handlers.
let tool;
const commands = [];
const shortcuts = [];
const handlers = {};
const pi = {
	registerTool(t) { tool = t; },
	registerCommand(name, c) { commands.push({ name, ...c }); },
	registerShortcut(key, opts) { shortcuts.push({ key, ...opts }); },
	on(name, fn) { handlers[name] = fn; return () => {}; },
	sendUserMessage() {},
};
mod.default(pi);
assert.equal(tool?.name, "mission", "registers the mission tool");
const command = commands.find((c) => c.name === "mission");
assert.ok(command, "registers the /mission command");
assert.deepEqual(shortcuts.map((s) => s.key).sort(), ["alt+j", "alt+m", "ctrl+shift+k"],
	"registers all board shortcuts");
assert.ok(shortcuts.every((s) => typeof s.handler === "function"), "shortcuts share the board handler");

// The autonomy guideline rides along only while the mission tool is active.
assert.ok(handlers.before_agent_start, "registers a before_agent_start handler");
const opts = { selectedTools: ["mission", "read"], sections: {} };
handlers.before_agent_start({ systemPromptOptions: opts });
assert.match(opts.sections.mission, /autonomously/);
assert.match(opts.sections.mission, /Mission override/);
const opts2 = { selectedTools: ["read"], sections: { mission: "stale" } };
handlers.before_agent_start({ systemPromptOptions: opts2 });
assert.equal(opts2.sections.mission, undefined, "guideline removed when mission is inactive");

// The stub tool context has no modelRegistry — generateName must fail open.
const call = (params) => tool.execute("tc", params, undefined, () => {}, ctxStub);
const textOf = (r) => r.content[0].text;
const tasksOf = (r) => r.details.tasks;

// add: tasks and a subtask
let r = await call({ action: "add", title: "Write the exporter" });
assert.match(textOf(r), /Added task #1/);
r = await call({ action: "add", title: "Audit leak sources" });
assert.match(textOf(r), /Added task #2/);
r = await call({ action: "add", title: "Ship release" });
assert.match(textOf(r), /Added task #3/);
r = await call({ action: "add", title: "Run tests" });
assert.match(textOf(r), /Added task #4/);
r = await call({ action: "add", title: "Tag the release", parent: 3 });
assert.match(textOf(r), /Added subtask #5/);

// dep: an inversion — #3 waits on #4, so remaining order must flip creation order
r = await call({ action: "dep", id: 3, depends_on: [4] });
assert.match(textOf(r), /prerequisites set to #4/);
assert.equal(tasksOf(r).find((t) => t.id === 3).dependsOn[0], 4);

// list: remaining shows #4 before #3, #3 marked after #4
r = await call({ action: "list" });
const board = textOf(r);
const i4 = board.indexOf("#4 Run tests");
const i3 = board.indexOf("#3 Ship release");
assert.ok(i3 > 0 && i4 > 0 && i4 < i3, `dependency order: #4 must precede #3\n${board}`);
assert.match(board, /#3 Ship release \(after #4\)/);
assert.match(board, /#5 Tag the release/);

// cycle rejection
r = await call({ action: "dep", id: 4, depends_on: [3] });
assert.match(textOf(r), /dependency cycle/);
assert.ok(r.details.error, "cycle sets details.error");

// unknown prerequisite rejection
r = await call({ action: "dep", id: 4, depends_on: [99] });
assert.match(textOf(r), /unknown prerequisite #99/);

// start: subtask start activates its supertask too
r = await call({ action: "start", id: 5 });
assert.equal(tasksOf(r).find((t) => t.id === 5).status, "active");
assert.equal(tasksOf(r).find((t) => t.id === 3).status, "active");
assert.equal(tasksOf(r).find((t) => t.id === 3).startedAt > 0, true);

// done: supertask is not auto-done; done with an open subtask warns
r = await call({ action: "done", id: 5 });
assert.equal(tasksOf(r).find((t) => t.id === 5).status, "done");
assert.equal(tasksOf(r).find((t) => t.id === 3).status, "active");
r = await call({ action: "add", title: "Add regression tests", parent: 1 });
assert.match(textOf(r), /Added subtask #6/);
r = await call({ action: "done", id: 1 });
assert.match(textOf(r), /Done #1[\s\S]*open subtasks #6/);
assert.equal(tasksOf(r).find((t) => t.id === 1).status, "done");
assert.equal(tasksOf(r).find((t) => t.id === 6).status, "pending");

// drop
r = await call({ action: "drop", id: 2 });
assert.equal(tasksOf(r).find((t) => t.id === 2).status, "dropped");

// capture without an explicit name: naming fails open (no model registry in the
// stub), so the cleaned capture text becomes the name
r = await call({ action: "add", capture: "  look into that weird crash on hangup  " });
assert.match(textOf(r), /Added task #7: look into that weird crash on hangup \(named from capture\)/);
assert.equal(tasksOf(r).find((t) => t.id === 7).title, "look into that weird crash on hangup");

// explicit title is used verbatim and never marked as generated
r = await call({ action: "add", title: "Explicit Name", capture: "ignored raw text" });
assert.match(textOf(r), /Added task #8: Explicit Name$/);
assert.equal(tasksOf(r).find((t) => t.id === 8).title, "Explicit Name");

// neither title nor capture is an error
r = await call({ action: "add" });
assert.match(textOf(r), /title or capture required/);
assert.ok(r.details.error);

// every result carries the full snapshot for branch-aware reconstruction
r = await call({ action: "list" });
assert.equal(r.details.action, "list");
assert.equal(r.details.tasks.length, 8);
assert.equal(typeof r.details.nextId, "number");

// board text shows the sections and the completed work
const finalBoard = textOf(r);
assert.match(finalBoard, /done:/);
assert.match(finalBoard, /✓ #5 Tag the release/);
assert.match(finalBoard, /dropped:/);

// popupRows: view modes and folding (the /mission popup's item set)
const allTasks = r.details.tasks;
const ids = (rows) => rows.map((row) => row.task.id);
const openRows = ids(mod.popupRows(allTasks, "open", new Set()));
assert.ok(!openRows.includes(1) && !openRows.includes(2) && !openRows.includes(6),
	`open view hides done/dropped groups\n${openRows}`);
assert.ok(openRows.includes(3) && openRows.includes(5) && openRows.includes(4),
	`open view keeps active and pending groups\n${openRows}`);
const currentRows = ids(mod.popupRows(allTasks, "current", new Set()));
assert.ok(currentRows.includes(3) && currentRows.includes(5) && !currentRows.includes(4),
	`current view keeps only active groups\n${currentRows}`);
const foldedRows = ids(mod.popupRows(allTasks, "all", new Set([3])));
assert.ok(foldedRows.includes(3) && !foldedRows.includes(5),
	`folding #3 hides its subtask #5\n${foldedRows}`);

// priority + sort modes (the popup's ctrl+s cycle)
r = await call({ action: "prio", id: 4, priority: "high" });
assert.match(textOf(r), /priority set to high/);
r = await call({ action: "prio", id: 99, priority: "low" });
assert.match(textOf(r), /not found/);
const sorted = r.details.tasks;
// Wall-clock ties in a fast test: make timeline order deterministic (createdAt
// is Date.now() at add, and all test adds land in the same millisecond).
sorted.forEach((t) => {
	t.createdAt = t.id * 1000;
});
const firstId = (sort) => mod.popupRows(sorted, "all", new Set(), sort)[0].task.id;
assert.equal(firstId("priority"), 4, "priority sort puts high first");
assert.equal(firstId("recent"), 8, "recent sort puts newest first");
assert.equal(firstId("oldest"), 1, "oldest sort puts oldest first");
const byStatus = mod.popupRows(sorted, "all", new Set(), "status")
	.filter((row) => row.task.parent === null).map((row) => row.task.id);
assert.equal(byStatus[0], 3, `status sort starts with the active task\n${byStatus}`);
assert.equal(byStatus[byStatus.length - 1], 2, `status sort ends with dropped\n${byStatus}`);
const prioShown = mod.popupRows(sorted, "all", new Set(), "board").find((row) => row.task.id === 4);
assert.match(prioShown.text, /\(high\)/, "priority is visible on the row");

// persistence: one record per task, updated in place as the board changes
const store = JSON.parse(fs.readFileSync(storeFile, "utf8"));
assert.equal(store.version, 1);
assert.ok(store.updatedAt > 0, "updatedAt is maintained");
const mine = store.tasks.filter((t) => t.session === "test-session");
assert.equal(mine.length, 8, `one record per task\n${JSON.stringify(mine.map((t) => t.id))}`);
assert.equal(mine.find((t) => t.id === 1).status, "done", "done upserts the same record");
assert.equal(mine.find((t) => t.id === 4).priority, "high", "prio is persisted");
assert.deepEqual(mine.find((t) => t.id === 3).dependsOn, [4], "dep is persisted");

// cross-session carry-over: a fresh session adopts open work, renumbered
handlers.session_start(null, {
	sessionManager: { getSessionId: () => "fresh-session", getBranch: () => [] },
});
r = await call({ action: "list" });
const adopted = textOf(r);
assert.match(adopted, /#1 Ship release [^\n]*\(after #2\)/, "adopted task keeps its prerequisite (renumbered)");
assert.match(adopted, /#2 Run tests \(high\)/, "adopted task keeps priority");
assert.match(adopted, /#4 Write the exporter/, "parent chain is adopted for grouping");
assert.match(adopted, /   ✓ #3 Add regression tests|   ○ #3 Add regression tests/, "adopted subtask stays under its parent");
assert.ok(!adopted.includes("Audit leak sources"), "dropped work is not carried over");
assert.ok(!adopted.includes("Tag the release"), "finished subtasks are not carried over");
assert.match(adopted, /#5 look into that weird crash on hangup/);

// popup input review: every input class has a scenario — arrows/marker render,
// fold on plain arrows, enter, home/end/page, bracketed paste, mouse row offsets
// (regression: a stale render cache once froze the marker while Enter acted elsewhere)
const piTui = await jiti.import(alias["@earendil-works/pi-tui"]);
const realKb = new piTui.KeybindingsManager(piTui.TUI_KEYBINDINGS);
const theme = new Proxy({}, { get: () => (...args) => String(args[args.length - 1]) });
const fakeTui = { requestRender() {} };
// a subtask under the first group so fold has something to hide
await call({ action: "add", title: "Sub for fold", parent: 1 });

async function openPopup() {
	let component;
	const selects = [];
	const inputs = [];
	let resolvePick;
	const picked = new Promise((r) => {
		resolvePick = r;
	});
	let calls = 0;
	const run = command.handler("", {
		mode: "tui",
		ui: {
			custom: (factory) => {
				calls += 1;
				// Later calls are the re-open-on-cancel loop: escape immediately.
				if (calls > 1) return Promise.resolve(null);
				component = factory(fakeTui, theme, realKb, resolvePick);
				return picked;
			},
			select: async (title, options) => {
				selects.push({ title, options });
				return options[0];
			},
			input: async (title) => {
				inputs.push(title);
				return null;
			},
			notify: () => {},
		},
	});
	await new Promise((r) => setTimeout(r, 0));
	return {
		component,
		selects,
		inputs,
		run,
		view: () => component.render(80).join("\n"),
		mouse: (y) => component.handleMouse({
			type: "click", button: "left", x: 2, y, screenX: 2, screenY: y,
			width: 80, height: 20, shift: false,
		}),
	};
}

// 1) opens on the current task (first active), arrows move, render follows;
//    plain left/right fold
{
	const p = await openPopup();
	const initial = p.view();
	assert.ok(/→.*Ship release/.test(initial), `opens on the active task\n${initial}`);
	p.component.handleInput("\x1b[B");
	const after = p.view();
	assert.notEqual(after, initial, "render updates when the selection moves");
	assert.ok(/→.*Sub for fold/.test(after), `selection marker moved to the next row\n${after}`);
	p.component.handleInput("\x1b[D");
	assert.ok(!p.view().includes("Sub for fold"), "left folds the group's subtasks away");
	p.component.handleInput("\x1b[C");
	assert.ok(p.view().includes("Sub for fold"), "right unfolds the group");
	p.component.handleInput("\x1b");
	await p.run;
	assert.equal(p.selects.length, 0, "escape closes without a dialog");
}

// 2) enter acts on the selected row, not on row 0
{
	const p = await openPopup();
	p.component.handleInput("\x1b[B");
	p.component.handleInput("\x1b[B");
	p.component.handleInput("\r");
	await p.run;
	assert.equal(p.selects.length, 1, "enter opens the action dialog once");
	assert.match(p.selects[0].title, /^Task #\d+ — /);
}

// 3) home/end/page keys jump the marker
{
	const p = await openPopup();
	p.component.handleInput("\x1b[F");
	assert.ok(/→.*Add regression tests/.test(p.view()), `end jumps to the last row\n${p.view()}`);
	p.component.handleInput("\x1b[5~");
	assert.ok(/→.*add task/.test(p.view()), "page up clamps to the first row");
	p.component.handleInput("\x1b[6~");
	assert.ok(/→.*Add regression tests/.test(p.view()), "page down clamps to the last row");
	p.component.handleInput("\x1b[H");
	assert.ok(/→.*add task/.test(p.view()), "home jumps to the first row");
	p.component.handleInput("\x1b");
	await p.run;
}

// 4) bracketed paste goes to the filter (title-only matching — no status words)
{
	const p = await openPopup();
	p.component.handleInput("\x1b[200~explicit\x1b[201~");
	const v = p.view();
	assert.ok(v.includes("Explicit Name") && !v.includes("Ship release"), `paste filters\n${v}`);
	p.component.handleInput("\x1b");
	p.component.handleInput("\x1b");
	await p.run;
}

// 5) mouse clicks land on the right rows (row y = its rendered line index)
{
	const p = await openPopup();
	const lines = p.view().split("\n");
	p.mouse(0);
	assert.equal(p.selects.length + p.inputs.length, 0, "click on the first (non-list) row does nothing");
	p.mouse(lines.findIndex((l) => l.includes("＋ add task")));
	await new Promise((r) => setTimeout(r, 0)); // dialogs run in the handler continuation
	assert.equal(p.inputs.length, 1, "click on the add row opens the input dialog");
	await p.run;
}
{
	const p = await openPopup();
	const lines = p.view().split("\n");
	p.mouse(lines.findIndex((l) => l.includes("Ship release")));
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(p.selects.length, 1, "click on a task row opens the action dialog");
	await p.run;
}

// 6) the action menu hides entries that do not apply to the task's state
//    (the filter is typed as one chunk here: non-bracketed paste / coalesced input)
assert.deepEqual(mod.menuActions("pending"), ["start", "done", "priority", "drop"]);
assert.deepEqual(mod.menuActions("active"), ["done", "priority", "drop"]);
assert.deepEqual(mod.menuActions("done"), ["drop"]);
assert.deepEqual(mod.menuActions("dropped"), []);
{
	const p = await openPopup();
	const lines = p.view().split("\n");
	p.mouse(lines.findIndex((l) => l.includes("Write the exporter"))); // done task
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(p.selects[0].options, ["drop"], "a finished task offers only drop");
	await p.run;
}
{
	const p = await openPopup();
	const lines = p.view().split("\n");
	p.mouse(lines.findIndex((l) => l.includes("Ship release"))); // active task
	await new Promise((r) => setTimeout(r, 0));
	assert.ok(!p.selects[0].options.includes("start"), "an active task offers no start");
	assert.deepEqual(p.selects[0].options, ["done", "priority", "drop"]);
	await p.run;
}
{
	// a dropped task has no actions: the menu does not open, the board re-shows
	const p = await openPopup();
	await call({ action: "add", title: "Doomed task" });
	const added = await call({ action: "list" });
	const doomed = added.details.tasks.find((t) => t.title === "Doomed task");
	await call({ action: "drop", id: doomed.id });
	p.component.handleInput("doomed");
	p.component.handleInput("\r");
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(p.selects.length, 0, "no action menu for a dropped task");
	await p.run;
}

// 7) with no active task, the popup opens on the most recently added one
{
	const listed = await call({ action: "list" });
	const ship = listed.details.tasks.find((t) => t.status === "active");
	await call({ action: "drop", id: ship.id });
	await call({ action: "add", title: "Fresh capture task" });
	const p = await openPopup();
	assert.ok(/→.*Fresh capture task/.test(p.view()), `opens on the most recent task\n${p.view()}`);
	p.component.handleInput("\x1b");
	await p.run;
}

console.log("pi-mission selftest: all assertions passed");
