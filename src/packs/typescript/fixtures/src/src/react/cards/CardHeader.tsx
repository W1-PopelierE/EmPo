export function CardHeader({ label }: { label: string }) {
  return <header className="card-header">{label}</header>;
}

CardHeader.Title = function Title({ children }: { children: unknown }) {
  return <h2>{children}</h2>;
};
