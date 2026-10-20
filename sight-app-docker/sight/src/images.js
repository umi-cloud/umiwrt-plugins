/* 镜像：引用的校验与规范化、有无新版的判断、Docker Hub 搜索结果、拉取进度（纯函数） */

/* 镜像引用：[仓库主机[:端口]/]路径[:标签 | @sha256:摘要]，与设备端 sight.docker 的校验一致 */
const IMAGE_RE = /^([A-Za-z0-9.-]+(:[0-9]+)?\/)?[a-z0-9]+([._-]+[a-z0-9]+)*(\/[a-z0-9]+([._-]+[a-z0-9]+)*)*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})?$/;

export const isImageRef = s => typeof s === 'string' && s.length <= 255 && IMAGE_RE.test(s);

/** 纯函数：未写标签的引用补 :latest（与 Docker 拉取时的缺省一致），便于和本地标签比对 */
export function normalizeImage(ref) {
	const s = String(ref || '').trim();
	if (!s || s.includes('@')) return s;
	return s.lastIndexOf(':') > s.lastIndexOf('/') ? s : `${s}:latest`;
}

/** 纯函数：容器能否「更新到新版镜像」：须由带标签的镜像引用创建（不是镜像 ID 或摘要） */
export const canUpdate = ref => isImageRef(ref) && !ref.includes('@') && !/^sha256:/.test(ref);

/* 列表接口在容器所用的标签已移到别的镜像时给出镜像 ID（sha256:… 或十六进制） */
export const IMAGE_ID_RE = /^(sha256:)?[a-f0-9]{12,64}$/;

/** 纯函数：镜像引用 → 与本机标签一致的写法（补 :latest，去掉 Docker Hub 的 docker.io/ 与 library/ 前缀）；镜像 ID 或摘要返回 '' */
export function imageRefOf(image) {
	const s = normalizeImage(image);
	if (!s || IMAGE_ID_RE.test(String(image).trim()) || !canUpdate(s)) return '';
	return s.replace(/^(docker\.io|index\.docker\.io)\//, '').replace(/^library\/(?=[^/]+$)/, '');
}

/**
 * 纯函数：容器是否有新版镜像 → 'available' | 'latest' | 'unknown' | 'none'。
 * 本机标签已指向别的镜像即有新版（无需联网）；否则用最近一次检查得到的仓库摘要与容器所用镜像的摘要比对。
 * checks：check_list 的结果 { 引用: { digest } | { error } }
 */
export function updateState(c, images, checks) {
	if (!c.ref) return 'none';
	const tagged = (images || []).find(i => i.tags.includes(c.ref));
	if (tagged && tagged.id !== c.imageId) return 'available';
	const digest = checks?.[c.ref]?.digest;
	const mine = (images || []).find(i => i.id === c.imageId);
	if (!digest || !mine?.digests?.length) return 'unknown';
	return mine.digests.includes(digest) ? 'latest' : 'available';
}

/** 纯函数：要检查的镜像引用（去重、排序） */
export const checkRefs = containers => [...new Set((containers || []).map(c => c.ref).filter(Boolean))].sort();

/** 纯函数：最近一次检查的时间（各镜像中最早的）；从未检查为 null */
export function lastChecked(containers, checks) {
	const times = checkRefs(containers).map(r => checks?.[r]?.checked).filter(Boolean);
	return times.length ? Math.min(...times) : null;
}

/* 搜索关键词：字母数字开头，只含字母数字与 . _ - / 空格，与设备端一致 */
const TERM_RE = /^[A-Za-z0-9][A-Za-z0-9._/ -]*$/;

export const isSearchTerm = s => typeof s === 'string' && s.trim().length <= 100 && TERM_RE.test(s.trim());

/** 纯函数：搜索结果排序：官方镜像在前，其余按星数从多到少 */
export function sortResults(results) {
	return [...(results || [])].sort((a, b) => (b.official ? 1 : 0) - (a.official ? 1 : 0) || b.stars - a.stars || a.name.localeCompare(b.name));
}

/** 纯函数：拉取进度百分比；层大小未知时为 null */
export function pullPercent(task) {
	return task?.total > 0 ? Math.min(100, Math.floor(task.current / task.total * 100)) : null;
}
