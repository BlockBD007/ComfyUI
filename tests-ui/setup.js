const { spawn } = require("child_process");
const { resolve } = require("path");
const { writeFile } = require("fs");
const http = require("http");

 async function setup() {
		// Wait up to 30s for it to start
		let success = false;
		let child;
		for (let i = 0; i < 30; i++) {
			try {
				await new Promise((res, rej) => {
					http
						.get("http://127.0.0.1:8188/object_info", (resp) => {
							let data = "";
							resp.on("data", (chunk) => {
								data += chunk;
							});
							resp.on("end", () => {
								// Modify the response data to add some checkpoints
								const objectInfo = JSON.parse(data);
								objectInfo.CheckpointLoaderSimple.input.required.ckpt_name[0] = ["model1.safetensors", "model2.ckpt"];

								data = JSON.stringify(objectInfo, undefined, "\t");

								writeFile(
									"data/object_info.json",
									data,
									{
										encoding: "utf8",
									},
									(err) => {
										if (err) {
											rej(err);
										} else {
											res();
										}
									}
								);
								res();
							});
						})
						.on("error", rej);
				});
				success = true;
				break;
			} catch (error) {
				if (i === 0) {
					// Start the server on first iteration if it fails to connect
					console.log("Starting ComfyUI server...");

					const python = resolve("../../python_embeded/python.exe");
					child = spawn(python, ["-s", "ComfyUI/main.py", "--cpu"], { cwd: "../.." });
				}
				await new Promise((r) => {
					setTimeout(r, 1000);
				});
			}
		}

		child?.kill();

		if (!success) {
			throw new Error("Waiting for server timed out...");
		}
 }

 setup();