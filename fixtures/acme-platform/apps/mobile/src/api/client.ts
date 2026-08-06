export async function createOrder(): Promise<Response> {
  return fetch("/v1/orders", { method: "POST" });
}

export async function fetchOrder(id: string): Promise<Response> {
  return fetch(`/v1/orders/${id}`);
}

export async function fetchLoyaltyPoints(): Promise<Response> {
  return fetch("/v1/loyalty/points");
}
