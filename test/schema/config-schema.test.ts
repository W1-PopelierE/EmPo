import { describe, expect, test } from "vitest";
import { parseConfig } from "../../src/engine/config";
import { configJsonSchema, configSchema } from "../../src/schema/config.schema";

/**
 * The adapter half of the config schema, and one property above all others: **the error a user
 * meets on the day they upgrade.**
 *
 * `bitbucket`, `gitlab`, `jira`, `asana` and `linear` were kinds in the version before this one and
 * are not kinds any more, so a config that has been sitting in a repository for months now fails
 * validation on every command, not only on `empo review`. That failure is unavoidable and it is
 * correct. What it must not be is opaque: zod's own message names the kinds that are valid and says
 * nothing at all about what became of theirs, which reads as the tool breaking rather than as a
 * rename, at the exact moment there is least reason to trust it. So each of the five names its
 * replacement in the shape it has to be typed, and each of the five is pinned here.
 */

const ROOTS = [{ path: ".", lang: "typescript" }];

/** A valid config, with whatever adapters a case wants to try. */
function configWith(adapters: unknown): unknown {
  return {
    version: 1,
    roots: ROOTS,
    packs: { typescript: { version: "^1" } },
    adapters,
  };
}

/** Every message the schema produced, joined, or "" when it accepted the config. */
function problems(adapters: unknown): string {
  const result = configSchema.safeParse(configWith(adapters));
  if (result.success) return "";
  return result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
}

describe("a kind that was renamed to mcp", () => {
  const RENAMED: [role: "forge" | "tracker", kind: string][] = [
    ["forge", "bitbucket"],
    ["forge", "gitlab"],
    ["tracker", "jira"],
    ["tracker", "asana"],
    ["tracker", "linear"],
  ];

  for (const [role, kind] of RENAMED) {
    test(`tells a config carrying ${role} "${kind}" what to write instead`, () => {
      const message = problems({ [role]: { kind } });

      // The old name, so the reader knows this is about the line they are looking at, and the new
      // shape in full, so the repair is a copy rather than a search through a changelog.
      expect(message).toContain(`"${kind}" is no longer a ${role} kind`);
      expect(message).toContain('{ "kind": "mcp", "host": ');
      expect(message).toContain(`"host": "${kind}"`);
      // On the path of the field that is wrong, so a config with several sections points at one.
      expect(message).toContain(`adapters.${role}.kind`);
    });
  }

  test("leaves zod's own message alone for a kind that is simply a typo", () => {
    // The tailored message is for a value that used to work. A misspelling never did, and telling
    // its author that "githbu" was renamed would be a lie that costs them the real answer: the list
    // of kinds that are valid.
    const message = problems({ forge: { kind: "githbu" } });

    expect(message).not.toContain("no longer");
    expect(message).toContain("github");
    expect(message).toContain("mcp");
  });

  test("says it through parseConfig, which is what every command actually calls", () => {
    // The message is worth nothing if it does not survive the layer that turns issues into a
    // EmpoError, so this goes through the real reader rather than the schema alone.
    try {
      parseConfig(configWith({ tracker: { kind: "jira", project: "PLAT" } }), ".empo/config.json");
      expect.unreachable("expected a config error");
    } catch (error) {
      const details = (error as { details: string[] }).details.join("\n");
      expect(details).toContain('"jira" is no longer a tracker kind');
      expect(details).toContain('{ "kind": "mcp", "host": "jira" }');
    }
  });
});

describe("the adapters a config may carry now", () => {
  test("accepts an mcp forge and an mcp tracker with the host that names them", () => {
    expect(
      problems({
        forge: { kind: "mcp", host: "bitbucket", workspace: "acme", repo: "acme-platform" },
        tracker: { kind: "mcp", host: "jira", keyPattern: "[A-Z]{2,}-\\d+", project: "PLAT" },
      }),
    ).toBe("");
  });

  test("accepts an mcp adapter with no host, which the request block words differently", () => {
    // A host empo was never told about is a forge that still works: the request block says "your
    // pull request tool" instead of naming one, and nothing in the engine branches on the value.
    expect(problems({ forge: { kind: "mcp" }, tracker: { kind: "mcp" } })).toBe("");
  });

  test("takes any host string at all, because an enum here would refuse a working connector", () => {
    expect(problems({ tracker: { kind: "mcp", host: "shortcut" } })).toBe("");
    expect(problems({ forge: { kind: "mcp", host: "git.acme.internal" } })).toBe("");
  });

  test("refuses an empty host, which names nothing and is not the same as omitting it", () => {
    expect(problems({ forge: { kind: "mcp", host: "" } })).toContain("adapters.forge.host");
  });

  test("keeps local, github, github-issues and none, which are not renames", () => {
    expect(problems({ forge: { kind: "local" }, tracker: { kind: "none" } })).toBe("");
    expect(
      problems({
        forge: { kind: "github", repo: "acme/platform" },
        tracker: { kind: "github-issues" },
      }),
    ).toBe("");
  });

  test("still refuses a keyPattern that does not compile, on the keyPattern", () => {
    // The local precedent for a tailored message, asserted beside the new one so a change to the
    // enum's error handling cannot quietly swallow the refine below it.
    expect(problems({ tracker: { kind: "mcp", host: "jira", keyPattern: "[A-Z" } })).toContain(
      "keyPattern is not a valid regular expression",
    );
  });
});

/**
 * A key the schema does not know, which used to be dropped in silence.
 *
 * The failure that ended it is one config away: a repository spelling the section `"adaptors"` had
 * its whole adapters block stripped, and then every command reported no forge and no tracker, which
 * is exactly what a repository with no adapters is told. Nothing anywhere could say the difference,
 * so the review that graded no ticket-fit and read the local diff was honest and wrong at once.
 *
 * Both carve-outs are pinned here too, because each is a key that must be ignored and there is
 * exactly one way to be sure a schema still ignores it.
 */
describe("a key the schema does not know", () => {
  /** Every message the schema produced for a whole config, or "" when it accepted it. */
  function refusal(config: unknown): string {
    const result = configSchema.safeParse(config);
    if (!result.success) {
      return result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n");
    }
    return "";
  }

  const VALID = {
    version: 1,
    roots: ROOTS,
    packs: { typescript: { version: "^1" } },
  };

  test("refuses a misspelled section and names it, rather than reporting no adapters", () => {
    const message = refusal({
      ...VALID,
      adaptors: { forge: { kind: "github", repo: "platform" } },
    });

    expect(message).toContain("adaptors");
    // The half that is easy to lose while making the message nice: the config must not parse. A
    // named key in a warning that still loads leaves every command answering from a config the
    // human did not write.
    expect(configSchema.safeParse({ ...VALID, adaptors: {} }).success).toBe(false);
  });

  test("refuses a misspelled key inside a section, on the path that holds it", () => {
    const message = refusal({
      ...VALID,
      adapters: { forge: { kind: "github", repo: "platform", workspaces: "acme" } },
    });

    expect(message).toContain("adapters.forge");
    expect(message).toContain("workspaces");
  });

  /**
   * Every object the schema declares, one row each, because strictness is per object and the first
   * version of this file pinned four of the eight. A review measured the other four and found them
   * genuinely unpinned: `adapters`, `packs.<name>`, `adapters.tracker` and `bridges[].normalize`
   * could each be turned back into a permissive object with the whole suite green, and one of them
   * is the immediate sibling of the typo this entire change is named after.
   */
  test.each([
    ["the top level", { ...VALID, adaptors: {} }, "adaptors"],
    ["a root", { ...VALID, roots: [{ path: ".", lang: "typescript", langs: "php" }] }, "langs"],
    [
      "a pack selection",
      { ...VALID, packs: { typescript: { version: "^1", verison: "^2" } } },
      "verison",
    ],
    [
      "a bridge",
      { ...VALID, bridges: [{ kind: "k", produces: ".", consumes: ".", normalise: {} }] },
      "normalise",
    ],
    [
      "a bridge's normalize block",
      {
        ...VALID,
        bridges: [{ kind: "k", produces: ".", consumes: ".", normalize: { lowercased: true } }],
      },
      "lowercased",
    ],
    ["the adapters block", { ...VALID, adapters: { forgee: { kind: "github" } } }, "forgee"],
    [
      "a forge",
      { ...VALID, adapters: { forge: { kind: "github", workspaces: "acme" } } },
      "workspaces",
    ],
    [
      "a tracker",
      { ...VALID, adapters: { tracker: { kind: "mcp", keyPatern: "[A-Z]+-\\d+" } } },
      "keyPatern",
    ],
  ])("refuses an unknown key in %s", (_where, config, key) => {
    expect(refusal(config)).toContain(key);
  });

  test("refuses one inside a root and inside a bridge, not only at the top level", () => {
    expect(
      refusal({ ...VALID, roots: [{ path: ".", lang: "typescript", langs: "php" }] }),
    ).toContain("langs");
    expect(
      refusal({
        ...VALID,
        bridges: [{ kind: "http-route", produces: ".", consumes: ".", normalise: {} }],
      }),
    ).toContain("normalise");
  });

  test("accepts $schema, the one key an editor writes and EmPo never reads", () => {
    expect(refusal({ ...VALID, $schema: "./empo.schema.json" })).toBe("");
  });

  test("accepts _note, so a disclaimer travels inside the file it is about", () => {
    // docs/11: the shipped example says every value in it is invented, and that sentence has to be
    // in the file people copy. JSON has no comments, so the schema names the key instead.
    expect(refusal({ ...VALID, _note: "Fictional example, invented values only." })).toBe("");
  });

  test("does not bless the underscore, which would re-admit the silent strip", () => {
    expect(refusal({ ...VALID, _adapters: { forge: { kind: "github" } } })).toContain("_adapters");
  });
});

/**
 * The other half of what this schema is the single source of truth for: not only which values are
 * legal, but which of several spellings of one value the rest of the engine gets to see. A root path
 * reaches a `Set.has` in engine/bridger.ts, a `===` in engine/coverage.ts, a `startsWith` in
 * commands/index.ts and a prefix match in engine/flows.ts, and every one of those is characters. A
 * config that scans the right directory and then matches nothing anywhere is the failure this
 * flattening exists to make impossible, and it is silent in every one of those places.
 */
describe("the spelling of a path a human wrote", () => {
  /** The roots of a config that parsed, or the messages that stopped it. */
  function rootsOf(paths: string[]): string[] {
    const result = configSchema.safeParse({
      version: 1,
      roots: paths.map((path) => ({ path, lang: "typescript" })),
      packs: { typescript: { version: "^1" } },
    });
    if (!result.success) return result.error.issues.map((issue) => issue.message);
    return result.data.roots.map((root) => root.path);
  }

  test("reads every spelling of one root as the one path it names", () => {
    // A trailing slash, a leading `./`, both, and a doubled slash after the dot. `join` treats all
    // five as one directory, so all five scan the same files, and any consumer comparing them as
    // strings would disagree with the filesystem about whether this root is that root.
    expect(rootsOf(["apps/api", "apps/api/", "./apps/api", "./apps/api/", ".//apps/api"])).toEqual([
      "apps/api",
      "apps/api",
      "apps/api",
      "apps/api",
      "apps/api",
    ]);
  });

  test("lands every spelling of the repository root on `.`, and never on the empty string", () => {
    // The empty string is a prefix of length zero. engine/flows.ts explains what that costs: it
    // matches a top-level dotfile and it ties with every other prefix at that length, so a root
    // naming nothing would start claiming nodes. `/` is here because it is the one input where the
    // trailing-slash rule alone produces exactly that.
    expect(rootsOf([".", "./", ".//", "/"])).toEqual([".", ".", ".", "."]);
  });

  test("still refuses a root path that is empty, which names nothing to flatten", () => {
    // The flattening runs after validation, so a value that was never a path stays a rejection
    // rather than being quietly turned into the repository root.
    expect(rootsOf([""]).join("\n")).toContain("Too small");
  });

  test("refuses an absolute root path instead of scanning it into silence", () => {
    // The spelling flattening cannot repair, and the one that fails in the quietest way. `join`
    // does not reset on an absolute second segment, so `/apps/api` scans the right directory and
    // `empo doctor` finds it present, while every node it produces carries a `root` and a `file`
    // beginning with a slash: no path git names in a diff matches one, no flow prefix a human
    // writes matches one, and nothing anywhere says so. Both halves of the message are asserted,
    // because a refusal that does not carry the repair is a config nobody can get working again.
    const messages = rootsOf(["/apps/api"]).join("\n");

    expect(messages).toContain('cannot begin with "/"');
    expect(messages).toContain('Write "apps/api"');
    // A trailing slash on the same value does not turn it into something else.
    expect(rootsOf(["/apps/api/"]).join("\n")).toContain('cannot begin with "/"');
    // And the lone `/`, which really is a spelling of the repository root, still lands on `.`. The
    // rule is checked after the flattening precisely so this one keeps parsing.
    expect(rootsOf(["/"])).toEqual(["."]);
  });

  test("refuses an absolute bridge side too, on the side that carries it", () => {
    // A bridge side is a root path written a second time, so a rule that held on one and not the
    // other would let a config name a root the engine cannot compare against anything.
    const result = configSchema.safeParse({
      version: 1,
      roots: [{ path: "apps/api", lang: "php" }],
      packs: { php: { version: "^1" } },
      bridges: [{ kind: "http", produces: "apps/api", consumes: ["/apps/web"] }],
    });

    expect(result.success).toBe(false);
    const issues = (result.error?.issues ?? []).map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    expect(issues.join("\n")).toContain("bridges.0.consumes.0: a path here is relative");
  });

  test("reads a bridge's roots by the same rule as the roots they refer to", () => {
    // A bridge side is a root path written a second time, and engine/health.ts checks one against
    // the set of the other by string equality. Flattening the root and not the reference would
    // break the pair that agreed before either was touched.
    const result = configSchema.safeParse({
      version: 1,
      roots: [{ path: "./apps/api/", lang: "php" }],
      packs: { php: { version: "^1" } },
      bridges: [{ kind: "http", produces: "./apps/api/", consumes: ["./apps/web/", "apps/web"] }],
    });

    expect(result.success).toBe(true);
    expect(result.data?.bridges[0]?.produces).toBe("apps/api");
    expect(result.data?.bridges[0]?.consumes).toEqual(["apps/web", "apps/web"]);
    expect(result.data?.roots[0]?.path).toBe("apps/api");
  });
});

/**
 * The alias map a root may carry, which is the one config field whose absence deletes edges rather
 * than narrowing an answer: an aliased import the map does not name resolves to no node at all, so
 * a file most of whose importers reach it through `@/` reads as barely used.
 *
 * It is spelled like a tsconfig `paths` verbatim, because `empo init` seeds it by copying rather
 * than by translating. So the refusals below are all about the spellings that would sit in a config
 * looking like they did something and match nothing forever, which is the same silent-no-match
 * failure the path flattening above exists to make impossible, arriving through a different field.
 */
describe("the alias map a root may carry", () => {
  const VALID = { version: 1, packs: { typescript: { version: "^1" } } };

  /** A whole config carrying one root's aliases, so the refusals land on a real path. */
  function configWithAliases(aliases: unknown): unknown {
    return { ...VALID, roots: [{ path: ".", lang: "typescript", aliases }] };
  }

  /** Every message the schema produced, joined, or "" when it accepted the config. */
  function refusal(aliases: unknown): string {
    const result = configSchema.safeParse(configWithAliases(aliases));
    if (result.success) return "";
    return result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
  }

  test("carries a valid map through the real parse, reachable at roots[].aliases", () => {
    // Through parseConfig rather than the schema alone, and asserted on the parsed value rather
    // than on success, because a field an object schema does not declare is stripped in silence:
    // every test that built the object by hand would stay green while `empo index` saw no map.
    const config = parseConfig(
      configWithAliases({ "@/*": ["./src/*", "resources/js/*"], "@config": ["src/config"] }),
      ".empo/config.json",
    );

    expect(config.roots[0]?.aliases).toEqual({
      // Flattened by the same rule as every other repo-relative path here, so the resolver compares
      // one spelling against node ids that were built from one spelling.
      "@/*": ["src/*", "resources/js/*"],
      "@config": ["src/config"],
    });
  });

  test("leaves the field undefined on a root that declares none", () => {
    // Every root in every config written before this field existed. The resolver reads `undefined`
    // as "no aliases" and answers exactly as it did before, so this is the regression guard.
    const config = parseConfig({ ...VALID, roots: [{ path: ".", lang: "typescript" }] }, "c.json");

    expect(config.roots[0]?.aliases).toBeUndefined();
    expect("aliases" in (config.roots[0] ?? {})).toBe(false);
  });

  test("refuses a pattern holding two stars, naming the pattern that is wrong", () => {
    // Two would need a decision about which star the matched text belongs to, and the toolchain the
    // map is copied from does not make that decision either. The path carries the offending key,
    // which is the part a reader repairs by; zod reports its own message for a record key rather
    // than the schema's, so the assertion is on the key and not on the wording.
    const message = refusal({ "@/*/*": ["src/*"] });

    expect(message).not.toBe("");
    expect(message).toContain("roots.0.aliases");
    expect(message).toContain("@/*/*");
  });

  test("refuses a target holding two stars, with the message the schema writes", () => {
    expect(refusal({ "@/*": ["src/*/generated/*"] })).toContain(
      'an alias target may hold at most one "*"',
    );
  });

  test("refuses a pattern spelled relative, which could never be matched against", () => {
    // `resolveModuleFile` resolves a `./` or `../` specifier against the importing file and answers
    // before it ever looks at this map, so such a key matches nothing forever.
    expect(refusal({ "./lib/money": ["src/lib/money.ts"] })).toContain("./lib/money");
    expect(refusal({ "../shared/*": ["src/shared/*"] })).toContain("../shared/*");
  });

  test("refuses an empty target list, which names no path to resolve to", () => {
    const message = refusal({ "@/*": [] });

    expect(message).toContain("roots.0.aliases.@/*");
    expect(message).toContain("Too small");
  });
});

describe("the generated JSON Schema", () => {
  test("carries the kinds an editor should offer, and none of the retired ones", () => {
    // Editors validate against this file, so a stale copy would autocomplete a user straight into
    // the error above. It is generated from the schema, which is the only reason it cannot drift.
    const json = JSON.stringify(configJsonSchema());

    expect(json).toContain("mcp");
    expect(json).toContain("github-issues");
    for (const retired of ["bitbucket", "gitlab", "jira", "asana", "linear"]) {
      expect(json, retired).not.toContain(`"${retired}"`);
    }
  });

  test("refuses an unknown key here too, so an editor flags the typo while it is typed", () => {
    // The strictness reaches the document for free, because a strict object emits
    // additionalProperties. Asserted because docs/03 now promises it: the claim that an editor
    // pointed at this document would catch a misspelled key is only true while this holds.
    const document = configJsonSchema() as { additionalProperties?: unknown };

    expect(document.additionalProperties).toBe(false);
    expect(JSON.stringify(document)).toContain("$schema");
  });
});
