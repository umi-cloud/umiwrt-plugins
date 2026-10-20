<script>
	import { t, useEditor, Field, Textarea, Badge, FormActions } from '@sight/sdk';
	import { previewLinks } from './service.js';
	import { nodesText } from './labels.js';

	/* 导入分享链接（放在节点分区的抽屉里）：逐行预览识别结果，只导入能识别的。onsubmit(nodes) 由节点分区写入。 */
	let { features = {}, locked = false, saving = false, onsubmit, oncancel } = $props();
	let text = $state('');
	const preview = $derived(previewLinks(text, features));
	const valid = $derived(preview.filter(r => r.node).map(r => r.node));
	useEditor(() => ({ dirty: !!text.trim() }));
	async function submit(event) {
		event.preventDefault();
		if (locked || !valid.length) return;
		await onsubmit(valid);
	}
</script>

<form class="hp-form" onsubmit={submit} aria-label={t('Import share links')}>
	<Field id="hp-links" label={t('Share links')} help={t('One link per line: vless://, vmess://, trojan://, ss://, hysteria2://, tuic://, anytls://, socks5://, http(s)://')}>
		<Textarea id="hp-links" rows="7" bind:value={text} disabled={locked} spellcheck="false" aria-describedby="hp-links-help" />
	</Field>
	{#if preview.length}
		<ul class="preview" aria-label={t('Recognized links')}>
			{#each preview as row}
				<li data-valid={row.node ? 'yes' : 'no'}>
					{#if row.node}<Badge tone="success">{row.node.type}</Badge><span><strong>{row.node.label}</strong> <span class="hp-muted hp-mono">{row.node.address}:{row.node.port}</span></span>
					{:else}<Badge tone="danger">{t('Not recognized')}</Badge><span class="hp-muted hp-mono clip">{row.link}</span>{/if}
				</li>
			{/each}
		</ul>
	{/if}
	<FormActions busy={saving} disabled={locked || !valid.length} {oncancel} saveLabel={valid.length ? t('Import %s', nodesText(valid.length)) : t('Import')}
		description={t('Imported nodes are added when you save.')} />
</form>

<style>
	.preview { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); max-height: 40vh; overflow: auto; }
	.preview li { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; font-size: var(--fs-sm); }
	.clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
</style>
