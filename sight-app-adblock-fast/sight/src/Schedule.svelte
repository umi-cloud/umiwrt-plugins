<script>
	import { onDestroy } from 'svelte';
	import { t, errorText, client, Card, Field, Select, Input, FormActions, Feedback } from '@sight/sdk';
	import { createSchedule, validTime } from './schedule.js';

	/* 自动更新：写 crontab 即时生效，不走暂存，所以有自己的保存按钮 */
	const svc = createSchedule(client);
	let sched = $state(null), base = $state(''), notice = $state(null), busy = $state(false), alive = true;
	onDestroy(() => { alive = false; });
	const dirty = $derived(!!sched && JSON.stringify(sched) !== base);
	const timed = $derived(sched?.mode === 'daily' || sched?.mode === 'weekly');
	const timeError = $derived(timed && !validTime(sched.time) ? t('Invalid time') : '');
	const dayName = d => [t('Sunday'), t('Monday'), t('Tuesday'), t('Wednesday'), t('Thursday'), t('Friday'), t('Saturday')][d];

	svc.load().then(s => { if (alive) { sched = s; base = JSON.stringify(s); } }, e => { if (alive) notice = { tone: 'error', text: errorText(e) }; });

	async function save(event) {
		event.preventDefault();
		if (busy || timeError) return;
		busy = true; notice = null;
		try {
			await svc.save(sched);
			if (alive) { base = JSON.stringify(sched); notice = { tone: 'success', text: sched.mode === 'off' ? t('Automatic updates turned off.') : t('Automatic updates saved.') }; }
		} catch (e) { if (alive) notice = { tone: 'error', text: errorText(e) }; }
		finally { if (alive) busy = false; }
	}
</script>

{#if sched}
	<Card icon="startup" title={t('Automatic updates')} name="adblock-schedule">
		<form class="sched" onsubmit={save} aria-label={t('Automatic updates')}>
			<p class="muted">{t('Download the block-lists again on a schedule so new ad and tracker domains are blocked. Runs only while ad blocking is on.')}</p>
			{#if sched.mode === 'other'}
				<p class="muted" data-schedule="other">{t('A custom schedule is set: %s. Choose a new one below to replace it.', sched.line)}</p>
			{/if}
			<div class="fields">
				<Field id="adblock-sched-mode" label={t('Frequency')}>
					<Select id="adblock-sched-mode" bind:value={sched.mode} disabled={busy}>
						<option value="off">{t('Off')}</option>
						<option value="daily">{t('Every day')}</option>
						<option value="weekly">{t('Every week')}</option>
						{#if sched.mode === 'other'}<option value="other">{t('Custom')}</option>{/if}
					</Select>
				</Field>
				{#if sched.mode === 'weekly'}
					<Field id="adblock-sched-day" label={t('Day')}>
						<Select id="adblock-sched-day" bind:value={sched.day} disabled={busy}>
							{#each [1, 2, 3, 4, 5, 6, 0] as d}<option value={d}>{dayName(d)}</option>{/each}
						</Select>
					</Field>
				{/if}
				{#if timed}
					<Field id="adblock-sched-time" label={t('Time')} error={timeError}>
						<Input id="adblock-sched-time" type="time" bind:value={sched.time} disabled={busy} aria-invalid={!!timeError} />
					</Field>
				{/if}
			</div>
			{#if notice}<Feedback tone={notice.tone} message={notice.text} compact />{/if}
			<FormActions {busy} disabled={!dirty || !!timeError || sched.mode === 'other'} description={t('Takes effect immediately after saving.')} />
		</form>
	</Card>
{:else if notice}
	<Feedback tone={notice.tone} message={notice.text} />
{/if}

<style lang="less">
	.sched { display: flex; flex-direction: column; gap: var(--sp-4); }
	.fields { display: flex; flex-wrap: wrap; gap: var(--sp-4); }
	.fields > :global(*) { flex: 1 1 12rem; }
	.muted { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
</style>
