import type { Graph } from "../schema/types";
import { loadPack } from "./pack-loader";

/*
 * The two axes a pack declares over kinds, read from the packs on disk rather than from the graph.
 *
 * Both answer a question about a node whose fan-in is zero, and they answer different ones:
 * `resolvedBy` says the framework reaches this kind by name, so the absence of an edge is not
 * evidence about it, and `arrivedBy` says somebody outside the code arrives here, so a journey
 * starts at it. A Laravel route file carries both, which is why neither can be derived from the
 * other: it is not dead code and it is where a user walks in.
 *
 * This module exists so the two commands that read them cannot drift. `empo query --orphans` and
 * `empo init`'s map brief classify the same set of nodes, so a second copy of the rule would let
 * one of them call a kind framework-resolved while the other did not, which is the failure
 * `guardsPath` having one owner prevents one layer down (docs/14-implementation-notes.md).
 *
 * They subtract different sets, though, and the two reason strings below are separate because of
 * it: `--orphans` hides every framework-resolved kind, while the brief hides only the ones nobody
 * arrives at, so one sentence cannot be true of both without being vague about both.
 *
 * Reading the pack on disk is correct here, and it is the opposite of what `hazards` had to do:
 * both callers only reclassify nodes an existing graph already holds, so a pack that gained a mark
 * after the graph was built gives the corrected answer with no reindex. A fact discovered at index
 * time could not be recovered that way and has to be serialized (docs/04-language-packs.md).
 */

/**
 * Why a node with no fan-in is not a dead-code candidate. Printed under `empo query --orphans` and
 * carried in its JSON, for the reader who would otherwise go and delete one.
 */
export const FRAMEWORK_RESOLVED_REASON =
  "A framework-resolved kind is reached by name or by convention, never by an edge, " +
  "so its fan-in is zero whether it is used or not.";

/**
 * Why `empo init`'s brief holds a row back, which is **not** the sentence above.
 *
 * The brief prints framework-resolved rows all the time: a route file is one, and it is ranked
 * first. So a note explaining the subtraction by framework-resolution alone would give, as its
 * reason, the property the held-back rows share with the rows printed directly above them. The
 * distinguishing fact is the arrival axis, and this says it.
 */
export const NOT_AN_ARRIVAL_REASON =
  "The framework reaches these by name and nobody arrives at one, so no journey starts here. " +
  "A kind that is framework-resolved and arrived at, such as a route file, is ranked above.";

/** How to see the excluded nodes anyway. One string, so the print and the JSON cannot disagree. */
export const LIST_FRAMEWORK_RESOLVED = "empo query --orphans --all";

export interface KindAxes {
  /** Kind keys the framework reaches by name. See `kindKey`. */
  frameworkResolved: Set<string>;
  /** Kind keys somebody outside the code arrives at. See `kindKey`. */
  userArrived: Set<string>;
}

/** A tab separates the two halves because neither a language nor a kind name may contain one. */
export function kindKey(lang: string, kind: string): string {
  return `${lang}\t${kind}`;
}

/** True where `set` claims this node's kind, in this node's language. */
export function claims(set: Set<string>, node: { lang: string; kind: string }): boolean {
  return set.has(kindKey(node.lang, node.kind));
}

/**
 * Both axes, for every language this graph's roots use: one `loadPack` per distinct language.
 *
 * `loadPack` has no cache of its own, so each of those is a real read and parse. One per language
 * per answer is cheap, and a caller that wanted this per node would have to hoist it, which is why
 * both callers take the sets once and ask `claims` afterwards.
 */
export function kindAxes(graph: Graph): KindAxes {
  const frameworkResolved = new Set<string>();
  const userArrived = new Set<string>();

  for (const lang of new Set(graph.roots.map((root) => root.lang))) {
    for (const rule of loadPack(lang).node.kindRules) {
      if (rule.resolvedBy === "framework") frameworkResolved.add(kindKey(lang, rule.kind));
      if (rule.arrivedBy === "user") userArrived.add(kindKey(lang, rule.kind));
    }
  }

  return { frameworkResolved, userArrived };
}
