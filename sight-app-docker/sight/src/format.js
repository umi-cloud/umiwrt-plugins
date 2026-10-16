/* 页面共用的展示文案与格式 */
import { t } from '@sight/sdk';

export const stateTone = s => s === 'running' ? 'success' : s === 'exited' || s === 'dead' ? 'neutral' : 'info';
export const stateLabel = s => ({ running: t('Running'), exited: t('Stopped'), paused: t('Paused'), restarting: t('Restarting'), created: t('Created'), dead: t('Dead') }[s] || s);
export const policyLabel = p => ({ 'unless-stopped': t('Always, unless I stop it'), always: t('Always'), 'on-failure': t('Only when it exits with an error'), no: t('Never') }[p] || p);
export const short = id => id.replace(/^sha256:/, '').slice(0, 12);
/* Docker 给出 UTC 秒数，按浏览器时区显示为固定格式 */
const pad = n => String(n).padStart(2, '0');
export const date = sec => { if (!sec) return '-'; const d = new Date(sec * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
