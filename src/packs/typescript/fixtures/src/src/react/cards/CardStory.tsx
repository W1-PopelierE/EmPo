import { CardHeader } from "./CardHeader";

// Two tags, one of which names a file and one of which names this file's own const. `<CardFooter />`
// renders the local wrapper declared three lines down, not `cardFooter.tsx` beside it, and a
// strategy that only ever asks the root's index which file carries a name cannot see the difference:
// the index answers, an edge is written, and a reader following it lands in a file this one neither
// imports nor renders.
//
// Measured on marmelab/react-admin, where story files declare their own inputs beside the real ones:
// 139 of 2715 template edges were this. `<CardHeader />` is here to say the refusal is about the
// shadowed name and not about the file: the tag this file does not declare still resolves.
const CardFooter = () => <footer className="story" />;

export function CardStory() {
  return (
    <article>
      <CardHeader label="story" />
      <CardFooter />
    </article>
  );
}
