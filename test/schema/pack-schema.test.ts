import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { packSchema } from "../../src/schema/pack.schema";

/**
 * A pack is data, and a pack rule that names a capture group its own pattern does not have used to
 * produce a silently empty key rather than an error. Each case below is one such rule paired with
 * the version that should pass, so a guard that stops working fails a test here instead of quietly
 * costing a bridge edge. The pack itself is the smallest one the schema accepts: everything the
 * cases do not exercise is defaulted rather than written out.
 */

function pack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "mini",
    version: "1.0.0",
    match: { extensions: [".php"] },
    node: {
      id: { strategy: "fqcn" },
      kindRules: [{ kind: "class" }],
    },
    ...overrides,
  };
}

/** Whether it parsed, plus the issues as "path: message", which is how a pack author reads them. */
function parse(value: unknown): { success: boolean; issues: string } {
  const result = packSchema.safeParse(value);
  if (result.success) return { success: true, issues: "" };
  return {
    success: false,
    issues: result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n"),
  };
}

/** Two capture groups: the shape every rule below either respects or oversteps. */
const twoGroups = "Route::(get|post)\\(\\s*['\"]([^'\"]+)['\"]";

describe("packSchema", () => {
  test("accepts a pack that declares only a name, a version, a match and a node", () => {
    // If this fails the helper is wrong, not the schema: every other case builds on it.
    const result = packSchema.safeParse(pack());

    expect(result.success).toBe(true);
    expect(result.data?.produces).toEqual([]);
    expect(result.data?.tests.importsRule).toBe("import");
  });

  test("rejects a symbol rule that maps a part to a capture group the pattern does not have", () => {
    const rule = { symbol: "http-route", pattern: twoGroups, map: { method: 1, path: 3 } };

    const { success, issues } = parse(pack({ produces: [rule] }));

    expect(success).toBe(false);
    expect(issues).toContain("produces.0.map.path: maps to capture group 3, but the pattern has 2");
  });

  test("accepts the same rule once every part maps to a group the pattern really has", () => {
    const rule = { symbol: "http-route", pattern: twoGroups, map: { method: 1, path: 2 } };

    expect(parse(pack({ produces: [rule] })).success).toBe(true);
  });

  test("accepts a pathPattern rule and counts its groups the same as a source pattern", () => {
    const rule = {
      symbol: "inertia-page",
      pathPattern: "(?:^|/)Pages/(.+)\\.vue$",
      map: { page: 1 },
      key: "{page}",
    };

    expect(parse(pack({ produces: [rule] })).success).toBe(true);
  });

  test("rejects a symbol rule that sets both pattern and pathPattern", () => {
    // Which source do its groups count against? Both is ambiguous, so it is a defect that names
    // itself at load rather than silently reading one and ignoring the other.
    const rule = {
      symbol: "inertia-page",
      pattern: twoGroups,
      pathPattern: "(?:^|/)Pages/(.+)\\.vue$",
      map: { page: 1 },
    };

    const { success, issues } = parse(pack({ produces: [rule] }));

    expect(success).toBe(false);
    expect(issues).toContain("produces.0.pattern");
  });

  test("rejects a symbol rule that sets neither pattern nor pathPattern", () => {
    const rule = { symbol: "inertia-page", map: { page: 1 } };

    const { success, issues } = parse(pack({ consumes: [rule] }));

    expect(success).toBe(false);
    expect(issues).toContain("consumes.0.pattern");
  });

  test("counts a pathPattern's groups too, so a map past its end is still refused", () => {
    const rule = { symbol: "inertia-page", pathPattern: "Pages/(.+)\\.vue$", map: { page: 2 } };

    const { success, issues } = parse(pack({ produces: [rule] }));

    expect(success).toBe(false);
    expect(issues).toContain("produces.0.map.page: maps to capture group 2, but the pattern has 1");
  });

  test("rejects a key template that names a part the map never defines", () => {
    const rule = {
      symbol: "http-route",
      pattern: twoGroups,
      map: { method: 1, path: 2 },
      key: "{method} {host}",
    };

    const { success, issues } = parse(pack({ produces: [rule] }));

    expect(success).toBe(false);
    expect(issues).toContain('produces.0.key: names part "host", which is not in map');
  });

  test("rejects a normalizer attached to a part the map never defines", () => {
    const rule = {
      symbol: "http-route",
      pattern: twoGroups,
      map: { method: 1, path: 2 },
      normalize: { verb: ["upper"] },
    };

    const { success, issues } = parse(pack({ consumes: [rule] }));

    expect(success).toBe(false);
    expect(issues).toContain("consumes.0.normalize.verb: normalizes a part that is not in map");
  });

  test("rejects an observer rule whose pattern captures the observed class but not the listener", () => {
    // Observer reads a second group, so one group leaves the listener undefined at resolve time.
    const rule = { pattern: "([A-Za-z0-9_]+)::observe\\(", resolve: "observer" };

    const { success, issues } = parse(pack({ edges: { hook: [rule] } }));

    expect(success).toBe(false);
    expect(issues).toContain(
      "edges.hook.0.pattern: pattern has fewer capture groups than its resolve strategy reads",
    );
  });

  test("accepts an observer rule that captures both the observed class and the listener", () => {
    const rule = {
      pattern: "([A-Za-z0-9_]+)::observe\\(\\s*([A-Za-z0-9_]+)::class",
      resolve: "observer",
    };

    expect(parse(pack({ edges: { hook: [rule] } })).success).toBe(true);
  });

  test("accepts a kind rule marked resolved by the framework", () => {
    const rules = [{ kind: "view", pathGlob: "**/resources/views/**", resolvedBy: "framework" }];

    const result = packSchema.safeParse(
      pack({ node: { id: { strategy: "fqcn" }, kindRules: rules } }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.node.kindRules[0]?.resolvedBy).toBe("framework");
  });

  test("rejects a kind rule whose resolvedBy is not a resolver the engine knows", () => {
    // The value drives whether `empo query --orphans` hides the kind, so a typo that parsed would
    // put every view back on a dead-code list with nobody able to see why.
    const rules = [{ kind: "view", resolvedBy: "laravel" }];

    const { success, issues } = parse(
      pack({ node: { id: { strategy: "fqcn" }, kindRules: rules } }),
    );

    expect(success).toBe(false);
    expect(issues).toContain("node.kindRules.0.resolvedBy");
  });

  test("keeps multilineQuotes and commentsByExtension, rather than stripping them at load", () => {
    // A field the schema does not name is stripped by zod, so a fix that reads it stops working
    // with no error. multilineQuotes was in a pack.json and absent from the schema, and it was
    // silently dropped until this test existed. Both fields have to survive the parse.
    const result = packSchema.safeParse(
      pack({
        comments: { line: ["//"], stringQuotes: ["'", "`"], multilineQuotes: ["`"] },
        commentsByExtension: {
          ".vue": { block: [["<!--", "-->"]], stringQuotes: ["'"], multilineQuotes: ["'"] },
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.comments?.multilineQuotes).toEqual(["`"]);
    expect(result.data?.commentsByExtension?.[".vue"]?.block).toEqual([["<!--", "-->"]]);
  });

  test("rejects a commentsByExtension key that is not a dotted extension", () => {
    // The key is matched as a suffix of a file's basename, and the leading dot is what makes that
    // safe: without it "vue" would claim "overvue.js" and "ts" would claim "foo.mts". A bare key
    // would also be the silent kind of wrong this whole field is about, so it fails at load.
    const { success, issues } = parse(
      pack({ commentsByExtension: { vue: { block: [["<!--", "-->"]] } } }),
    );

    expect(success).toBe(false);
    expect(issues).toContain("commentsByExtension");
  });

  test("rejects a short-name rule whose pattern captures no name to look up", () => {
    const rule = { pattern: "<x-[a-z0-9-]+", resolve: "short-name" };

    const { success, issues } = parse(pack({ edges: { template: [rule] } }));

    expect(success).toBe(false);
    expect(issues).toContain(
      "edges.template.0.pattern: pattern has fewer capture groups than its resolve strategy reads",
    );
  });

  test("keeps an edge rule's normalize list, rather than stripping it at load", () => {
    // The same scar as multilineQuotes, one field over. A stripped `normalize` does not fail: the
    // rule goes on matching every `<x-price-badge>` in the repository and hands the resolver the
    // kebab-cased tag, which is in no node index, so every template edge silently disappears while
    // the pack still reads as if it declared them.
    const rule = {
      pattern: "<x-([a-z0-9][A-Za-z0-9._-]*)",
      resolve: "short-name",
      normalize: ["last-dot-segment", "pascal-case"],
    };

    const result = packSchema.safeParse(pack({ edges: { template: [rule] } }));

    expect(result.success).toBe(true);
    expect(result.data?.edges.template?.[0]?.normalize).toEqual([
      "last-dot-segment",
      "pascal-case",
    ]);
  });

  test("keeps an edge rule's pathGlob and targetKinds, rather than stripping them at load", () => {
    // The same scar again, two fields over, and both fail toward an invented edge rather than a
    // missing one. A stripped `pathGlob` lets a JSX tag rule read a component name out of a string
    // in a .ts file; a stripped `targetKinds` lets `<Link>` from a package resolve to whatever
    // local module shares the basename. Neither errors, and both read as declared in the pack.
    const rule = {
      pattern: "<([A-Z][A-Za-z0-9_]*)\\s*/>",
      resolve: "short-name",
      pathGlob: "**/*.{tsx,jsx,vue}",
      targetKinds: ["component", "screen"],
    };

    const result = packSchema.safeParse(pack({ edges: { template: [rule] } }));

    expect(result.success).toBe(true);
    expect(result.data?.edges.template?.[0]?.pathGlob).toBe("**/*.{tsx,jsx,vue}");
    expect(result.data?.edges.template?.[0]?.targetKinds).toEqual(["component", "screen"]);
  });

  test("keeps an edge rule's maskStrings, rather than stripping it at load", () => {
    // The same scar once more. A stripped `maskStrings` does not fail either: the rule goes on
    // reading `const tip = "<Button />"` as a rendered tag and emits an edge to a file the source
    // only mentions in prose, while the pack reads as though it had declined to look inside quotes.
    const rule = {
      pattern: "<([A-Z][A-Za-z0-9_]*)\\s*/>",
      resolve: "short-name",
      maskStrings: true,
    };

    const result = packSchema.safeParse(
      pack({
        comments: { line: ["//"], stringQuotes: ["'", '"', "`"] },
        edges: { template: [rule] },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.edges.template?.[0]?.maskStrings).toBe(true);
  });

  test("rejects maskStrings on a pack whose comment syntax declares no stringQuotes", () => {
    // The masker finds a literal only through `stringQuotes`, so without them the flag is inert:
    // the rule keeps matching inside every literal and nothing shows that its request was dropped.
    const rule = {
      pattern: "<([A-Z][A-Za-z0-9_]*)\\s*/>",
      resolve: "short-name",
      maskStrings: true,
    };

    const { success, issues } = parse(
      pack({ comments: { line: ["//"] }, edges: { template: [rule] } }),
    );

    expect(success).toBe(false);
    expect(issues).toContain(
      'edges.template.0.maskStrings: maskStrings needs a comment syntax declaring stringQuotes, and ".php" resolves to a comment syntax declaring none',
    );
  });

  test("accepts maskStrings when only commentsByExtension declares the quotes", () => {
    // A pack may leave `comments` off entirely and describe each extension in full, which is what
    // `commentsByExtension` is for. The quotes are declared for every extension this pack scans, the
    // masker will find literals in all of them, and a check reading only the top-level `comments`
    // would refuse this pack.
    const rule = {
      pattern: "<([A-Z][A-Za-z0-9_]*)\\s*/>",
      resolve: "short-name",
      maskStrings: true,
    };

    const result = packSchema.safeParse(
      pack({
        match: { extensions: [".tsx"] },
        commentsByExtension: { ".tsx": { line: ["//"], stringQuotes: ["'", '"', "`"] } },
        edges: { template: [rule] },
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.edges.template?.[0]?.maskStrings).toBe(true);
  });

  test("leaves maskStrings absent when a rule does not ask for it", () => {
    // No runtime default, in both directions. `false` would be a value the shipped packs never
    // wrote, and test/packs/versions.test.ts hashes the parsed pack, so a default would move both
    // packs' hashes and read as a pack change nobody made.
    const rule = { pattern: "<x-([a-z0-9-]+)", resolve: "short-name" };

    const result = packSchema.safeParse(pack({ edges: { template: [rule] } }));

    expect(result.success).toBe(true);
    expect(result.data?.edges.template?.[0]?.maskStrings).toBeUndefined();
    expect(Object.hasOwn(result.data?.edges.template?.[0] ?? {}, "maskStrings")).toBe(false);
  });

  test("keeps a kind rule's maskStrings, rather than stripping it at load", () => {
    // The exact class of bug this repo has been bitten by before: zod drops an undeclared key and
    // `loadPack` returns the parsed data, so a field missing from the schema never reaches the
    // engine while every hand-built unit test goes on passing. A stripped `maskStrings` here labels
    // a .tsx holding only `"<Button />"` in a string a component, off its own prose.
    const node = {
      id: { strategy: "fqcn" },
      kindRules: [{ kind: "component", contentPattern: "<[A-Z]", maskStrings: true }],
    };

    const result = packSchema.safeParse(
      pack({ comments: { line: ["//"], stringQuotes: ["'", '"', "`"] }, node }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.node.kindRules[0]?.maskStrings).toBe(true);
  });

  test("rejects maskStrings on a kind rule when no comment syntax declares stringQuotes", () => {
    // Same reasoning as the edge-rule case: without quotes the masker finds no literal, so the flag
    // is inert and the rule goes on matching inside every string with nothing said either way.
    const node = {
      id: { strategy: "fqcn" },
      kindRules: [{ kind: "component", contentPattern: "<[A-Z]", maskStrings: true }],
    };

    const { success, issues } = parse(pack({ comments: { line: ["//"] }, node }));

    expect(success).toBe(false);
    expect(issues).toContain(
      'node.kindRules.0.maskStrings: maskStrings needs a comment syntax declaring stringQuotes, and ".php" resolves to a comment syntax declaring none',
    );
  });

  test("rejects maskStrings on a kind rule that declares no contentPattern", () => {
    // `maskStrings` is read by `contentPattern` and by nothing else: a `pathGlob` matches a path,
    // which holds no string literals. Declared beside no pattern it is a request nobody answers.
    const node = {
      id: { strategy: "fqcn" },
      kindRules: [{ kind: "component", pathGlob: "**/*.tsx", maskStrings: true }],
    };

    const { success, issues } = parse(
      pack({ comments: { line: ["//"], stringQuotes: ["'", '"', "`"] }, node }),
    );

    expect(success).toBe(false);
    expect(issues).toContain(
      "node.kindRules.0.maskStrings: maskStrings is read only by contentPattern, and this rule declares none",
    );
  });

  test("accepts maskStrings on a kind rule with a contentPattern and quotes declared", () => {
    // Both halves satisfied: there is a pattern to read the view, and there are quotes for the
    // masker to find a literal with.
    const node = {
      id: { strategy: "fqcn" },
      kindRules: [
        { kind: "component", pathGlob: "**/*.tsx", contentPattern: "<[A-Z]", maskStrings: true },
        { kind: "module" },
      ],
    };

    const { success, issues } = parse(
      pack({ comments: { line: ["//"], stringQuotes: ["'", '"', "`"] }, node }),
    );

    expect(issues).toBe("");
    expect(success).toBe(true);
  });

  test("rejects quotes in comments that the extension entry the rule reads does not repeat", () => {
    // The case the pack-wide check used to let through, and the reason the check is per extension
    // now. Quotes on `comments`, a `.tsx` entry that omits them: the masker asks `commentSyntaxFor`,
    // which picks by the FILE'S OWN extension, so the `.tsx` entry wins and takes the quotes away.
    // Under the old check this pack loaded clean while `maskStrings` was inert for every .tsx, which
    // is exactly the file the flag was written for, and a .tsx holding only
    // `export const tip = "render a <Tips /> here";` came back `component` off its own prose.
    const node = {
      id: { strategy: "fqcn" },
      kindRules: [{ kind: "component", contentPattern: "<[A-Z]", maskStrings: true }],
    };

    const { success, issues } = parse(
      pack({
        match: { extensions: [".ts", ".tsx"] },
        comments: { line: ["//"], stringQuotes: ["'", '"', "`"] },
        commentsByExtension: { ".tsx": { line: ["//"], block: [["/*", "*/"]] } },
        node,
      }),
    );

    expect(success).toBe(false);
    // The extension is named, because it is the only thing the pack author can act on.
    expect(issues).toContain(
      'node.kindRules.0.maskStrings: maskStrings needs a comment syntax declaring stringQuotes, and ".tsx" resolves to a comment syntax declaring none',
    );
  });

  test("rejects a maskStrings rule reading a compound extension whose entry declares no quotes", () => {
    // The case a check reading `posix.extname` cannot see. `.blade.php` is never in
    // `match.extensions` (the scanner admits the file through its plain `.php` tail) and `extname`
    // answers `.php` for `card.blade.php`, so the offending extension exists only as a
    // `commentsByExtension` key. The masker takes the longest declared suffix, so a blade file really
    // is masked by the quote-less entry, and the rule really does go on matching inside its strings.
    const rule = {
      pattern: "<([A-Z][A-Za-z0-9_]*)\\s*/>",
      resolve: "short-name",
      maskStrings: true,
    };

    const { success, issues } = parse(
      pack({
        comments: { line: ["//"], stringQuotes: ["'", '"'] },
        commentsByExtension: { ".blade.php": { block: [["{{--", "--}}"]] } },
        edges: { template: [rule] },
      }),
    );

    expect(success).toBe(false);
    expect(issues).toContain(
      'edges.template.0.maskStrings: maskStrings needs a comment syntax declaring stringQuotes, and ".blade.php" resolves to a comment syntax declaring none',
    );
  });

  test("accepts a maskStrings rule whose pathGlob scopes it away from the quote-less extension", () => {
    // Scoping is the pack author's remedy, so it has to work: the same pack as the rejection above,
    // with the rule confined to the extension whose syntax does declare quotes. Refusing this would
    // leave a pack that is honest about what it reads with nowhere to go but dropping the flag.
    const rule = {
      pattern: "<([A-Z][A-Za-z0-9_]*)\\s*/>",
      resolve: "short-name",
      maskStrings: true,
      pathGlob: "**/*.ts",
    };

    const { success, issues } = parse(
      pack({
        match: { extensions: [".ts", ".tsx"] },
        comments: { line: ["//"], stringQuotes: ["'", '"', "`"] },
        commentsByExtension: { ".tsx": { line: ["//"] } },
        edges: { template: [rule] },
      }),
    );

    expect(issues).toBe("");
    expect(success).toBe(true);
  });

  test("leaves a pack declaring maskStrings nowhere untouched by the per-extension check", () => {
    // The check asks its question of declaring rules only. A pack with a quote-less entry and no
    // `maskStrings` anywhere has asked for nothing and must be told nothing, which is the shape the
    // shipped php pack has: a `.blade.php` entry with no `stringQuotes` and not one rule that masks.
    const rule = { pattern: "<x-([a-z0-9-]+)", resolve: "short-name" };

    const { success, issues } = parse(
      pack({
        comments: { line: ["//"], stringQuotes: ["'", '"'] },
        commentsByExtension: { ".blade.php": { block: [["{{--", "--}}"]] } },
        edges: { template: [rule] },
      }),
    );

    expect(issues).toBe("");
    expect(success).toBe(true);
  });

  test("still accepts both shipped packs, which is what the per-extension check must not cost", () => {
    // The typescript pack declares `maskStrings` on two template rules and one kind rule, all scoped
    // by a glob, and every extension those globs reach declares quotes. The php pack declares the
    // flag nowhere while carrying a deliberately quote-less `.blade.php` entry. Read from disk
    // rather than restated here, so this fails when a pack changes and not when a copy drifts.
    for (const name of ["typescript", "php"]) {
      const source = readFileSync(new URL(`../../src/packs/${name}/pack.json`, import.meta.url));
      const { success, issues } = parse(JSON.parse(source.toString()));

      expect(issues).toBe("");
      expect(success).toBe(true);
    }
  });

  test("rejects targetKinds on a strategy that does not resolve by name", () => {
    // A `module-path` rule resolves a specifier against the filesystem and never asks the index of
    // names, so a `targetKinds` beside it is a filter nothing applies: the rule goes on resolving
    // to whatever the path names, while the pack reads as though it were constrained.
    const rule = {
      pattern: "\\bimport\\(\\s*['\"]([^'\"]+)['\"]\\s*\\)",
      resolve: "module-path",
      targetKinds: ["component"],
    };

    const { success, issues } = parse(pack({ edges: { import: [rule] } }));

    expect(success).toBe(false);
    expect(issues).toContain(
      'edges.import.0.targetKinds: targetKinds is read only by the "short-name" and "observer" strategies',
    );
  });

  test("rejects a view rule in a pack that declares no view roots", () => {
    // Without a `views` block the strategy resolves every name it reads against an empty index, so
    // the pack ships a family that produces nothing and looks exactly like a corpus with nothing to
    // find. Same remedy as every other gap in this schema: answer at load, where the message can
    // name the pack, rather than as an edge nobody can explain the absence of.
    const rule = {
      pattern: "@include\\(\\s*['\"]([A-Za-z0-9._/-]+)['\"]",
      resolve: "view",
      normalize: ["dot-to-slash"],
    };

    const { success, issues } = parse(pack({ edges: { template: [rule] } }));

    expect(success).toBe(false);
    expect(issues).toContain(
      'edges.template.0.resolve: the "view" strategy needs a views block naming the roots to resolve against',
    );
  });

  test("accepts the same rule once the pack says where its templates live", () => {
    const rule = {
      pattern: "@include\\(\\s*['\"]([A-Za-z0-9._/-]+)['\"]",
      resolve: "view",
      normalize: ["dot-to-slash"],
    };

    const { success, issues } = parse(
      pack({
        edges: { template: [rule] },
        views: { roots: ["resources/views"], extensions: [".blade.php"] },
      }),
    );

    expect(issues).toBe("");
    expect(success).toBe(true);
  });

  test("rejects a normalizer the engine has no verb for", () => {
    // The vocabulary is engine-side and closed: a pack orders the verbs, it cannot invent one. A
    // typo that parsed would be a no-op, and a no-op normalizer is a capture that resolves to
    // nothing, which reads exactly like a repository that has no such coupling.
    const rule = {
      pattern: "<x-([a-z0-9-]+)",
      resolve: "short-name",
      normalize: ["kebab-to-pascal"],
    };

    const { success, issues } = parse(pack({ edges: { template: [rule] } }));

    expect(success).toBe(false);
    expect(issues).toContain("edges.template.0.normalize.0");
  });

  test("rejects an import rule that captures nothing, leaving no target to resolve", () => {
    const rule = { pattern: "^[ \\t]*use\\s+[A-Za-z0-9_\\\\]+\\s*;", resolve: "fqcn" };

    const { success, issues } = parse(pack({ edges: { import: [rule] } }));

    expect(success).toBe(false);
    expect(issues).toContain(
      "edges.import.0.pattern: pattern has fewer capture groups than its resolve strategy reads",
    );
  });

  test("rejects a declares pattern that captures no name", () => {
    // `declaredNames` reads group 1 and skips a match without one, so a pattern with no group
    // parses, matches, and declares nothing: local-name protection disappears without a word.
    const { success, issues } = parse(pack({ declares: ["\\bconst [A-Z][A-Za-z0-9_]*"] }));

    expect(success).toBe(false);
    expect(issues).toContain("declares.0: must capture the declared name in group 1");
  });

  test("accepts the same declares pattern once it captures the name", () => {
    const { success } = parse(pack({ declares: ["\\bconst ([A-Z][A-Za-z0-9_]*)"] }));

    expect(success).toBe(true);
  });
});
