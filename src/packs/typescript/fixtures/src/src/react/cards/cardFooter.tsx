// A component file named the way half of the React repositories in the world name them, in
// lowerCamelCase, while the tag that renders it is `<CardFooter />`. The exact-name index carries
// "cardFooter" and nothing carries "CardFooter", so before the case fold this file was a component
// nobody in the corpus rendered and every reference to it was `unknown`.
//
// Measured on a real 186-file React Native application whose components are all named this way: 3
// of 1531 tag references resolved. The fold is what makes that repository's graph exist, and it
// stays a fallback: CardHeader.tsx beside this file is spelled as its tag and is answered by the
// exact index, which is what keeps a repository that agrees with itself from ever paying for one
// that does not.
export function CardFooter() {
  return <footer />;
}
