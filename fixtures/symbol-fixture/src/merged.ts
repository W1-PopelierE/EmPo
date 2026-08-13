import { parseMoney } from "./money";

// Declaration merging: one name is a type and a value, with an unrelated export written between the
// two halves. The partition has to open a boundary at the second half, or its body lands inside the
// unrelated export's extent and the import goes to the wrong node.
export type Handler = (input: string) => number;

export const HANDLER_NAME = "parse";

export function Handler(input: string): number {
  return parseMoney(input);
}
