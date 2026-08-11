import { CardFooter } from "./cardFooter";

// The tag is spelled `CardFooter` and the file it names is `cardFooter.tsx`, which is how half the
// React repositories in the world spell a component. No node carries the exact name, so before the
// case fold this reference was `unknown` and the component was rendered, in this graph, by nobody.
//
// The import is what makes the fold stand. A tag spelled exactly as a file is the language's own
// convention answering; a fold is the engine guessing that a naming style is in play, and the guess
// is only admitted where the rendering file's own imports bind that name to that module. Delete this
// line and the tag below goes back to being `unknown` — which is the whole difference between this
// file and cal.com's `<Toaster />`, imported from a package and folding onto a local `toaster.tsx`.
export function CardShelf() {
  return (
    <section>
      <CardFooter />
    </section>
  );
}
