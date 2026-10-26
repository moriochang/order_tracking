// 匯出訂單：每台單機一列（與列表相同），已取消的訂單一列。
// Excel 檔所有欄位都存成文字，機號、序號、電話開頭的 0 與國際條碼不會被 Excel 改掉。
import { devicesForOrders, itemsForOrders } from './api';
import { fmtDate, fmtDateTime, todayTaipei } from './format';
import { STATUS_LABEL } from './labels';
import type { OrderSummary } from './types';

const HEADER = ['訂單編號', '門市', '顧客', '電話', '結帳日期', '機號', '序號', '預結號碼', '品名', '型號', '國際條碼',
  'SN', '狀態', '已貼', '到貨時間', '最近通知', '交付時間', '單機備註', '訂單備註'];
const WIDTHS = [16, 6, 10, 13, 11, 6, 8, 12, 34, 9, 15, 14, 12, 6, 17, 17, 17, 20, 20];

async function buildRows(orders: OrderSummary[]): Promise<string[][]> {
  const ids = orders.map((o) => o.id);
  const [items, devices] = await Promise.all([itemsForOrders(ids), devicesForOrders(ids)]);
  const itemById = new Map(items.map((i) => [i.item_id, i]));
  const rows: string[][] = [HEADER];
  for (const o of orders) {
    const head = [o.order_no, o.store_code, o.customer_name, o.customer_phone, fmtDate(o.purchase_date),
      o.register_no, o.receipt_seq, o.receipt_no ?? ''];
    const devs = devices.filter((d) => d.order_id === o.id && itemById.has(d.order_item_id))
      .sort((a, b) => items.indexOf(itemById.get(a.order_item_id)!) - items.indexOf(itemById.get(b.order_item_id)!) || a.unit_no - b.unit_no);
    if (o.order_status === 'cancelled' || !devs.length) {
      rows.push([...head, '', '', '', '', '已取消', '', '', '', '', '', o.order_note ?? '']);
      continue;
    }
    for (const d of devs) {
      const it = itemById.get(d.order_item_id)!;
      const time = (t: string | null) => (t ? fmtDateTime(t) : '');
      rows.push([...head, it.full_product_name, it.model ?? '', it.barcode ?? '', d.sn ?? '', STATUS_LABEL[d.status],
        d.is_labeled ? '是' : '', time(d.arrived_at), time(d.last_notified_at), time(d.delivered_at), d.note ?? '', o.order_note ?? '']);
    }
  }
  return rows;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileName = (ext: string) => `預購訂單_${todayTaipei().replaceAll('-', '')}.${ext}`;

export async function exportXlsx(orders: OrderSummary[]) {
  const rows = await buildRows(orders);
  const { default: writeExcelFile } = await import('write-excel-file/universal');
  const sheetData = rows.map((r, i) => r.map((v) => ({ value: v, type: String, ...(i === 0 ? { fontWeight: 'bold' as const } : {}) })));
  const blob = await writeExcelFile(sheetData, { columns: WIDTHS.map((width) => ({ width })), sheet: '訂單' }).toBlob();
  download(blob, fileName('xlsx'));
}

// CSV：UTF-8 加 BOM，Excel 才能正確顯示中文
export async function exportCsv(orders: OrderSummary[]) {
  const rows = await buildRows(orders);
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const text = '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
  download(new Blob([text], { type: 'text/csv;charset=utf-8' }), fileName('csv'));
}
