const queue = [];

export function trackOrder(id) {
  queue.push(id);

  return queue.length;
}
