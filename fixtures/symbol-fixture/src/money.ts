export function formatMoney(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function parseMoney(text: string): number {
  return Math.round(Number(text) * 100);
}
