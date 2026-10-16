/*
 * MD5（按 UTF-8 字节计算，输出 32 位小写十六进制）。订阅节点的 grouphash 是 update_subscriptions.uc
 * 对订阅地址（去掉 # 之后的部分）取的 md5，页面用它把节点对应回订阅地址。浏览器的 WebCrypto 不提供 MD5。
 */
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
	4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(text) {
	const bytes = new TextEncoder().encode(String(text));
	const len = bytes.length, total = ((len + 8) >>> 6) + 1 << 6;
	const buf = new Uint8Array(total);
	buf.set(bytes);
	buf[len] = 0x80;
	const view = new DataView(buf.buffer);
	view.setUint32(total - 8, (len * 8) >>> 0, true);
	view.setUint32(total - 4, Math.floor(len / 0x20000000), true);
	let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
	for (let off = 0; off < total; off += 64) {
		let a = a0, b = b0, c = c0, d = d0;
		for (let i = 0; i < 64; i++) {
			let f, g;
			if (i < 16) { f = (b & c) | (~b & d); g = i; }
			else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
			else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
			else { f = c ^ (b | ~d); g = (7 * i) % 16; }
			const x = (a + f + K[i] + view.getUint32(off + g * 4, true)) | 0;
			a = d; d = c; c = b;
			b = (b + ((x << S[i]) | (x >>> (32 - S[i])))) | 0;
		}
		a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
	}
	return [a0, b0, c0, d0].map(v => Array.from({ length: 4 }, (_, i) => ((v >>> (i * 8)) & 0xff).toString(16).padStart(2, '0')).join('')).join('');
}
