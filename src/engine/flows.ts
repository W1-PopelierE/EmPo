import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseOrThrow, readJson } from "../errors";
import { normalizeRepoPath } from "../schema/config.schema";
import { flowsFileSchema } from "../schema/flows.schema";
import type { FlowDefinitions, GraphNode } from "../schema/types";
import { compareStrings } from "./order";

/**
 * Layer 2, the human-owned end-user journeys, joined to layer 1's nodes. A flow is a list of
 * repo-relative path prefixes and a node belongs to the flow whose prefix matches it longest
 * (docs/05-graph-model.md). Prefixes cross roots on purpose: one journey spans the API and the app.
 */

/** A missing flows.json is not an error: a repo with no flows still indexes, it just has none. */
export function loadFlows(repoRoot: string, relPath: string): FlowDefinitions {
  const path = join(repoRoot, relPath);
  if (!existsSync(path)) return {};

  return parseOrThrow(flowsFileSchema, readJson(path, path), path, "flows file").flows;
}

/**
 * Longest path-prefix wins, and a tie shares: two flows that declare the same prefix both own the
 * node, which is how one file belongs to more than one journey. A more specific prefix beats a less
 * specific one, so a flow can claim a single file out of a directory another flow owns.
 *
 * Every declared flow appears in the result, empty included. A flow that matches nothing is a fact
 * worth seeing rather than an absence to be hidden.
 *
 * A test node is never assigned to a flow, whatever prefix would have claimed it. A flow is the code
 * of a journey, and coverage asks whether a test *reaches* that code; `reachableFrom` seeds its set
 * with the start node, so a test inside the flow reaches the flow by being it. That corrupts both
 * halves of `blind`, which engine/coverage.ts computes as `reaches && !assertsValue`: a swallowed
 * test that asserts makes the flow `assertsValue` and unblindable, and a swallowed test that asserts
 * nothing sets `reaches` on its own, which is the flow being reported blind on the evidence of a test
 * that reaches nothing but itself. Either way the field answers about the flow's own suite instead of
 * about what reaches its code, which inverts the one answer docs/05 calls the most important sentence
 * EmPo prints.
 *
 * This is invisible wherever tests live in their own tree, which is why the acme fixture never showed
 * it: both of its roots put tests under `tests/`, including the TypeScript one. It bites exactly
 * where docs/04 says a pack must cope, the colocated test: a single flow prefix over a Vue
 * directory was measured swallowing 46 of its own `*.test.ts` files, 45 of them asserting.
 */
export function assignFlows(nodes: GraphNode[], flows: FlowDefinitions): Record<string, string[]> {
  const assigned: Record<string, string[]> = {};
  for (const key of Object.keys(flows).sort(compareStrings)) assigned[key] = [];

  for (const node of nodes) {
    if (node.isTest) continue;
    let longest = 0;
    let winners: string[] = [];

    for (const [key, flow] of Object.entries(flows)) {
      for (const declared of flow.paths) {
        // Compared normalized, so neither a trailing slash nor a leading `./` decides a tie with
        // characters that spell nothing. The rule is schema/config.schema.ts's, and `node.file` was
        // built by it too, so the declared side and the node side agree by construction.
        const prefix = normalizeRepoPath(declared);
        if (!matches(node.file, prefix)) continue;
        if (prefix.length > longest) {
          longest = prefix.length;
          winners = [key];
        } else if (prefix.length === longest && !winners.includes(key)) {
          winners.push(key);
        }
      }
    }

    for (const key of winners) assigned[key]?.push(node.id);
  }

  for (const key of Object.keys(assigned)) assigned[key]?.sort(compareStrings);
  return assigned;
}

/**
 * A prefix matches at a path boundary only. Without that rule `app/Models/Order` would silently
 * claim the sibling `app/Models/OrderLine.php`, and a flow that quietly owns a file nobody assigned
 * to it is worse than one that owns too little.
 *
 * The boundary is a path segment, not a slash, because a language spells one unit of code either as
 * a directory or as a file with an extension, and under PSR-4 or a TS module folder the two sit side
 * by side. So `app/Models/Order` claims `app/Models/Order.php` and everything under
 * `app/Models/Order/`, and still never claims `app/Models/OrderLine.php`. Requiring the human to
 * write both spellings would make a flow miss the very class it is named after, which is the same
 * quiet mis-assignment aimed the other way.
 */
function matches(file: string, prefix: string): boolean {
  if (file === prefix || file.startsWith(`${prefix}/`)) return true;
  const rest = file.slice(prefix.length);
  return file.startsWith(`${prefix}.`) && !rest.includes("/");
}

/**
 * The boundary rule above, for a caller that has to explain an assignment it did not compute.
 *
 * Exported rather than copied because engine/proposal.ts states that the gate's answer and the
 * graph's cannot disagree, and it had grown a private re-implementation of exactly this pair sitting
 * under that claim. One rule, one owner: a change to the boundary above now reaches every reader of
 * it instead of half of them.
 *
 * The flattening is `normalizeRepoPath`, which lives in schema/config.schema.ts because a declared
 * prefix is not the only spelling that has to agree here. The `file` this matches against is built by
 * engine/scanner.ts out of a configured root, so a rule applied to the declared side alone would only
 * move the silence: normalizing `./apps/api` down to `apps/api` while a root spelled `./apps/api`
 * still produced files spelled `./apps/api/...` would make a working flow come back empty. Both sides
 * call the one function, and the config is flattened as it is validated so the two cannot drift.
 */
export function matchesDeclaredPath(file: string, declared: string): boolean {
  return matches(file, normalizeRepoPath(declared));
}
