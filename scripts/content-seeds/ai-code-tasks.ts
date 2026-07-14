import type { JavaPythonCodeTask } from "./java-python-code-tasks";

const STARTER = `import sys

def solve(data: str) -> str:
    # TODO: implement the bounded offline contract.
    return ""

if __name__ == "__main__":
    print(solve(sys.stdin.read()), end="")
`;

type TaskTest = JavaPythonCodeTask["tests"][number];
const normal = (stdin: string, expectedStdout: string): TaskTest => ({ stdin, expectedStdout, category: "normal" });
const boundary = (stdin: string, expectedStdout: string): TaskTest => ({ stdin, expectedStdout, category: "boundary" });

function task(
  prompt: string,
  body: string,
  explanation: string,
  tests: readonly TaskTest[],
  prelude = "",
): JavaPythonCodeTask {
  return {
    prompt,
    starterCode: STARTER,
    referenceSolution: `import sys
${prelude}
def solve(data: str) -> str:
${body}

if __name__ == "__main__":
    print(solve(sys.stdin.read()), end="")
`,
    explanation,
    tests,
  };
}

/**
 * Deterministic, offline-only Python tasks. No task calls a model, downloads a
 * dataset, claims a toy metric proves safety, or depends on provider output.
 */
export const AI_CODE_TASKS = {
  "ai.search.uninformed": task(
    "Read n, m, m undirected edges, start, and goal. Use BFS with duplicate suppression and return minimum edge count or unreachable.",
    "    tokens = iter(map(int, data.split()))\n    n, m = next(tokens), next(tokens)\n    graph = [[] for _ in range(n)]\n    for _ in range(m):\n        left, right = next(tokens), next(tokens)\n        graph[left].append(right); graph[right].append(left)\n    start, goal = next(tokens), next(tokens)\n    frontier = deque([(start, 0)])\n    seen = {start}\n    while frontier:\n        node, distance = frontier.popleft()\n        if node == goal:\n            return str(distance)\n        for neighbor in graph[node]:\n            if neighbor not in seen:\n                seen.add(neighbor); frontier.append((neighbor, distance + 1))\n    return 'unreachable'",
    "The queue frontier and enqueue-time visited set make the first goal distance minimum for this finite unweighted graph.",
    [normal("5 5 0 1 1 2 0 3 3 4 4 2 0 2\n", "2"), boundary("3 1 0 1 0 2\n", "unreachable")],
    "from collections import deque\n",
  ),
  "ai.search.heuristics": task(
    "Read a directed weighted graph, one heuristic per node, start, and goal. Run A* with reopen-on-better-cost and print optimal cost or unreachable.",
    "    tokens = iter(map(int, data.split()))\n    n, m = next(tokens), next(tokens)\n    graph = [[] for _ in range(n)]\n    for _ in range(m):\n        source, target, cost = next(tokens), next(tokens), next(tokens)\n        graph[source].append((target, cost))\n    heuristic = [next(tokens) for _ in range(n)]\n    start, goal = next(tokens), next(tokens)\n    best = {start: 0}\n    frontier = [(heuristic[start], 0, start)]\n    while frontier:\n        _, cost, node = heappop(frontier)\n        if cost != best.get(node):\n            continue\n        if node == goal:\n            return str(cost)\n        for neighbor, edge in graph[node]:\n            candidate = cost + edge\n            if candidate < best.get(neighbor, 10**18):\n                best[neighbor] = candidate\n                heappush(frontier, (candidate + heuristic[neighbor], candidate, neighbor))\n    return 'unreachable'",
    "The implementation combines accumulated and estimated cost, discards stale entries, and reopens a state when a cheaper path is found.",
    [normal("4 5 0 1 2 0 2 5 1 2 1 1 3 5 2 3 1 3 2 1 0 0 3\n", "4"), boundary("2 0 1 0 0 1\n", "unreachable")],
    "from heapq import heappop, heappush\n",
  ),
  "ai.search.adversarial": task(
    "Read eight integer leaf utilities for a complete depth-three binary zero-sum game. Use alpha-beta minimax with MAX at the root and print the backed-up value.",
    "    leaves = list(map(int, data.split()))\n    def search(index: int, depth: int, maximizing: bool, alpha: int, beta: int) -> int:\n        if depth == 3:\n            return leaves[index]\n        if maximizing:\n            value = -10**18\n            for child in range(2):\n                value = max(value, search(index * 2 + child, depth + 1, False, alpha, beta))\n                alpha = max(alpha, value)\n                if alpha >= beta:\n                    break\n            return value\n        value = 10**18\n        for child in range(2):\n            value = min(value, search(index * 2 + child, depth + 1, True, alpha, beta))\n            beta = min(beta, value)\n            if alpha >= beta:\n                break\n        return value\n    return str(search(0, 0, True, -10**18, 10**18))",
    "Alpha-beta uses valid ancestor bounds while preserving the same alternating minimax value.",
    [normal("3 5 6 9 1 2 0 -1\n", "5"), boundary("-8 -7 -6 -5 -4 -3 -2 -1\n", "-3")],
  ),
  "ai.knowledge.inference": task(
    "Read comma-separated initial facts, a line of whitespace-separated rules a>b, and a query. Compute forward closure and print entailed or unknown.",
    "    lines = data.splitlines()\n    facts = {item for item in lines[0].split(',') if item}\n    rules = [tuple(rule.split('>', 1)) for rule in lines[1].split()]\n    changed = True\n    while changed:\n        changed = False\n        for premise, conclusion in rules:\n            if premise in facts and conclusion not in facts:\n                facts.add(conclusion); changed = True\n    return 'entailed' if lines[2].strip() in facts else 'unknown'",
    "The result is relative to the explicit facts and one-premise rules; lack of derivation remains unknown rather than false.",
    [normal("bird\nbird>animal animal>living\nliving\n", "entailed"), boundary("bird\nbird>animal\nflies\n", "unknown")],
  ),
  "ai.uncertainty.bayes": task(
    "Read prior, sensitivity, and specificity as decimals. Print P(condition|positive) to four decimal places.",
    "    prior, sensitivity, specificity = map(float, data.split())\n    numerator = sensitivity * prior\n    evidence = numerator + (1.0 - specificity) * (1.0 - prior)\n    return f\"{numerator / evidence:.4f}\"",
    "The numerator combines prior and positive likelihood, while the denominator normalizes across affected and unaffected alternatives.",
    [normal("0.01 0.90 0.95\n", "0.1538"), boundary("0.50 1.0 1.0\n", "1.0000")],
  ),
  "ai.planning.actions": task(
    "Read starting energy and a whitespace action sequence using move and charge. move requires energy, advances position, and spends one; charge adds one. Print valid only if every action applies and final position is at least two.",
    "    tokens = data.split()\n    energy = int(tokens[0]); position = 0\n    for action in tokens[1:]:\n        if action == 'move':\n            if energy <= 0:\n                return 'invalid'\n            energy -= 1; position += 1\n        elif action == 'charge':\n            energy += 1\n        else:\n            return 'invalid'\n    return 'valid' if position >= 2 else 'invalid'",
    "The validator checks each precondition before applying effects and evaluates the explicit goal only after the whole sequence.",
    [normal("1 move charge move\n", "valid"), boundary("1 move move\n", "invalid")],
  ),
  "ai.planning.constraints": task(
    "Read node count, undirected edges, and color count. Backtrack to find a map coloring and print colors by node or none.",
    "    tokens = iter(map(int, data.split()))\n    n, m, color_count = next(tokens), next(tokens), next(tokens)\n    edges = [(next(tokens), next(tokens)) for _ in range(m)]\n    neighbors = [set() for _ in range(n)]\n    for left, right in edges:\n        neighbors[left].add(right); neighbors[right].add(left)\n    assigned = [-1] * n\n    def search() -> bool:\n        unassigned = [node for node in range(n) if assigned[node] < 0]\n        if not unassigned:\n            return True\n        node = min(unassigned, key=lambda item: sum(assigned[neighbor] < 0 for neighbor in neighbors[item]))\n        used = {assigned[neighbor] for neighbor in neighbors[node]}\n        for color in range(color_count):\n            if color in used:\n                continue\n            assigned[node] = color\n            if search():\n                return True\n        assigned[node] = -1\n        return False\n    return ' '.join(map(str, assigned)) if search() else 'none'",
    "Backtracking explores finite domains, rejects locally conflicting values, restores state, and validates completion through every edge constraint.",
    [normal("3 3 3 0 1 1 2 0 2\n", "0 1 2"), boundary("3 3 2 0 1 1 2 0 2\n", "none")],
  ),
  "ai.decision.utility": task(
    "Read success probability, success utility, and failure utility for actions A and B. Print the higher expected-utility action and both expectations to two decimals; ties choose A.",
    "    values = list(map(float, data.split()))\n    pa, usa, ufa, pb, usb, ufb = values\n    a = pa * usa + (1 - pa) * ufa\n    b = pb * usb + (1 - pb) * ufb\n    return f\"{'A' if a >= b else 'B'} {a:.2f} {b:.2f}\"",
    "The calculation exposes both probabilities and utilities; it is a bounded arithmetic comparison, not a claim that the utilities are neutral.",
    [normal("0.8 10 -2 0.6 14 -1\n", "B 7.60 8.00"), boundary("0.5 1 -1 0.5 1 -1\n", "A 0.00 0.00")],
  ),
  "ai.data.quality": task(
    "Read CSV-like id,label rows. Print total rows, duplicate-id occurrences after the first, and missing labels.",
    "    rows = [line.split(',', 1) for line in data.splitlines() if line.strip()]\n    seen: set[str] = set(); duplicates = 0; missing = 0\n    for identifier, label in rows:\n        if identifier in seen:\n            duplicates += 1\n        seen.add(identifier)\n        if not label.strip():\n            missing += 1\n    return f\"rows={len(rows)} duplicates={duplicates} missing={missing}\"",
    "The task reports bounded structural indicators without claiming that removing them establishes validity or representativeness.",
    [normal("a,yes\nb,no\na,yes\nc,\n", "rows=4 duplicates=1 missing=1"), boundary("x,\n", "rows=1 duplicates=0 missing=1")],
  ),
  "ai.data.splits-leakage": task(
    "Read entity,split rows and print sorted entity ids appearing in more than one split, or clean.",
    "    memberships: dict[str, set[str]] = {}\n    for line in data.splitlines():\n        if not line.strip():\n            continue\n        entity, split = line.split(',', 1)\n        memberships.setdefault(entity, set()).add(split)\n    leaked = sorted(entity for entity, splits in memberships.items() if len(splits) > 1)\n    return ' '.join(leaked) if leaked else 'clean'",
    "Grouping by deployment entity exposes row-level leakage across train, validation, and test partitions.",
    [normal("p1,train\np2,test\np1,test\n", "p1"), boundary("p1,train\np2,test\n", "clean")],
  ),
  "ai.supervised.regression": task(
    "Read n, n true targets, and n predictions. Print model MAE, mean-baseline MAE, and model or baseline for the lower error; ties choose baseline.",
    "    values = list(map(float, data.split())); n = int(values[0])\n    truth = values[1:1+n]; predicted = values[1+n:1+2*n]\n    model_mae = sum(abs(a-b) for a,b in zip(truth, predicted)) / n\n    mean = sum(truth) / n\n    baseline_mae = sum(abs(value-mean) for value in truth) / n\n    winner = 'model' if model_mae < baseline_mae else 'baseline'\n    return f\"{model_mae:.3f} {baseline_mae:.3f} {winner}\"",
    "The model is compared with a simple baseline using a declared scale-sensitive error summary; no causal or slice claim is inferred.",
    [normal("3 1 2 6 1 3 5\n", "0.667 2.000 model"), boundary("2 4 4 4 4\n", "0.000 0.000 baseline")],
  ),
  "ai.supervised.classification": task(
    "Read n binary true labels then n predicted labels. Print tp, fp, tn, fn, precision, and recall to three decimals.",
    "    values = list(map(int, data.split())); n = values[0]\n    truth = values[1:1+n]; predicted = values[1+n:1+2*n]\n    tp = sum(a == 1 and b == 1 for a,b in zip(truth,predicted))\n    fp = sum(a == 0 and b == 1 for a,b in zip(truth,predicted))\n    tn = sum(a == 0 and b == 0 for a,b in zip(truth,predicted))\n    fn = sum(a == 1 and b == 0 for a,b in zip(truth,predicted))\n    precision = tp / (tp + fp) if tp + fp else 0.0\n    recall = tp / (tp + fn) if tp + fn else 0.0\n    return f\"tp={tp} fp={fp} tn={tn} fn={fn} precision={precision:.3f} recall={recall:.3f}\"",
    "The explicit confusion counts make threshold trade-offs visible and avoid substituting accuracy for rare-class evidence.",
    [normal("5 1 0 1 0 1 1 1 0 0 0\n", "tp=1 fp=1 tn=1 fn=2 precision=0.500 recall=0.333"), boundary("3 0 0 0 0 0 0\n", "tp=0 fp=0 tn=3 fn=0 precision=0.000 recall=0.000")],
  ),
  "ai.supervised.models": task(
    "Read n one-dimensional training x,label pairs and a query x. Return the label of the nearest point, breaking distance ties by earlier input order.",
    "    tokens = iter(data.split()); n = int(next(tokens)); rows = []\n    for index in range(n):\n        rows.append((float(next(tokens)), next(tokens), index))\n    query = float(next(tokens))\n    _, label, _ = min(rows, key=lambda row: (abs(row[0] - query), row[2]))\n    return label",
    "This transparent one-nearest-neighbor baseline exposes the distance, scaling, locality, and tie assumptions instead of claiming universal superiority.",
    [normal("3 0 low 5 mid 10 high 6\n", "mid"), boundary("2 0 left 2 right 1\n", "left")],
  ),
  "ai.unsupervised.clustering": task(
    "Read one-dimensional values. Run deterministic k=2 means initialized at min and max until stable, then print sorted centers to one decimal.",
    "    values = list(map(float, data.split())); centers = [min(values), max(values)]\n    for _ in range(100):\n        groups = [[], []]\n        for value in values:\n            index = 0 if abs(value-centers[0]) <= abs(value-centers[1]) else 1\n            groups[index].append(value)\n        updated = [sum(group)/len(group) if group else centers[index] for index,group in enumerate(groups)]\n        if all(abs(a-b) < 1e-12 for a,b in zip(updated,centers)):\n            break\n        centers = updated\n    centers.sort()\n    return f\"{centers[0]:.1f} {centers[1]:.1f}\"",
    "The output is a parameter- and initialization-defined 1D summary; it does not label the clusters as natural real-world groups.",
    [normal("1 2 9 10\n", "1.5 9.5"), boundary("0 0 10\n", "0.0 10.0")],
  ),
  "ai.unsupervised.anomaly": task(
    "Read reference values followed by a vertical bar and one probe. Compute median absolute deviation score and print typical or anomalous using score greater than 3.",
    "    left, right = data.split('|', 1); values = list(map(float, left.split())); probe = float(right)\n    median = statistics.median(values); mad = statistics.median(abs(value-median) for value in values)\n    score = abs(probe-median) / mad if mad else (0.0 if probe == median else float('inf'))\n    label = 'anomalous' if score > 3 else 'typical'\n    rendered = 'inf' if math.isinf(score) else f\"{score:.2f}\"\n    return f\"{label} {rendered}\"",
    "The robust score is explicitly relative to the reference sample and threshold; anomalous is not equated with harmful.",
    [normal("10 11 12 13 14 | 20\n", "anomalous 8.00"), boundary("5 5 5 | 5\n", "typical 0.00")],
    "import math\nimport statistics\n",
  ),
  "ai.neural.units-layers": task(
    "Read x1 and x2. Trace a fixed two-ReLU hidden layer and linear output; print h1, h2, and output to two decimals.",
    "    x1, x2 = map(float, data.split())\n    relu = lambda value: max(0.0, value)\n    h1 = relu(0.5*x1 - x2 + 1.0)\n    h2 = relu(x1 + x2 - 1.0)\n    output = 2.0*h1 - h2 + 0.5\n    return f\"{h1:.2f} {h2:.2f} {output:.2f}\"",
    "The task makes every weight, bias, activation, and composed output explicit without attaching human concepts to hidden units.",
    [normal("2 1\n", "1.00 2.00 0.50"), boundary("0 3\n", "0.00 2.00 -1.50")],
  ),
  "ai.neural.training": task(
    "Read scalar x, target y, weight w, and learning rate. For prediction w*x and half-squared loss, print current loss and one updated weight to four decimals.",
    "    x, y, weight, rate = map(float, data.split())\n    prediction = weight * x\n    error = prediction - y\n    loss = 0.5 * error * error\n    gradient = error * x\n    updated = weight - rate * gradient\n    return f\"{loss:.4f} {updated:.4f}\"",
    "The gradient is local sensitivity for one declared loss and the learning rate controls the update scale.",
    [normal("2 6 1 0.1\n", "8.0000 1.8000"), boundary("0 3 5 0.1\n", "4.5000 5.0000")],
  ),
  "ai.generative.language-model": task(
    "Read one whitespace-tokenized corpus line and a context token line. Build toy bigram counts and print the most frequent next token, breaking ties lexically, or <none>.",
    "    lines = data.splitlines(); tokens = lines[0].split(); context = lines[1].strip()\n    counts: dict[str, int] = {}\n    for left, right in zip(tokens, tokens[1:]):\n        if left == context:\n            counts[right] = counts.get(right, 0) + 1\n    if not counts:\n        return '<none>'\n    return min(counts, key=lambda token: (-counts[token], token))",
    "This toy conditional count demonstrates next-token selection only; it is not a factual, semantic, or modern-LLM equivalence claim.",
    [normal("a b a c a b\na\n", "b"), boundary("a b c\nz\n", "<none>")],
  ),
  "ai.generative.prompt-output": task(
    "Read JSON and accept only an object with exactly answer:string and citations:list[string]. Print valid or invalid.",
    "    try:\n        value = json.loads(data)\n    except json.JSONDecodeError:\n        return 'invalid'\n    valid = (isinstance(value, dict) and set(value) == {'answer','citations'} and isinstance(value['answer'], str) and isinstance(value['citations'], list) and all(isinstance(item,str) for item in value['citations']))\n    return 'valid' if valid else 'invalid'",
    "Deterministic parsing and exact schema checks occur outside any model; valid structure still does not establish factual grounding.",
    [normal("{\"answer\":\"bounded\",\"citations\":[\"doc:1\"]}\n", "valid"), boundary("{\"answer\":\"x\",\"citations\":[],\"tool\":\"delete\"}\n", "invalid")],
    "import json\n",
  ),
  "ai.generative.embeddings-rag": task(
    "Simulate offline retrieval: read a query, document count, then id|text lines. Rank by lowercase alphanumeric token overlap and print id:score, tie by id.",
    "    lines = data.splitlines(); query = set(re.findall(r'[a-z0-9]+', lines[0].lower())); count = int(lines[1]); candidates = []\n    for line in lines[2:2+count]:\n        identifier, text = line.split('|', 1)\n        score = len(query & set(re.findall(r'[a-z0-9]+', text.lower())))\n        candidates.append((score, identifier))\n    score, identifier = min(candidates, key=lambda item: (-item[0], item[1]))\n    return f\"{identifier}:{score}\"",
    "The task is explicitly a lexical retrieval simulation, preserving ids and scoring retrieval separately from any answer generation.",
    [normal("server timer\n3\ndoc-b|client timer pauses\ndoc-a|server controls exam timer\ndoc-c|unrelated\n", "doc-a:2"), boundary("missing term\n2\na|alpha\nb|beta\n", "a:0")],
    "import re\n",
  ),
  "ai.generative.api-safety": task(
    "Read a JSON tool call. Authorize only {tool:'lookup', arguments:{id:<nonempty string>}} with no extra fields; print authorized or denied.",
    "    try:\n        call = json.loads(data)\n    except json.JSONDecodeError:\n        return 'denied'\n    valid = (isinstance(call, dict) and set(call) == {'tool','arguments'} and call.get('tool') == 'lookup' and isinstance(call.get('arguments'), dict) and set(call['arguments']) == {'id'} and isinstance(call['arguments']['id'], str) and bool(call['arguments']['id']))\n    return 'authorized' if valid else 'denied'",
    "The application uses an exact allowlist and typed argument schema; model-produced JSON has no authority by itself.",
    [normal("{\"tool\":\"lookup\",\"arguments\":{\"id\":\"lesson-1\"}}\n", "authorized"), boundary("{\"tool\":\"lookup\",\"arguments\":{\"id\":\"x\",\"url\":\"https://evil.test\"}}\n", "denied")],
    "import json\n",
  ),
  "ai.evaluation.metrics": task(
    "Read group,true,pred binary rows. Print overall accuracy and the lowest group accuracy to three decimals.",
    "    rows = [line.split(',') for line in data.splitlines() if line.strip()]\n    correct = [int(truth) == int(predicted) for _,truth,predicted in rows]\n    groups: dict[str, list[bool]] = {}\n    for (group,_,_), result in zip(rows, correct):\n        groups.setdefault(group, []).append(result)\n    overall = sum(correct) / len(correct)\n    worst = min(sum(values)/len(values) for values in groups.values())\n    return f\"overall={overall:.3f} worst_group={worst:.3f}\"",
    "The aggregate and worst slice are both bounded summaries; uncertainty and decision costs would still be required for a real claim.",
    [normal("a,1,1\na,0,1\nb,1,1\nb,0,0\n", "overall=0.750 worst_group=0.500"), boundary("a,1,0\n", "overall=0.000 worst_group=0.000")],
  ),
  "ai.evaluation.fairness-explain": task(
    "Read group,true,pred rows. Print each group's true-positive rate sorted by group and the max-min TPR gap to three decimals; NA when a group has no positives.",
    "    stats: dict[str, list[int]] = {}\n    for line in data.splitlines():\n        if not line.strip():\n            continue\n        group, truth, predicted = line.split(','); truth_i = int(truth); pred_i = int(predicted)\n        values = stats.setdefault(group, [0,0])\n        if truth_i == 1:\n            values[1] += 1\n            if pred_i == 1:\n                values[0] += 1\n    rates = {group: (tp/positive if positive else None) for group,(tp,positive) in stats.items()}\n    available = [rate for rate in rates.values() if rate is not None]\n    parts = [f\"{group}={'NA' if rates[group] is None else f'{rates[group]:.3f}'}\" for group in sorted(rates)]\n    gap = max(available)-min(available) if available else 0.0\n    return ' '.join(parts) + f\" gap={gap:.3f}\"",
    "The slice calculation exposes one fairness-relevant error-rate difference but does not resolve fairness, causation, uncertainty, or policy trade-offs.",
    [normal("a,1,1\na,1,0\nb,1,1\nb,1,1\n", "a=0.500 b=1.000 gap=0.500"), boundary("a,0,0\nb,1,0\n", "a=NA b=0.000 gap=0.000")],
  ),
  "ai.project.reproducibility": task(
    "Read an integer seed followed by item ids. Use a documented local linear-congruential shuffle and print an 80/20 train|test split manifest.",
    "    tokens = data.split(); state = int(tokens[0]) & 0x7fffffff; items = sorted(tokens[1:])\n    for index in range(len(items)-1, 0, -1):\n        state = (1103515245 * state + 12345) & 0x7fffffff\n        selected = state % (index + 1)\n        items[index], items[selected] = items[selected], items[index]\n    test_count = max(1, len(items)//5) if items else 0\n    train = items[test_count:]; test = items[:test_count]\n    return f\"{' '.join(train)}|{' '.join(test)}\"",
    "The exact algorithm, seed, sorted input ids, and resulting manifest make this toy split reproducible without claiming platform-wide stochastic control.",
    [normal("7 a b c d e\n", "c d e b|a"), boundary("1 only\n", "|only")],
  ),
} as const satisfies Readonly<Record<string, JavaPythonCodeTask>>;
