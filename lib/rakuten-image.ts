// 楽天の mediumImageUrls などのURL末尾は "_ex=128x128" のサムネイル指定になっているため、
// より大きいサイズを要求する（楽天のサムネイルCDNの挙動で、公式に文書化された仕様ではない）。
export function upsizeImage(url: string): string {
  return url.replace(/_ex=\d+x\d+/, "_ex=600x600");
}
