/*
 * 各类取值的显示文案，集中在这里，组件只引用。都依赖当前语言的 t()，不是纯函数。
 */
import { t } from '@sight/sdk';
import { OFF, SAME } from './constants.js';
import { find, DIRECT, BLOCK } from './routing.js';
import { durationParts } from './format.js';

/** 列表项按当前语言的分隔符连接（中文用顿号） */
export const listText = items => items.join(t(', '));
/** 带数量的名词：英文区分单复数 */
export const nodesText = n => n === 1 ? t('1 node') : t('%d nodes', n);

export const modeLabel = m => ({ bypass_mainland_china: t('Proxy sites outside mainland China'), gfwlist: t('Proxy blocked sites only (GFWList)'), proxy_mainland_china: t('Proxy mainland China sites only'), global: t('Proxy everything'), custom: t('Custom routing') }[m] || m);
export const templateLabel = v => ({ bypass_china: t('Bypass mainland China'), global: t('Proxy everything'), blank: t('Start empty') }[v]);
export const templateHint = v => ({ bypass_china: t('Mainland China sites and addresses go direct, everything else through the proxy.'), global: t('Everything goes through the proxy except local network addresses.'), blank: t('Everything goes direct until you add rules.') }[v]);

const DNS_PROVIDERS = { '1.1.1.1': 'Cloudflare', '8.8.8.8': 'Google', '208.67.222.222': 'Cisco OpenDNS', '223.5.5.5': 'Aliyun', '119.29.29.29': 'Tencent', '210.2.4.8': 'CNNIC' };
/** 预置 DNS 的名称：wan 为上联 DNS，其余为「服务商 (地址)」 */
export const dnsLabel = v => v === 'wan' ? t('Uplink DNS (from WAN)') : DNS_PROVIDERS[v] ? `${t(DNS_PROVIDERS[v])} (${v})` : v;
export const udpLabel = v => v === SAME ? t('Same as main node') : v === OFF ? t('Go out directly') : v;
export const portsLabel = p => ({ common: t('Common ports'), all: t('All ports'), custom: t('Custom…') }[p]);

/* 自定义分流 */
export const outboundName = (custom, o) => o === DIRECT ? t('Direct') : o === BLOCK ? t('Block traffic') : find(custom, 'outbound', o)?.label || o;
export const dnsName = (custom, d) => ({ 'default-dns': t('Uplink DNS (from WAN)'), 'system-dns': t('System DNS') }[d] || find(custom, 'dns', d)?.label || d);
export const kindName = k => ({ outbound: t('Outbound'), rule: t('Routing rule'), ruleset: t('Rule set'), dns: t('DNS server'), dnsRule: t('DNS rule') }[k]);
export const strategyName = s => ({ '': t('Default'), prefer_ipv4: t('Prefer IPv4'), prefer_ipv6: t('Prefer IPv6'), ipv4_only: t('IPv4 only'), ipv6_only: t('IPv6 only') }[s]);

/* 设备 */
export const accessLabel = m => ({ disabled: t('All devices'), listed_only: t('Only selected'), except_listed: t('All except selected') }[m]);
export const accessHint = m => ({ disabled: t('Every device on your network uses the proxy rules above.'), listed_only: t('Only the selected devices use the proxy; everything else goes out directly.'), except_listed: t('Selected devices always go out directly; all others use the proxy.') }[m]);
export const deviceRuleLabel = r => ({ gaming: t('All ports through the proxy'), global: t('Everything through the proxy') }[r]);
export const deviceRuleHint = r => ({ gaming: t('Traffic from the device that goes through the proxy is not limited to the ports set under Routing. Use it for games and apps on unusual ports; UDP is covered only when UDP traffic goes through the proxy.'), global: t('The routing mode is ignored for the device, so everything it sends to the proxied ports goes through the proxy. Not used with custom routing.') }[r]);

/* 规则库 */
export const resourceLabel = r => ({ china_ip4: t('China IPv4 addresses'), china_ip6: t('China IPv6 addresses'), china_list: t('China domain list'), gfw_list: t('GFWList') }[r]);
export const updateResultLabel = r => ({ updated: t('Updated'), latest: t('Already up to date'), busy: t('An update is already running'), failed: t('Update failed') }[r]);

/* 延迟 */
export const latencyText = l => l === undefined ? '-' : typeof l === 'number' ? t('%d ms', l)
	: { testing: t('Testing…'), timeout: t('No reply'), refused: t('Refused'), unresolved: t('Name not resolved'), unsupported: t('Not supported') }[l] || t('Failed');

/* sing-box */
export const siteLabel = s => ({ google: 'Google', baidu: t('Baidu') }[s]);
export const logLabel = l => l === 'homeproxy' ? t('Service') : 'sing-box';
export const logLevelLabel = l => ({ error: t('Errors only'), warn: t('Warnings (default)'), info: t('Info'), debug: t('Debug') }[l] || l);
export const featureLabel = f => ({ with_quic: 'QUIC', with_utls: 'uTLS', with_wireguard: 'WireGuard', hp_has_tproxy: 'TProxy', hp_has_tun: 'TUN' }[f]);
export const featureHint = (f, ok) => ok ? {
	with_quic: t('Needed by Hysteria2 and TUIC nodes.'), with_utls: t('Needed by VLESS Reality nodes and TLS fingerprints.'), with_wireguard: t('Needed by WireGuard nodes.'),
	hp_has_tproxy: t('Kernel support for sending UDP traffic through the proxy.'), hp_has_tun: t('Kernel support for TUN mode.'),
}[f] : {
	with_quic: t('Hysteria2 and TUIC nodes cannot be used. Install a sing-box build with QUIC support.'), with_utls: t('VLESS Reality nodes and TLS fingerprints cannot be used. Install a sing-box build with uTLS support.'),
	with_wireguard: t('WireGuard nodes cannot be used. Install a sing-box build with WireGuard support.'), hp_has_tproxy: t('UDP traffic cannot go through the proxy. Install kmod-nft-tproxy.'), hp_has_tun: t('TUN mode cannot be used. Install kmod-tun.'),
}[f];
export function durationText(sec) {
	const { days, hours, minutes } = durationParts(sec);
	return days ? t('%d d %d h', days, hours) : hours ? t('%d h %d min', hours, minutes) : t('%d min', minutes);
}
export const diagnosisText = d => t({ generate: 'sing-box did not start: the client configuration could not be generated (%s).', check: 'sing-box did not start: it rejected the generated configuration (%s).', exited: 'sing-box stopped soon after starting (%s).' }[d.reason], d.detail || t('see the log'));
