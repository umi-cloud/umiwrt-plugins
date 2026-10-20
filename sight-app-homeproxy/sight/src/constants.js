/*
 * HomeProxy 配置里的固定取值与页面用到的预设，统一放在这里；其它模块只引用，不再各自写字面量。
 * 取值以 generate_client.uc / firewall_post.ut 实际读取的为准。
 */

/* main_node / main_udp_node / routing.default_outbound 的「关闭」取值 */
export const OFF = 'nil';
/* main_udp_node：与主节点相同 */
export const SAME = 'same';
/* main_node / routing_node.node：在多个节点里自动选最快的 */
export const URLTEST = 'urltest';
/* routing_mode：自定义分流 */
export const CUSTOM = 'custom';

export const MODES = ['bypass_mainland_china', 'gfwlist', 'proxy_mainland_china', 'global'];
export const DEFAULT_MODE = 'bypass_mainland_china';
/* 切到自定义分流时按当前模式给出最接近的模板 */
export const TEMPLATE_BY_MODE = { bypass_mainland_china: 'bypass_china', gfwlist: 'bypass_china', global: 'global' };

/* 预置 DNS 与上游 HomeProxy 的选项一致；wan 表示使用上联下发的 DNS */
export const DNS_PRESETS = ['wan', '1.1.1.1', '8.8.8.8', '208.67.222.222', '223.5.5.5', '119.29.29.29'];
export const CHINA_DNS_PRESETS = ['wan', '223.5.5.5', '119.29.29.29', '210.2.4.8'];
export const DEFAULT_DNS = '8.8.8.8', DEFAULT_CHINA_DNS = '223.5.5.5';

/* 走代理的端口：common 为 infra.common_port 里的常用端口，all 即删除 routing_port，custom 为逗号分隔的端口或范围 */
export const PORT_CHOICES = ['common', 'all', 'custom'];
export const DEFAULT_COMMON_PORTS = '22,53,80,143,443,465,587,853,873,993,995,8080,8443,9418';

/* sing-box 日志级别，默认 warn；排查问题时临时调高 */
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];
export const DEFAULT_LOG_LEVEL = 'warn';
/* /var/run/homeproxy 下的日志：服务脚本与 sing-box 客户端 */
export const LOGS = ['homeproxy', 'sing-box-c'];

export const SITES = ['google', 'baidu'];

/* 哪些设备走代理：全部 / 仅名单内（lan_proxy_mac_addrs）/ 名单外（lan_direct_mac_addrs 直连） */
export const ACCESS = ['disabled', 'listed_only', 'except_listed'];
/*
 * 按设备的规则：gaming（游戏模式）该设备走代理的流量不受端口限制；global（全局代理）不按分流模式区分、全部走代理，
 * 自定义分流下不生效。两个名单都有同一设备时防火墙先匹配全局代理，所以每台设备只取一种
 */
export const DEVICE_RULES = ['gaming', 'global'];

/* 规则库，与 scripts/update_resources.sh 一致 */
export const RESOURCES = ['china_ip4', 'china_ip6', 'china_list', 'gfw_list'];
/* 各分流模式依赖的规则库：缺失时该模式无法正确分流 */
export const MODE_RESOURCES = {
	bypass_mainland_china: ['china_ip4', 'china_ip6'],
	proxy_mainland_china: ['china_ip4', 'china_ip6', 'china_list'],
	gfwlist: ['gfw_list'],
};
/* 自定义域名列表：proxy_list 强制走代理，direct_list 强制直连（自定义分流模式下不生效） */
export const DOMAIN_LISTS = ['proxy_list', 'direct_list'];

/* sing-box 的编译特性与设备的内核能力（singbox_get_features）：缺少时相应的节点或功能用不了 */
export const CORE_FEATURES = ['with_quic', 'with_utls', 'with_wireguard', 'hp_has_tproxy', 'hp_has_tun'];
