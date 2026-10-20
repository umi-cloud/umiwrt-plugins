/*
 * 节点延迟的纯函数。路由器直接连接节点服务器的端口测 TCP 握手耗时（sight.homeproxy node_latency），
 * 只走 UDP 的协议改为 ping；结果只反映服务器是否在线与线路远近，不代表代理速度。
 */

/* rpcd 一次最多测 128 个，页面分批以便逐批显示 */
export const LATENCY_BATCH = 64;
/* 同时进行的 ping 数 */
export const PING_CONCURRENCY = 4;
/* 延迟快慢的分界（毫秒）：到境外服务器 150 以内算快，350 以内一般 */
const LATENCY_FAST = 150, LATENCY_FAIR = 350;
const FAILED = ['timeout', 'refused', 'unresolved', 'error'];

/** 纯函数：延迟结果 → 'fast' | 'fair' | 'slow' | 'failed'；未测、测试中、不支持为空串 */
export function latencyTone(l) {
	if (typeof l === 'number') return l <= LATENCY_FAST ? 'fast' : l <= LATENCY_FAIR ? 'fair' : 'slow';
	return FAILED.includes(l) ? 'failed' : '';
}

/** 纯函数：按延迟排序：有毫秒数的从快到慢，其后是失败的，最后是未测或不支持的；同档保持原顺序 */
export function sortByLatency(nodes, latency) {
	const key = n => { const l = latency[n.id]; return typeof l === 'number' ? [0, l] : [FAILED.includes(l) ? 1 : 2, 0]; };
	return [...nodes].sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1]; });
}

/** 纯函数：ping 输出 → 平均延迟（毫秒，取整）；全部丢包或格式不符返回 null */
export function parsePing(stdout) {
	const m = String(stdout || '').match(/min\/avg\/max(?:\/\w+)? = [\d.]+\/([\d.]+)\//);
	return m ? Math.max(1, Math.round(Number(m[1]))) : null;
}
