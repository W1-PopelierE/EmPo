// A .tsx whose only tag-shaped text sits inside string literals, which is the half of the defect
// CardDocs.tsx cannot pin. CardDocs renders a real `<OrderCard />`, so it is a component whatever
// the rules do with its strings; this file renders nothing at all and its kind is decided entirely
// by whether the kind rule reads the quoted markup below.
//
// It sits under react/cards/ on purpose: no `pathGlob` rule reaches here, so screens/, components/
// and api/ cannot answer for it and the `**/*.{tsx,jsx}` rule's `contentPattern` is the only thing
// that speaks. Before that rule declared `maskStrings` it read the comment-masked source, matched
// `<OrderList>rows</OrderList>` inside a string, and called this file a component. It is a module:
// a codegen template and an error message are prose about components, not a component.
//
// Not only cosmetic. `uniqueId` in engine/resolver.ts filters candidates on kind, so a module
// miskinded `component` competes to be the target of every `<CardTemplates ... />` written
// anywhere in the corpus, and coverage would travel down an edge nobody wrote.
export const templates = {
  row: "<OrderRowList>{rows}</OrderRowList>",
  empty: "<Total />",
};

export const missingCard = "expected a <OrderCard /> here";
