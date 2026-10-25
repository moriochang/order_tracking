// 拍照上傳前在瀏覽器縮圖並轉成 JPEG：重新繪製到 canvas 會去掉 GPS 等 EXIF 資料，也套用照片方向。
export async function compressImage(file: File, maxSide = 3000, quality = 0.8): Promise<{ base64: string; url: string }> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  await img.decode();
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  URL.revokeObjectURL(url);
  // 畫面預覽用 blob 網址（Safari 不允許在新分頁開 data: 網址）
  const blob = await (await fetch(dataUrl)).blob();
  return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), url: URL.createObjectURL(blob) };
}
