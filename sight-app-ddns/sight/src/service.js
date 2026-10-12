/*
 * DDNS（ddns-scripts）：实例为 ddns 配置的 service 段，写入走会话暂存；
 * 状态、日志由 luci.ddns 读取；服务商取 /usr/share/ddns/default/*.json 的文件名。
 * 即时操作：整体启停（init）、单实例立即更新/停止（lucihelper，参数与 ACL 逐字对应）。
 * 服务商二选一：service_name（预置）或 update_url（自定义），切换时删除另一项。
 */
import { isHostname, probe, ignoreNotFound } from '@sight/sdk/lib';

const HELPER = '/usr/lib/ddns/dynamic_dns_lucihelper.sh';

/* 常用服务商排在选择列表前面（仅显示本机实际提供的） */
export const FEATURED = ['duckdns.org', 'dynu.com', 'he.net', 'namecheap.com', 'dynv6.com', 'desec.io', 'oray.com', '3322.org'];

/** 状态归纳：条目停用 / 自动更新关闭 / 正在运行 / 已同步 / 等待首次更新 */
export function entryState(entry, serviceEnabled) {
	if (!entry.enabled) return 'off';
	if (!serviceEnabled) return 'paused';
	/* 状态读不到（undefined）时为未知，不当作「等待首次更新」 */
	if (entry.status === undefined) return 'unknown';
	if (entry.status?.ip) return 'synced';
	if (entry.status?.pid) return 'running';
	return 'waiting';
}

export function createDdns(client, uci) {
	function validate(s, existing) {
		const e = [];
		if (!s.id && !/^[a-zA-Z0-9_]{1,32}$/.test(s.name)) e.push('Name must be 1-32 letters, digits or underscores');
		else if (!s.id && existing.includes(s.name)) e.push('A DDNS entry with this name already exists');
		if (s.provider === 'custom') { if (!/^https?:\/\/\S+$/.test(s.updateUrl.trim())) e.push('Enter an update URL starting with http:// or https://'); }
		else if (!s.provider) e.push('Choose a provider');
		/* 部分服务商要求 host@domain 等写法，只拒绝空值与空白 */
		if (!s.domain.trim() || /\s/.test(s.domain)) e.push('Invalid domain');
		if (s.lookupHost.trim() && !isHostname(s.lookupHost.trim())) e.push('Invalid lookup host');
		return e;
	}

	function plan(s) {
		const values = {
			enabled: s.enabled ? '1' : '0', use_ipv6: s.ipv6 ? '1' : '0', domain: s.domain.trim(),
			lookup_host: (s.lookupHost.trim() || s.domain.trim()), ip_source: 'network', ip_network: s.network, interface: s.network,
		};
		const remove = [];
		if (s.provider === 'custom') { values.update_url = s.updateUrl.trim(); remove.push('service_name'); }
		else { values.service_name = s.provider; remove.push('update_url'); }
		for (const [k, v] of [['username', s.username], ['password', s.password]]) { if (v) values[k] = v; else remove.push(k); }
		return { values, remove };
	}

	return {
		validate, plan,
		/** @returns {Promise<null | object>} null = 未安装 */
		async load() {
			const state = await probe(client, 'luci.ddns', 'get_ddns_state');
			if (!state) return null;
			const [cfg, status, dir, network] = await Promise.all([
				uci.load('ddns'),
				client.call('luci.ddns', 'get_services_status').catch(() => null),
				/* 服务商目录不存在视为没有预置服务商；其它读取失败单独标记，不当作空列表 */
				client.call('file', 'list', { path: '/usr/share/ddns/default' }).catch(e => e?.status === 4 ? { entries: [] } : null),
				uci.load('network').catch(() => ({})),
			]);
			const services = Object.values(cfg).filter(s => s['.type'] === 'service').map(s => ({
				id: s['.name'], name: s['.name'], enabled: s.enabled === '1', ipv6: s.use_ipv6 === '1',
				provider: s.update_url && !s.service_name ? 'custom' : (s.service_name || ''), updateUrl: s.update_url || '',
				domain: s.domain || '', lookupHost: s.lookup_host || '', username: s.username || '', password: s.password || '',
				network: s.ip_network || s.interface || 'wan',
				status: status ? status[s['.name']] || null : undefined,
			}));
			return {
				enabled: !!state._enabled, version: String(state._version || '').trim(), services,
				providersError: !dir,
				providers: (dir?.entries || []).filter(e => e.type === 'file' && e.name.endsWith('.json')).map(e => e.name.slice(0, -5)).sort(),
				networks: Object.values(network).filter(s => s['.type'] === 'interface' && s['.name'] !== 'loopback').map(s => s['.name']),
			};
		},
		async save(s) {
			const { values, remove } = plan(s);
			if (s.id) {
				await uci.set('ddns', s.id, values);
				if (remove.length) await uci.remove('ddns', s.id, remove).catch(ignoreNotFound);
			} else {
				await uci.add('ddns', 'service', s.name, values);
			}
		},
		async remove(id) { await uci.remove('ddns', id); },
		async setEnabled(id, on) { await uci.set('ddns', id, { enabled: on ? '1' : '0' }); },
		/** 整体启停：开机自启与运行状态一并切换（与 LuCI 行为一致） */
		async toggleService(on) {
			await client.call('luci', 'setInitAction', { name: 'ddns', action: on ? 'enable' : 'disable' });
			await client.call('luci', 'setInitAction', { name: 'ddns', action: on ? 'start' : 'stop' });
		},
		/** 单实例立即更新 / 停止 */
		async run(name, action) {
			if (!['start', 'stop'].includes(action)) throw new Error('Unknown action');
			const r = await client.call('file', 'exec', { command: HELPER, params: ['-S', name, '--', action] });
			if ((r.code ?? 0) !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim());
		},
		/** 服务商需要哪些凭据：按更新地址模板中的占位符判断；读不到时两项都显示 */
		async providerInfo(name) {
			if (!name || name === 'custom') return { username: true, password: true, ipv6: true };
			try {
				const r = await client.call('file', 'read', { path: `/usr/share/ddns/default/${name}.json` });
				const def = JSON.parse(r.data || '{}');
				const urls = [def.ipv4?.url, def.ipv6?.url].filter(Boolean).join(' ');
				const scripted = !urls && (def.ipv4?.script || def.ipv6?.script);
				return { username: scripted || urls.includes('[USERNAME]'), password: scripted || urls.includes('[PASSWORD]'), ipv6: !!def.ipv6 };
			} catch { return { username: true, password: true, ipv6: true }; }
		},
		async log(name) {
			const r = await client.call('luci.ddns', 'get_services_log', { service_name: name });
			const text = String(r?.result ?? '');
			return text === 'File not found or empty' ? '' : text;
		},
	};
}
