// The demo's Todo controller, tested in plain Node: no browser, no DOM, no UI5 tooling.
// Its UI5 imports are replaced by small fixtures (test/fixtures/ui5/) through Node's module hooks.
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ui5-fixtures-hooks.mjs", import.meta.url);

/** A JSONModel stand-in: getProperty/setProperty on a plain object. */
function fakeModel(data) {
	const at = (path) => path.split("/").filter(Boolean);
	return {
		data,
		getProperty: (path) => at(path).reduce((o, k) => o?.[k], data),
		setProperty(path, value) {
			const keys = at(path);
			keys.slice(0, -1).reduce((o, k) => o[k], data)[keys.at(-1)] = value;
		},
		dataLoaded: () => Promise.resolve(),
	};
}

let App;
before(async () => {
	App = (await import("../demo/esm/controller/App.controller.js")).default;
});

function setup() {
	const model = fakeModel({
		newTodo: "",
		openCount: 0,
		todos: [{ title: "a", done: true }, { title: "b", done: false }],
	});
	const filters = [];
	const view = {
		component: { getModel: () => model },
		byId: (id) => (id === "todoList" ? { getBinding: () => ({ filter: (f) => filters.push(f) }) } : null),
	};
	const controller = new App(view);
	controller.onInit();
	return { controller, model, filters };
}

describe("Todo controller (demo/esm/controller/App.controller.js) in Node", () => {
	test("is the demo's controller; the bundles/ copy runs on the same fixtures", async () => {
		assert.equal(App.controllerName, "demo.todo.controller.App");
		const Bundles = (await import("../demo/bundles/controller/App.controller.js")).default;
		assert.equal(Bundles.controllerName, "demo.todo.controller.App");
	});
	test("onInit counts open todos", async () => {
		const { model } = setup();
		await Promise.resolve();
		assert.equal(model.data.openCount, 1);
	});
	test("onAdd adds a trimmed todo, clears the input, ignores empty input", () => {
		const { controller, model } = setup();
		model.setProperty("/newTodo", "  write tests  ");
		controller.onAdd();
		assert.deepEqual(model.data.todos.at(-1), { title: "write tests", done: false });
		assert.equal(model.data.newTodo, "");
		assert.equal(model.data.openCount, 2);
		controller.onAdd();
		assert.equal(model.data.todos.length, 3);
	});
	test("onDelete removes the item behind the list item's binding path", () => {
		const { controller, model } = setup();
		controller.onDelete({ getParameter: () => ({ getBindingContext: () => ({ getPath: () => "/todos/1" }) }) });
		assert.deepEqual(model.data.todos, [{ title: "a", done: true }]);
		assert.equal(model.data.openCount, 0);
	});
	test("onFilter filters the list binding by done state", () => {
		const { controller, filters } = setup();
		const item = (key) => ({ getParameter: () => ({ getKey: () => key }) });
		controller.onFilter(item("done"));
		controller.onFilter(item("open"));
		controller.onFilter(item("all"));
		assert.deepEqual(filters.map((f) => f.map((x) => ({ ...x }))), [
			[{ path: "done", operator: "EQ", value: true }],
			[{ path: "done", operator: "EQ", value: false }],
			[],
		]);
	});
});
