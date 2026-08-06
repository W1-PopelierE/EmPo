// A .ts file holding component markup inside strings, which is what a docs constant, an error
// message or a codegen template looks like. Both of these name a component that is a node of this
// graph, so without `pathGlob` on the tag rules each one becomes a template edge to a file this
// module neither imports nor renders. Coverage travels along every non-bridge edge, so the same
// line written in a test would make that test reach a component it never mounted and a flow
// through it would stop reporting blind.
//
// This file pins the glob and not the masking. `pathGlob` is checked before the file is read at
// all, so the tag rules never run here whatever they would have made of these strings; the .tsx
// that the glob must let through, and where `maskStrings` is the only thing standing, is
// CardDocs.tsx.
export const examples = {
  card: "<OrderCard />",
  list: "<OrderList>rows</OrderList>",
};
