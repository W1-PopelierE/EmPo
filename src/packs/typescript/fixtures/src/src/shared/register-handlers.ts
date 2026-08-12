// A registration module: it exports nothing and is imported for what it does on load, which is the
// shape a polyfill, a css module and a test setup file all share. Nothing here says the word
// `from`, so until the pack grew a fourth import rule every importer of this file reached it with
// no edge and its blast radius read as zero.
import { formatMoney } from "./money";

const handlers = new Map<string, (cents: number) => string>();

handlers.set("money", (cents) => formatMoney({ cents, currency: "EUR" }));
