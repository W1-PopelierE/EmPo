import axios from "axios";
import type { Money } from "../shared/money";

export async function createOrder(total: Money): Promise<Response> {
  return fetch("/api/v1/orders", { method: "POST" });
}

export async function fetchOrder(id: string): Promise<Response> {
  return fetch(`/api/v1/orders/${id}`);
}

export async function health(): Promise<Response> {
  return fetch("https://api.acme.test/api/v1/health");
}

export async function cancelOrder(id: string): Promise<Response> {
  return axios.delete(`/api/v1/orders/${id}`);
}
