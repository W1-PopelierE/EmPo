import { z } from "zod";

/**
 * The runtime validator for a pack.json (docs/04-language-packs.md). A pack is data, so it is
 * validated like any other untrusted input, including every regex it declares.
 */

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

const regex = z.string().min(1).refine(compiles, { message: "is not a valid regular expression" });

/**
 * How many capture groups a pattern has. Appending `|` makes the pattern match the empty string, so
 * exec always returns an array whose length is the group count plus the whole match.
 */
function groupCount(pattern: string): number {
  try {
    return (new RegExp(`${pattern}|`).exec("")?.length ?? 1) - 1;
  } catch {
    return 0;
  }
}

const resolveStrategySchema = z.enum([
  "fqcn",
  "fqcn-string",
  "module-path",
  "view",
  "observer",
  "short-name",
]);
const normalizerSchema = z.enum([
  "upper",
  "lower",
  "strip-leading-slash",
  "last-dot-segment",
  "pascal-case",
]);

/** Every strategy reads group 1 as the target; observer reads a second group as the listener. */
const GROUPS_REQUIRED: Record<z.infer<typeof resolveStrategySchema>, number> = {
  fqcn: 1,
  "fqcn-string": 1,
  "module-path": 1,
  view: 1,
  observer: 2,
  "short-name": 1,
};

/**
 * `normalize` runs over every capture group before `resolve` reads it, which is what lets a rule
 * whose call site spells a name differently from its declaration (a Blade `<x-forms.text-input>`
 * against a `Forms\TextInput` class) stay pack data. It is declared here rather than assumed,
 * because a field the schema does not name is stripped at load and the rule that needed it goes on
 * matching while resolving nothing.
 */
export const extractRuleSchema = z
  .object({
    pattern: regex,
    resolve: resolveStrategySchema,
    normalize: z.array(normalizerSchema).optional(),
    /**
     * Where this rule may run, as a glob over the root-relative path, in the dialect `kindRules`
     * already uses. It exists because a rule's blast radius is the whole pack: `edges` rules run
     * over every file `match.extensions` claims, and the typescript pack matches seven extensions
     * of which two can hold JSX. A JSX tag rule left unscoped reads `"<Widget />"` out of a string
     * in a `.ts` file and emits an edge to a file that source neither imports nor renders. An
     * invented edge is the one failure this tool exists to prevent, so the pack says where its rule
     * is allowed to look. Absent means everywhere, which is what every rule did before this field.
     *
     * It is the first half of that answer and not the whole of it. The glob decides which files a
     * rule opens; `maskStrings` below decides what counts as code once it is inside one, which is
     * the question a `.tsx` naming a component inside a string asks and no glob can answer, because
     * that file is exactly the file the rule is meant to read.
     */
    pathGlob: z.string().min(1).optional(),
    /**
     * The kinds a name-resolving strategy is allowed to land on, read from the target node's own
     * `kindRules` answer. Only `short-name` and `observer` resolve by name, and only they read it.
     *
     * The need is JSX's: a tag's namespace is mostly other people's packages, so `<View>`, `<Link>`
     * and `<Text>` name nothing in this repository, and a vendor import resolves to no node and
     * leaves no competing edge. A local `src/util/Link.ts` sharing that basename then collects a
     * coupling nobody wrote. Saying the target must be a component costs nothing where the tag is
     * real and refuses the coincidence, and it stays pack data: which kinds a tag can name is a
     * fact about the language, and both the kind and the rule are declared in the same file.
     */
    targetKinds: z.array(z.string().min(1)).min(1).optional(),
    /**
     * Blank the contents of every string literal before this rule runs. It is per rule and not per
     * family because one family holds both answers: php's `template` family carries `<x-cart>`,
     * which is markup and can only be markup, and `@livewire('cart')`, whose component name is
     * inside the quotes and disappears if they are blanked.
     *
     * `pathGlob` was the first half of this answer and could not be the whole of it. It keeps a JSX
     * tag rule out of a `.ts` file, but a `.tsx` file naming a component inside a quoted string is
     * exactly the file the rule is supposed to read, and no glob separates `const tip = "<Button
     * />"` from a rendered `<Button />`. An invented edge is the one failure this tool exists to
     * prevent, so the rule that cannot tell prose from code declines to read prose.
     *
     * What it costs is a missed edge where a quote is not a quote: an apostrophe in JSX prose opens
     * a literal this masker believes in, so a tag between two of them on **one line** is blanked
     * with it. Two apostrophes on separate lines are already safe, because a `'` may not hold a raw
     * newline (`multilineQuotes`). Under-reporting is a gap and over-reporting is a fabricated
     * finding, and the two are not equally acceptable here, which is the same trade the hazard
     * axis's statement boundary makes (src/engine/hazards.ts).
     */
    maskStrings: z.boolean().optional(),
  })
  .refine((rule) => groupCount(rule.pattern) >= GROUPS_REQUIRED[rule.resolve], {
    message: "pattern has fewer capture groups than its resolve strategy reads",
    path: ["pattern"],
  })
  // Only the two name-resolving strategies read `targetKinds`, so on any other one it is a field
  // that changes nothing and reads like a guarantee. That is the shape this repository has been
  // bitten by twice (a pack field the schema dropped, a normalizer list nobody applied), and the
  // remedy each time was to make the honest answer arrive at load rather than as a missing edge.
  .refine((rule) => rule.targetKinds === undefined || RESOLVES_BY_NAME.includes(rule.resolve), {
    message: 'targetKinds is read only by the "short-name" and "observer" strategies',
    path: ["targetKinds"],
  });

const RESOLVES_BY_NAME: z.infer<typeof resolveStrategySchema>[] = ["short-name", "observer"];

/**
 * A `map` naming a capture group the pattern does not have used to yield a silently empty key, and
 * an empty key matches nothing forever. It is a pack defect, so it fails at load time, where the
 * message can name the pack, rather than as a missing bridge edge a user has to go hunting for.
 */
export const symbolRuleSchema = z
  .object({
    symbol: z.string().min(1),
    /** A regex over the file's source. The usual case: a route registered in code, a call made. */
    pattern: regex.optional(),
    /**
     * A regex over the file's path instead of its source, for a symbol whose identity is where the
     * file sits rather than anything written in it. An Inertia page is `Pages/Auth/Login.vue` on
     * disk and nothing inside it names "Auth/Login"; the controller that renders it names it in
     * source. So the page produces its name from `pathPattern` and the controller consumes it from
     * `pattern`, and the bridge joins the two. Exactly one of the two is set.
     */
    pathPattern: regex.optional(),
    map: z.record(z.string().min(1), z.number().int().positive()),
    key: z.string().optional(),
    normalize: z.record(z.string().min(1), z.array(normalizerSchema)).optional(),
  })
  .superRefine((rule, ctx) => {
    // Exactly one source. Both would be ambiguous about what the groups count against, and neither
    // leaves nothing to match, so either is a pack defect that should name itself at load.
    if ((rule.pattern === undefined) === (rule.pathPattern === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["pattern"],
        message:
          "a symbol rule needs exactly one of pattern (over source) or pathPattern (over the file path)",
      });
      return;
    }

    const groups = groupCount(rule.pattern ?? rule.pathPattern ?? "");
    for (const [part, group] of Object.entries(rule.map)) {
      if (group > groups) {
        ctx.addIssue({
          code: "custom",
          path: ["map", part],
          message: `maps to capture group ${group}, but the pattern has ${groups}`,
        });
      }
    }

    for (const part of templateParts(rule.key)) {
      if (!Object.hasOwn(rule.map, part)) {
        ctx.addIssue({
          code: "custom",
          path: ["key"],
          message: `names part "${part}", which is not in map`,
        });
      }
    }

    for (const part of Object.keys(rule.normalize ?? {})) {
      if (!Object.hasOwn(rule.map, part)) {
        ctx.addIssue({
          code: "custom",
          path: ["normalize", part],
          message: "normalizes a part that is not in map",
        });
      }
    }
  });

function templateParts(key: string | undefined): string[] {
  if (key === undefined) return [];
  return [...key.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1] ?? "");
}

/**
 * How the masker (engine/mask.ts) recognizes comments and strings, so a class name or a route
 * inside either is not read as a coupling.
 *
 * `multilineQuotes` names the quotes whose literal may hold a raw newline. It has to be declared
 * because the two languages a pack can describe disagree: PHP's `'...'` spans lines, JavaScript's
 * `'...'` and `"..."` do not and only its backtick does. Absent means every quote may, which is
 * PHP's rule and the one this masker assumed before the field existed. It is a real schema field
 * and not a convention, because a value the schema does not name is stripped at load and the fix
 * that depends on it silently stops working (this is exactly what happened once already).
 */
const commentSyntaxSchema = z.object({
  line: z.array(z.string().min(1)).default([]),
  block: z.array(z.tuple([z.string().min(1), z.string().min(1)])).default([]),
  stringQuotes: z.array(z.string().min(1)).default([]),
  multilineQuotes: z.array(z.string().min(1)).optional(),
  stringEscape: z.string().min(1).optional(),
});

/**
 * The optional transaction-hazard axis (docs/04-language-packs.md). Every string here is a marker
 * the engine walks, never a language the engine knows: `engine/hazards.ts` counts delimiters and
 * compares offsets, exactly as `engine/mask.ts` walks pack-declared comment markers.
 *
 * The two `extent` forms carry different companions, so each is checked rather than left to a reader
 * of the pack: `balanced` without its delimiter pair would count nothing and report every dispatch
 * in the file, and `span` without an `endPattern` would run every transaction to the end of the
 * file. Both failures invent hazards, which is worse here than missing one, so they fail at load
 * where the message can name the pack.
 */
const hazardTransactionRuleSchema = z
  .object({
    pattern: regex,
    extent: z.enum(["balanced", "span"]),
    open: z.string().min(1).optional(),
    close: z.string().min(1).optional(),
    endPattern: regex.optional(),
  })
  .superRefine((rule, ctx) => {
    if (rule.extent === "balanced") {
      if (rule.open === undefined || rule.close === undefined) {
        ctx.addIssue({
          code: "custom",
          message: 'extent "balanced" needs both open and close, the delimiter pair to count',
          path: ["extent"],
        });
      }
      return;
    }
    if (rule.endPattern === undefined) {
      ctx.addIssue({
        code: "custom",
        message: 'extent "span" needs an endPattern, what closes the transaction',
        path: ["extent"],
      });
    }
  });

const hazardDispatchRuleSchema = z
  .object({ pattern: regex, job: z.number().int().positive() })
  .refine((rule) => rule.job <= groupCount(rule.pattern), {
    message: "job names a capture group the pattern does not have",
    path: ["job"],
  });

const hazardsSchema = z.object({
  transactions: z.array(hazardTransactionRuleSchema).default([]),
  dispatches: z.array(hazardDispatchRuleSchema).default([]),
  deferAtSite: z.array(regex).default([]),
  deferAtDeclaration: z.array(regex).default([]),
});

/**
 * One file a toolchain keeps its alias map in, described well enough for `engine/aliases.ts` to
 * read it without knowing which language it belongs to.
 *
 * Every field but `file` is a **dotted field path** into the parsed document rather than a value,
 * which is what keeps this declarative: `compilerOptions.paths` says where to look, and a pack for
 * a toolchain that writes its map at the top level says `paths`. The map itself must be an object
 * of pattern to target, where a target is a string or a list of them, because that is the shape
 * every alias map has once the file is parsed and it is the shape config `aliases` stores.
 */
const aliasSourceSchema = z.object({
  /** Relative to the root's directory, as a repository writes it: "tsconfig.json". */
  file: z.string().min(1),
  /** Dotted path to the alias map: "compilerOptions.paths". */
  paths: z.string().min(1),
  /**
   * Dotted path to the directory the map's targets are relative to, where the toolchain has such a
   * setting ("compilerOptions.baseUrl"). Absent, or present and unset in the file, means the
   * targets are relative to the file itself, which is what TypeScript does without a `baseUrl`.
   */
  base: z.string().min(1).optional(),
  /**
   * Dotted path to a file this one inherits from ("extends"). Followed only where it names a
   * relative path, because a package name resolves through the module system rather than through
   * the filesystem, and a seeder that guessed at `node_modules` would seed a map from a file the
   * repository does not control. What is not followed is reported rather than dropped.
   */
  extends: z.string().min(1).optional(),
});

export const packSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    match: z.object({
      extensions: z.array(z.string().min(1)).min(1),
      manifest: z.array(z.string()).optional(),
    }),
    node: z.object({
      id: z.object({
        strategy: z.enum(["fqcn", "module-path", "symbol"]),
        namespacePattern: regex.optional(),
        namePattern: regex.optional(),
        fallback: z.literal("path").optional(),
        indexNames: z.array(z.string().min(1)).optional(),
      }),
      kindRules: z
        .array(
          z
            .object({
              kind: z.string().min(1),
              pathGlob: z.string().optional(),
              contentPattern: regex.optional(),
              /**
               * The same request an edge rule makes, made by a kind rule: blank string contents before
               * `contentPattern` runs. A kind is not an edge, so getting it wrong puts no coupling in
               * the graph — but it is read like one. `targetKinds` exists so a tag lands on a component
               * and never on a same-named type module, and `uniqueId` (src/engine/resolver.ts) checks it
               * against exactly this label. A file over-promoted to `component` off tag-shaped text in a
               * string becomes an eligible target, and the refusal stops working silently. So the label
               * gets the same defence the edge got, declared per rule for the same reason: a pattern
               * describing code asks, a pattern describing a string a framework reads must not.
               *
               * It pays the same price too — a pattern between two apostrophes on one line of prose is
               * blanked with them — and buys the same thing, an under-report instead of a fabrication.
               */
              maskStrings: z.boolean().optional(),
              /**
               * Marks a kind the framework reaches by name or by convention rather than through an edge
               * any rule in this pack can see: a Laravel view rendered by `view('orders.index')`, a
               * migration the runner discovers, a policy found by its class name. Those nodes have a
               * fan-in of zero forever, so `empo query --orphans` must not offer them as dead code.
               *
               * An enum and not a boolean, because the useful fact is *who* resolves the node, and the
               * next value to want (a DI container, a plugin registry) is a sibling rather than a
               * second flag. A reader of `true` would have to guess which of those was meant.
               */
              resolvedBy: z.enum(["framework"]).optional(),
              /**
               * Marks a kind somebody outside the code arrives at: a route file a request hits, a
               * console command an operator runs, a Livewire component a page mounts. `empo init`'s map
               * brief keeps these and ranks them first, so the strongest flow signal a repository has
               * cannot be pushed past the cap by a directory of migrations.
               *
               * A second axis rather than a reading of `resolvedBy`, because the two ask different
               * questions of one set of zero-fan-in nodes. `--orphans` asks "is this dead?", where a
               * framework-resolved kind means there is no evidence either way, so hide it. The brief
               * asks "does a journey start here?", where a route file is emphatically yes. Both marks
               * on one rule is the normal case for a route file, not a contradiction.
               *
               * An enum and not a boolean for the same reason as `resolvedBy`: the useful fact is *who*
               * arrives, so a scheduler or a webhook sender is a sibling value rather than a second
               * flag.
               */
              arrivedBy: z.enum(["user"]).optional(),
            })
            // A kind rule with no `contentPattern` reads no source at all, so the flag would change
            // nothing while reading as a guarantee that the label cannot come from a string. Same
            // remedy as `targetKinds` on a strategy that never reads it: answer at load.
            .refine((rule) => rule.maskStrings !== true || rule.contentPattern !== undefined, {
              message: "maskStrings is read only by contentPattern, and this rule declares none",
              path: ["maskStrings"],
            }),
        )
        .min(1),
    }),
    comments: commentSyntaxSchema.optional(),
    /**
     * Comment syntax that varies by file extension, overriding `comments` for files that match. A
     * pack of one language can still hold two syntaxes: a Vue SFC's `<template>` is html, where
     * `<!-- -->` is a comment, while the pack's `.ts` files must not treat `<!--` as one, because
     * `a <!--b` is `a < !(--b)` and reading it as a comment blanks the rest of the file. The key is a
     * dotted extension (".vue") and the value is a whole syntax, not a patch, so what applies to a
     * file is one object a reader can see in full rather than a base merged with an override.
     */
    commentsByExtension: z.record(z.string().regex(/^\./), commentSyntaxSchema).optional(),
    edges: z
      .object({
        import: z.array(extractRuleSchema).optional(),
        fqcn: z.array(extractRuleSchema).optional(),
        string: z.array(extractRuleSchema).optional(),
        template: z.array(extractRuleSchema).optional(),
        hook: z.array(extractRuleSchema).optional(),
      })
      .default({}),
    produces: z.array(symbolRuleSchema).default([]),
    consumes: z.array(symbolRuleSchema).default([]),
    tests: z
      .object({
        paths: z.array(z.string()).default([]),
        importsRule: z.string().default("import"),
        assertionTerms: z.array(z.string()).default([]),
        /**
         * Occurrences removed from the source before the terms are matched, so a term whose value
         * claim depends on its argument can still be carried. `assertTrue(` is a value assertion in
         * `assertTrue($order->isPaid())` and a liveness assertion in
         * `assertTrue(method_exists($c, 'confirm'))`, and no substring can tell them apart; naming
         * the second form here keeps the first. Declared in the schema on purpose, because a field
         * the schema does not name is stripped at load and the code reading it dies silently.
         */
        assertionExcludes: z.array(z.string()).default([]),
      })
      .default({ paths: [], importsRule: "import", assertionTerms: [], assertionExcludes: [] }),
    /**
     * Optional, and optional is the point: a pack that declares nothing here says this language has
     * no hazard worth looking for, which is a different answer from finding none. `empo query
     * --hazards` prints that difference rather than showing an empty list either way.
     */
    hazards: hazardsSchema.optional(),
    /**
     * Where this language's toolchain writes its import aliases, so `empo init` can seed config
     * `aliases` instead of leaving a human to copy a tsconfig by hand.
     *
     * This block exists because the alternative was worse in the one way this repository cares about:
     * the seeder has to open `tsconfig.json` and read `compilerOptions.paths`, and both of those
     * strings are TypeScript facts. Written into `src/engine/` they would be the first
     * language-specific logic in the engine (docs/04-language-packs.md, and the rule that adding a
     * language is a data file). Written here they are what every other language fact in EmPo is: a
     * line in a pack, which a python or go pack fills with its own file and its own field.
     *
     * **Read by `empo init` only, never by `empo index`.** The graph is a function of the config plus
     * the files, so a build never opens one of these; what a root resolves is whatever a human left
     * in `aliases` after reading what init seeded. That is the whole reason the seed goes through
     * config rather than being resolved live.
     */
    aliasSources: z.array(aliasSourceSchema).optional(),
    module: z.string().optional(),
  })
  .superRefine((pack, ctx) => {
    // `maskStrings` is answered by the masker, and the masker finds a string literal only through
    // `stringQuotes`. A pack declaring the flag and no quotes has asked for a protection it will not
    // get, and the rule goes on matching inside every literal in the language with nothing to show
    // that its request was dropped. That is the shape this repository has been bitten by before (a
    // pack field the schema stripped, a normalizer list nobody applied), and the remedy each time was
    // to make the honest answer arrive at load rather than as an edge nobody can explain.
    const declaresQuotes = [pack.comments, ...Object.values(pack.commentsByExtension ?? {})].some(
      (syntax) => syntax !== undefined && syntax.stringQuotes.length > 0,
    );
    if (declaresQuotes) return;

    const message =
      "maskStrings needs a comment syntax declaring stringQuotes, or there is no literal to mask";

    for (const [family, rules] of Object.entries(pack.edges)) {
      for (const [position, rule] of (rules ?? []).entries()) {
        if (rule.maskStrings !== true) continue;
        ctx.addIssue({ code: "custom", path: ["edges", family, position, "maskStrings"], message });
      }
    }

    // A kind rule asks the same question of the same masker, so it gets the same answer.
    for (const [position, rule] of pack.node.kindRules.entries()) {
      if (rule.maskStrings !== true) continue;
      ctx.addIssue({
        code: "custom",
        path: ["node", "kindRules", position, "maskStrings"],
        message,
      });
    }
  });
