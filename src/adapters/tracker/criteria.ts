/**
 * Acceptance-criteria parsing (docs/09-adapters.md, "Tracker adapter"). Every tracker stores a
 * ticket body as text, so this is shared rather than reimplemented per adapter; only `getTicket`
 * differs between trackers.
 *
 * Step 6 of docs/07-review-discipline.md maps each criterion to `file:line` evidence. That makes
 * an empty result the honest answer ("the ticket states no criteria") and makes a loose fallback
 * actively harmful: grading a PR against sentences the author never wrote produces confident,
 * fabricated "missing" findings. So there is no "every sentence" fallback here on purpose.
 */

/** `- [ ] x`, `- [x] x`, `* [ ] x`. The bullet character is whatever markdown allows. */
const CHECKBOX = /^\s*[-*+]\s+\[[ xX]\]\s*(.*)$/;

const HEADING = /^\s*#{1,6}\s+(.*)$/;

/** Deliberately broad: teams name this section a dozen ways and all of them mean the same thing. */
const CRITERIA_HEADING = /acceptance criteria|criteria|definition of done|requirements/i;

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

/**
 * Order of preference: checkboxes anywhere in the body, then the contents of a criteria section,
 * then nothing. Source order is preserved and never sorted, because a ticket that states "create
 * the record, then email the owner" means that order.
 */
export function parseCriteria(body: string): string[] {
  const lines = body.split(/\r?\n/);

  // Checkboxes win wherever they appear: an author who ticked boxes stated the criteria explicitly,
  // whatever heading they happen to sit under.
  const checkboxes = capture(lines, CHECKBOX);
  if (checkboxes.length > 0) return checkboxes;

  const section = criteriaSection(lines);

  // List items win over prose inside the section, so an introductory sentence above the bullets
  // does not become a criterion of its own.
  const items = capture(section, LIST_ITEM);
  if (items.length > 0) return items;

  return section.map((line) => line.trim()).filter((line) => line !== "");
}

/** The lines under the first criteria heading, up to the next heading of any level. */
function criteriaSection(lines: string[]): string[] {
  const start = lines.findIndex((line) => {
    const heading = HEADING.exec(line);
    return heading !== null && CRITERIA_HEADING.test(heading[1] ?? "");
  });
  if (start === -1) return [];

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => HEADING.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

/** Strip the marker, trim, drop what is left empty. A bare `- [ ]` states no criterion. */
function capture(lines: string[], pattern: RegExp): string[] {
  const captured: string[] = [];
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match === null) continue;
    const text = (match[1] ?? "").trim();
    if (text !== "") captured.push(text);
  }
  return captured;
}
