// 訂單內的單機流水號：不論同一商品是一次訂多台或分開加入，都依商品順序、再依單機順序編為 1、2、3…
// 已取消的單機排在最後，編號接在有效單機後面。
import type { Device, OrderItem } from './types';

export function unitNumbers(items: OrderItem[], devices: Device[]): Map<string, number> {
  const lineOf = new Map(items.map((i) => [i.id, i.line_no]));
  const sorted = [...devices].sort((a, b) =>
    Number(a.status === 'cancelled') - Number(b.status === 'cancelled')
    || (lineOf.get(a.order_item_id) ?? 0) - (lineOf.get(b.order_item_id) ?? 0)
    || a.unit_no - b.unit_no);
  return new Map(sorted.map((d, i) => [d.id, i + 1]));
}
