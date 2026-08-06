export type Money = { cents: number; currency: string };

export function formatMoney(money: Money): string {
  return (money.cents / 100).toFixed(2) + " " + money.currency;
}
