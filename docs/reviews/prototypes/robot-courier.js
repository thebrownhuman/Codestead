"use strict";

// A deliberately finite command simulator, not a Python interpreter. No eval,
// provider calls, persistent learner state, or continuously running timers.
(() => {
  const directions = { east: [1, 0], north: [0, -1], west: [-1, 0], south: [0, 1] };
  const missions = [
    { title: "One instruction at a time", description: "Read the three eastward moves. Predict the stopping position, then inspect each move.", start: [0, 2], goal: [3, 2], walls: [], commands: [{ direction: "east", count: 1 }, { direction: "east", count: 1 }, { direction: "east", count: 1 }], mode: "predict" },
    { title: "Fix the repeat count", description: "The courier should stop at column 5, row 2. Change the first loop’s repeat count to repair the route.", start: [0, 3], goal: [4, 1], walls: [[2, 2]], commands: [{ direction: "east", count: 3 }, { direction: "north", count: 2 }], mode: "repair" },
    { title: "Make your own delivery", description: "Build a route from column 1, row 4 to column 5, row 1. Avoid the obstacles. You can use at most eight command groups.", start: [0, 3], goal: [4, 0], walls: [[1, 1], [2, 1], [2, 2]], commands: [], mode: "build" },
  ];
  const $ = (id) => document.getElementById(id);
  let missionIndex = 0;
  let commands = [];
  let frames = [];
  let cursor = 0;
  const current = () => missions[missionIndex];

  function svgElement(name, attributes, text) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function draw() {
    const mission = current();
    const frame = frames[cursor] || { x: mission.start[0], y: mission.start[1], action: "Starting position. Columns count left to right; rows count top to bottom." };
    const map = $("map");
    map.replaceChildren();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) {
      const wall = mission.walls.some(([wx, wy]) => wx === x && wy === y);
      map.append(svgElement("rect", { x: x * 100 + 5, y: y * 100 + 5, width: 90, height: 90, rx: 16, fill: wall ? "#547863" : "#203a2e", stroke: "#789e87" }));
      if (wall) map.append(svgElement("text", { x: x * 100 + 50, y: y * 100 + 58, "text-anchor": "middle", fill: "#ffffff", "font-size": 28 }, "■"));
    }
    map.append(svgElement("text", { x: mission.goal[0] * 100 + 50, y: mission.goal[1] * 100 + 65, "text-anchor": "middle", fill: "#f5dc8b", "font-size": 45 }, "★"));
    map.append(svgElement("circle", { cx: frame.x * 100 + 50, cy: frame.y * 100 + 50, r: 25, fill: "#a5edbb", stroke: "#10271a", "stroke-width": 3 }));
    map.append(svgElement("text", { x: frame.x * 100 + 50, y: frame.y * 100 + 57, "text-anchor": "middle", fill: "#10271a", "font-size": 22 }, "R"));
    const position = `Courier: column ${frame.x + 1}, row ${frame.y + 1}. Destination: column ${mission.goal[0] + 1}, row ${mission.goal[1] + 1}.`;
    $("position").textContent = position;
    map.setAttribute("aria-label", `${position} Obstacles: ${mission.walls.map(([x, y]) => `column ${x + 1}, row ${y + 1}`).join("; ") || "none"}.`);
    $("trace").textContent = `${frames.length ? `Step ${cursor} of ${frames.length - 1}. ` : ""}${frame.action}`;
    $("previous").disabled = cursor === 0;
    $("next").disabled = cursor >= frames.length - 1;
    $("result").disabled = frames.length === 0 || cursor >= frames.length - 1;
  }

  function resetRun() {
    frames = []; cursor = 0;
    $("feedback").textContent = "";
    $("prediction-column").value = "";
    $("prediction-row").value = "";
    $("run").disabled = true;
    draw();
  }

  function renderCommands() {
    const focusedId = document.activeElement?.id;
    $("commands").replaceChildren();
    commands.forEach((command, index) => {
      const row = document.createElement("div"); row.className = "command";
      const label = document.createElement("label"); label.textContent = `${current().mode === "predict" ? "Command" : "Repeat command"} ${index + 1}: move ${command.direction}`;
      const input = document.createElement("input");
      input.id = `count-${index}`; input.type = "number"; input.min = "1"; input.max = "6"; input.value = String(command.count);
      input.disabled = current().mode === "predict";
      input.hidden = current().mode === "predict";
      input.addEventListener("change", () => {
        const value = Number(input.value);
        if (!Number.isInteger(value) || value < 1 || value > 6) { input.value = String(command.count); return; }
        command.count = value; renderCommands(); resetRun();
      });
      label.append(input); row.append(label);
      if (current().mode === "build") {
        const remove = document.createElement("button"); remove.type = "button"; remove.textContent = `Remove command ${index + 1}`;
        remove.addEventListener("click", () => { commands.splice(index, 1); renderCommands(); resetRun(); $("add").focus(); });
        row.append(remove);
      }
      $("commands").append(row);
    });
    $("code").textContent = commands.map(({ direction, count }) => count === 1
      ? `move("${direction}")` : `for _ in range(${count}):\n    move("${direction}")`).join("\n") || "# Add movement commands to build your route.";
    $("add").disabled = commands.length >= 8;
    if (focusedId?.startsWith("count-")) $(focusedId)?.focus();
  }

  function loadMission(index) {
    missionIndex = index; commands = current().commands.map((command) => ({ ...command }));
    $("mission-title").textContent = current().title;
    $("mission-description").textContent = current().description;
    $("builder").hidden = current().mode !== "build";
    document.querySelectorAll("[data-mission]").forEach((button) => {
      if (Number(button.dataset.mission) === index) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });
    renderCommands(); resetRun();
  }

  function run() {
    if (!commands.length || !$("prediction-column").value || !$("prediction-row").value) return;
    const mission = current(); let [x, y] = mission.start;
    frames = [{ x, y, action: "Starting position." }]; cursor = 0;
    let blocked = false;
    for (const { direction, count } of commands) {
      const [dx, dy] = directions[direction];
      for (let repeat = 0; repeat < count; repeat++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= 5 || ny < 0 || ny >= 4 || mission.walls.some(([wx, wy]) => wx === nx && wy === ny)) {
          frames.push({ x, y, action: `move("${direction}") is blocked by ${nx < 0 || nx >= 5 || ny < 0 || ny >= 4 ? "the map boundary" : "an obstacle"}. The courier stays here; inspect the route before this move.` });
          blocked = true; break;
        }
        x = nx; y = ny; frames.push({ x, y, action: `move("${direction}") → column ${x + 1}, row ${y + 1}.` });
      }
      if (blocked) break;
    }
    const predicted = Number($("prediction-column").value) === x + 1 && Number($("prediction-row").value) === y + 1;
    const delivered = !blocked && x === mission.goal[0] && y === mission.goal[1];
    $("feedback").textContent = `${delivered ? "Package delivered." : "Not delivered yet."} ${predicted ? "Your prediction matched." : "Your prediction differed."} The program stops at column ${x + 1}, row ${y + 1}. ${blocked ? "Inspect the blocked step, then change the route." : delivered ? "Explain which instruction made the difference." : "Compare the stopping position with the destination. Change one command and predict again."}`;
    draw();
  }

  for (const [id, maximum] of [["prediction-column", 5], ["prediction-row", 4]]) {
    for (let value = 1; value <= maximum; value++) {
      const option = document.createElement("option"); option.value = String(value); option.textContent = String(value); $(id).append(option);
    }
    $(id).addEventListener("change", () => { $("run").disabled = !commands.length || !$("prediction-column").value || !$("prediction-row").value; });
  }
  document.querySelectorAll("[data-mission]").forEach((button) => button.addEventListener("click", () => loadMission(Number(button.dataset.mission))));
  $("add").addEventListener("click", () => {
    const direction = $("new-direction").value, count = Number($("new-count").value);
    if (commands.length >= 8 || !Object.hasOwn(directions, direction) || !Number.isInteger(count) || count < 1 || count > 6) return;
    commands.push({ direction, count }); renderCommands(); resetRun();
  });
  $("run").addEventListener("click", run);
  $("reset").addEventListener("click", () => loadMission(missionIndex));
  $("previous").addEventListener("click", () => { cursor = Math.max(0, cursor - 1); draw(); });
  $("next").addEventListener("click", () => { cursor = Math.min(frames.length - 1, cursor + 1); draw(); });
  $("result").addEventListener("click", () => { cursor = frames.length - 1; draw(); });
  loadMission(0);
})();
