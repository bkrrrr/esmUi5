import Controller from "../../../esm/sap/ui/core/mvc/Controller.js";
import Filter from "../../../esm/sap/ui/model/Filter.js";
import FilterOperator from "../../../esm/sap/ui/model/FilterOperator.js";

export default Controller.extend("demo.todo.controller.App", {
	onInit() {
		// the default model is declared in manifest.json (model/todos.json)
		this.model = this.getOwnerComponent().getModel();
		this.model.dataLoaded().then(() => this.updateCount());
	},

	onAdd() {
		const title = this.model.getProperty("/newTodo").trim();
		if (!title) return;
		this.model.setProperty("/todos", [...this.model.getProperty("/todos"), { title, done: false }]);
		this.model.setProperty("/newTodo", "");
		this.updateCount();
	},

	onToggle() {
		this.updateCount();
	},

	onDelete(event) {
		const path = event.getParameter("listItem").getBindingContext().getPath(); // "/todos/2"
		const index = Number(path.split("/").pop());
		this.model.setProperty("/todos", this.model.getProperty("/todos").filter((_, i) => i !== index));
		this.updateCount();
	},

	onFilter(event) {
		const key = event.getParameter("item").getKey();
		const filters = key === "all" ? [] : [new Filter("done", FilterOperator.EQ, key === "done")];
		this.byId("todoList").getBinding("items").filter(filters);
	},

	updateCount() {
		this.model.setProperty("/openCount", this.model.getProperty("/todos").filter((t) => !t.done).length);
	},
});
