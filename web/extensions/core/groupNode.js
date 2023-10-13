import { app } from "../../scripts/app.js";
import { getWidgetType } from "../../scripts/widgets.js";

const IS_GROUP_NODE = Symbol();
const GROUP_DATA = Symbol();
const GROUP_SLOTS = Symbol();

function getLinks(config) {
	const linksFrom = {};
	const linksTo = {};

	// Extract links for easy lookup
	for (const l of config.links) {
		const [outputNodeId, outputNodeSlot, inputNodeId, inputNodeSlot] = l;

		// Skip links outside the copy config
		if (outputNodeId == null) continue;

		if (!linksFrom[outputNodeId]) {
			linksFrom[outputNodeId] = {};
		}
		linksFrom[outputNodeId][outputNodeSlot] = l;

		if (!linksTo[inputNodeId]) {
			linksTo[inputNodeId] = {};
		}
		linksTo[inputNodeId][inputNodeSlot] = l;
	}
	return { linksTo, linksFrom };
}

// function getInnerLinkType(config, link) {
// 	const [outputNodeId, outputNodeSlot] = link;
// 	return config.nodes[outputNodeId].outputs[outputNodeSlot].type;
// }

function buildNodeDef(config, nodeName, defs, workflow) {
	const slots = {
		inputs: {},
		widgets: {},
		outputs: {},
	};

	const newDef = {
		output: [],
		output_name: [],
		output_is_list: [],
		name: nodeName,
		display_name: nodeName,
		category: "group nodes" + (workflow ? "/workflow" : ""),
		input: { required: {} },

		[IS_GROUP_NODE]: true,
		[GROUP_DATA]: config,
		[GROUP_SLOTS]: slots,
	};
	const links = getLinks(config);

	console.log(
		"Building group node",
		nodeName,
		config.nodes.map((n) => n.type)
	);

	let inputCount = 0;
	for (let nodeId = 0; nodeId < config.nodes.length; nodeId++) {
		const node = config.nodes[nodeId];
		console.log("Processing inner node", nodeId, node.type);
		let def = defs[node.type];

		const linksTo = links.linksTo[nodeId];
		const linksFrom = links.linksFrom[nodeId];

		if (!def) {
			// Special handling for reroutes to allow them to be used as inputs/outputs
			if (node.type === "Reroute") {
				if (linksTo && linksFrom) {
					// Being used internally
					// TODO: does anything actually need doing here?
					continue;
				}

				let rerouteType;
				if (linksFrom) {
					const [, , id, slot] = linksFrom["0"];
					rerouteType = config.nodes[id].inputs[slot].type;
				} else {
					const [id, slot] = linksTo["0"];
					rerouteType = config.nodes[id].outputs[slot].type;
				}

				def = {
					input: {
						required: {
							[rerouteType]: [rerouteType, {}],
						},
					},
					output: [rerouteType],
					output_name: [],
					output_is_list: [],
				};
			} else {
				// Front end only node
				// TODO: check these should all be ignored
				debugger;
				continue;
			}
		}

		const inputs = { ...def.input?.required, ...def.input?.optional };

		// Add inputs / widgets
		const inputNames = Object.keys(inputs);
		let linkInputId = 0;
		for (let inputId = 0; inputId < inputNames.length; inputId++) {
			const inputName = inputNames[inputId];
			console.log("\t", "> Processing input", inputId, inputName);
			const widgetType = getWidgetType(inputs[inputName], inputName);
			let name = nodeId + ":" + inputName;
			if (widgetType) {
				console.log("\t\t", "Widget", widgetType);

				// Store mapping to get a group widget name from an inner id + name
				if (!slots.widgets[nodeId]) slots.widgets[nodeId] = {};
				slots.widgets[nodeId][inputName] = name;
			} else {
				if (linksTo?.[linkInputId]) {
					linkInputId++;
					console.info("\t\t", "Link skipped as has internal connection");
					continue;
				}

				console.info("\t\t", "Link", linkInputId + " -> outer input " + inputCount);

				// Store a mapping to let us get the group node input for a specific slot on an inner node
				if (!slots.inputs[nodeId]) slots.inputs[nodeId] = {};
				slots.inputs[nodeId][linkInputId++] = inputCount++;
			}

			let inputDef = inputs[inputName];
			if (inputName === "seed" || inputName === "noise_seed") {
				inputDef = [...inputDef];
				inputDef[1] = { control_after_generate: true, ...inputDef[1] };
			}
			newDef.input.required[name] = inputDef;
		}

		// Add outputs
		for (let outputId = 0; outputId < def.output.length; outputId++) {
			console.log("\t", "< Processing output", outputId, def.output_name?.[outputId] ?? def.output[outputId]);

			if (linksFrom?.[outputId]) {
				console.info("\t\t", "Skipping as has internal connection");
				continue;
			}

			slots.outputs[newDef.output.length] = {
				node: nodeId,
				slot: outputId,
			};

			newDef.output.push(def.output[outputId]);
			newDef.output_is_list.push(def.output_is_list[outputId]);
			newDef.output_name.push(nodeId + ":" + (def.output_name?.[outputId] ?? def.output[outputId]));
		}
	}

	return newDef;
}

const id = "Comfy.GroupNode";
let globalDefs;
const ext = {
	name: id,
	setup() {
		const orig = LGraphCanvas.prototype.getCanvasMenuOptions;
		LGraphCanvas.prototype.getCanvasMenuOptions = function () {
			const options = orig.apply(this, arguments);

			options.push(null);
			options.push({
				content: `Convert to Group Node`,
				disabled: !Object.keys(app.canvas.selected_nodes || {}).length,
				callback: async () => {
					const name = prompt("Enter group name");
					if (!name) return;

					let extra = app.graph.extra;
					if (!extra) app.graph.extra = extra = {};
					let groupNodes = extra.groupNodes;
					if (!groupNodes) extra.groupNodes = groupNodes = {};

					if (name in groupNodes) {
						if (app.graph._nodes.find((n) => n.type === name)) {
							alert(
								"An in use group node with this name already exists embedded in this workflow, please remove any instances or use a new name."
							);
							return;
						} else if (
							!confirm(
								"An group node with this name already exists embedded in this workflow, are you sure you want to overwrite it?"
							)
						) {
							return;
						}
					}

					// Use the built in copyToClipboard function to generate the node data we need
					const backup = localStorage.getItem("litegrapheditor_clipboard");
					app.canvas.copyToClipboard();
					const config = JSON.parse(localStorage.getItem("litegrapheditor_clipboard"));
					localStorage.setItem("litegrapheditor_clipboard", backup);
					const def = buildNodeDef(config, name, globalDefs, true);
					await app.registerNodeDef("workflow/" + name, def);

					groupNodes[name] = config;

					let top;
					let left;
					for (const id in app.canvas.selected_nodes) {
						const node = app.graph.getNodeById(id);
						if (left == null || node.pos[0] < left) {
							left = node.pos[0];
						}
						if (top == null || node.pos[1] < top) {
							top = node.pos[1];
						}
						app.graph.remove(node);
					}

					const newNode = LiteGraph.createNode("workflow/" + name);
					newNode.pos = [left, top];
					app.graph.add(newNode);
				},
			});

			return options;
		};
	},
	async beforeConfigureGraph(graphData) {
		const groupNodes = graphData?.extra?.groupNodes;
		if (!groupNodes) return;

		for (const name in groupNodes) {
			const def = buildNodeDef(groupNodes[name], name, globalDefs, true);
			await app.registerNodeDef("workflow/" + name, def);
		}
	},
	addCustomNodeDefs(defs) {
		globalDefs = defs;
	},
	nodeCreated(node) {
		if (node.constructor.nodeData?.[IS_GROUP_NODE]) {
			const config = node.constructor.nodeData[GROUP_DATA];
			const slots = node.constructor.nodeData[GROUP_SLOTS];

			const onNodeCreated = node.onNodeCreated;
			node.onNodeCreated = function () {
				for (let innerNodeId = 0; innerNodeId < config.nodes.length; innerNodeId++) {
					const values = config.nodes[innerNodeId].widgets_values;
					if (!values) continue;
					const widgets = slots.widgets?.[innerNodeId];
					if (!widgets) continue;

					const names = Object.values(widgets);
					for (let i = 0; i < names.length; i++) {
						if (values[i] == null) continue;
						const widget = this.widgets.find((w) => w.name === names[i]);
						if (widget) {
							widget.value = values[i];
						}
					}
				}

				return onNodeCreated?.apply(this, arguments);
			};

			node.updateLink = function (link, innerNodes) {
				// Replace the group node reference with the internal node
				link = { ...link };
				const output = slots.outputs[link.origin_slot];
				let innerNode = this.innerNodes[output.node];
				let l;
				while (innerNode.type === "Reroute") {
					l = innerNode.getInputLink(0);
					innerNode = innerNode.getInputNode(0);
				}

				link.origin_id = innerNode.id;
				link.origin_slot = l?.origin_slot ?? output.slot;
				return link;
			};

			node.getInnerNodes = function () {
				console.log("Expanding group node", this.comfyClass, this.id);
				const links = getLinks(config);

				const innerNodes = config.nodes.map((n, i) => {
					const innerNode = LiteGraph.createNode(n.type);
					innerNode.configure(n);

					for (const innerWidget of innerNode.widgets ?? []) {
						const groupWidgetName = slots.widgets[i][innerWidget.name];
						const groupWidget = node.widgets.find((w) => w.name === groupWidgetName);
						if (groupWidget) {
							console.log("Set widget value", groupWidgetName + " -> " + innerWidget.name, groupWidget.value);
							innerWidget.value = groupWidget.value;
						}
					}

					innerNode.id = node.id + ":" + i;
					innerNode.getInputNode = function (slot) {
						if (!innerNode.comfyClass) slot = 0;
						console.log("Get input node", innerNode.comfyClass, slot, innerNode.inputs[slot]?.name);
						const outerSlot = slots.inputs[i]?.[slot];
						if (outerSlot != null) {
							// Our inner node has a mapping to the group node inputs
							// return the input node from there
							console.log("\t", "Getting from group node input", outerSlot);
							const inputNode = node.getInputNode(outerSlot);
							console.log("\t", "Result", inputNode?.id, inputNode?.comfyClass);
							return inputNode;
						}

						// Internal link
						const innerLink = links.linksTo[i][slot];
						console.log("\t", "Internal link", innerLink);
						const inputNode = innerNodes[innerLink[0]];
						console.log("\t", "Result", inputNode?.id, inputNode?.comfyClass);
						return inputNode;
					};
					innerNode.getInputLink = function (slot) {
						console.log("Get input link", innerNode.comfyClass, slot, innerNode.inputs[slot]?.name);
						const outerSlot = slots.inputs[i]?.[slot];
						if (outerSlot != null) {
							// The inner node is connected via the group node inputs
							console.log("\t", "Getting from group node input", outerSlot);
							const linkId = node.inputs[outerSlot].link;
							let link = app.graph.links[linkId];

							// Use the outer link, but update the target to the inner node
							link = {
								target_id: innerNode.id,
								target_slot: slot,
								...link,
							};
							console.log("\t", "Result", link);
							return link;
						}

						let link = links.linksTo[i][slot];
						// Use the inner link, but update the origin node to be inner node id
						link = {
							origin_id: node.id + ":" + link[0],
							origin_slot: link[1],
							target_id: node.id + ":" + i,
							target_slot: slot,
						};
						console.log("\t", "Internal link", link);

						return link;
					};

					return innerNode;
				});

				this.innerNodes = innerNodes;

				return innerNodes;
			};
		}
	},
};

app.registerExtension(ext);
