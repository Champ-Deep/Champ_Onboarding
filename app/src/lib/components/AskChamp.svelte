<script lang="ts">
	// The assistant panel, opened from the floating launcher in the corner of
	// every admin page.
	//
	// Two things here are deliberately NOT rendered from the model's prose: the
	// report table and the access proposal. Both come back as structured data
	// from the server and are drawn by this component, so a number the model
	// invented cannot appear in a table, and a permission change cannot happen
	// without a human pressing the button below.
	//
	// The same goes for team requests: the model drafts an access request or a
	// task, and it only exists once someone presses Send or Assign. Deciding one
	// is a button on a card too, never something the model does.
	import { tick } from 'svelte';
	import RequestCard from './RequestCard.svelte';
	import type { Draft, Inbox, RequestView } from '$lib/shared/requests';

	let { admin }: { admin: { email: string; role: string } } = $props();

	type Report = {
		title: string;
		columns: { key: string; label: string }[];
		rows: string[][];
		truncated: boolean;
	};
	type Proposal = {
		email: string;
		role: string;
		capability: string;
		capabilityLabel: string;
		from: string;
		to: string;
		reason: string | null;
		implemented: boolean;
	};
	type Turn = {
		role: 'user' | 'assistant';
		content: string;
		report?: Report;
		proposals?: Proposal[];
		/** Keyed by email+capability, because one turn can carry a card per person
		 *  and each is applied on its own. */
		applied: Record<string, string>;
		applyErrors: Record<string, string>;
		drafts?: Draft[];
		/** Keyed by the draft's position in the turn, once sent. */
		sent?: Record<number, RequestView>;
		sendErrors?: Record<number, string>;
		requests?: RequestView[];
	};

	const propKey = (p: Proposal) => `${p.email}:${p.capability}`;

	// Models write markdown whether or not you ask them not to, and the panel
	// was showing it raw: "**4**" and "* item" arrived as literal asterisks.
	//
	// Parsed into tokens and rendered as Svelte elements rather than pushed
	// through {@html}. That is not fussiness: this prose is shaped by candidate
	// records, so any path that turns model output into markup is a path from a
	// candidate's name field into the DOM. Tokens cannot carry HTML.
	type Inline = { t: 'text' | 'b' | 'code'; v: string };
	type Block = { kind: 'p' | 'li' | 'oli'; marker?: string; parts: Inline[] };

	function inlines(line: string): Inline[] {
		const out: Inline[] = [];
		// **bold** and `code`, in one pass so neither can swallow the other.
		const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
		let last = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(line))) {
			if (m.index > last) out.push({ t: 'text', v: line.slice(last, m.index) });
			if (m[1] !== undefined) out.push({ t: 'b', v: m[1] });
			else out.push({ t: 'code', v: m[2] });
			last = m.index + m[0].length;
		}
		if (last < line.length) out.push({ t: 'text', v: line.slice(last) });
		// A lone asterisk left over is emphasis the model opened and never closed,
		// or a stray bullet mid-line. It reads as noise either way.
		return out.map((i) => (i.t === 'text' ? { ...i, v: i.v.replace(/\*/g, '') } : i));
	}

	function blocks(md: string): Block[] {
		const out: Block[] = [];
		for (const raw of (md ?? '').split('\n')) {
			const line = raw.trimEnd();
			if (!line.trim()) continue;
			const bullet = line.match(/^\s*[-*\u2022]\s+(.*)$/);
			const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
			// Headings lose their hashes but keep their text — the panel has no
			// heading level to give them anyway.
			const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
			if (bullet) out.push({ kind: 'li', parts: inlines(bullet[1]) });
			else if (numbered) out.push({ kind: 'oli', marker: numbered[1] + '.', parts: inlines(numbered[2]) });
			else if (heading) out.push({ kind: 'p', parts: [{ t: 'b', v: heading[1].replace(/\*/g, '') }] });
			else out.push({ kind: 'p', parts: inlines(line) });
		}
		return out;
	}

	let open = $state(false);
	let question = $state('');
	let busy = $state(false);
	let error: string | null = $state(null);
	let turns = $state<Turn[]>([]);
	let scroller: HTMLDivElement | null = $state(null);
	let input: HTMLTextAreaElement | null = $state(null);

	const isSuperAdmin = $derived(admin.role === 'super_admin');

	const SUGGESTIONS = $derived([
		'How many candidates are awaiting review?',
		'Who has an offer letter still in draft?',
		'Show me a report: name, entity, track, designation, date of joining',
		isSuperAdmin ? 'Any access requests waiting on me?' : 'I need access to email offer letters to candidates',
		isSuperAdmin ? 'Ask a teammate to send the offer letter to a candidate' : 'What tasks do I have?'
	]);

	// ── requests & tasks ────────────────────────────────────────────────────
	let tab: 'chat' | 'requests' = $state('chat');
	let inbox = $state<Inbox | null>(null);
	let inboxError: string | null = $state(null);
	const badge = $derived(inbox?.badge ?? 0);

	async function loadInbox() {
		try {
			const res = await fetch('/admin/ai/requests');
			if (!res.ok) throw new Error(String(res.status));
			inbox = await res.json();
			inboxError = null;
		} catch {
			inboxError = 'Could not load requests.';
		}
	}

	async function openRequests() {
		tab = 'requests';
		await loadInbox();
		// Opening the tab is seeing the outcomes. Things still waiting on this
		// person keep the badge lit until they are settled.
		if (inbox?.badge) {
			await fetch('/admin/ai/requests/seen', { method: 'POST' }).catch(() => {});
			await loadInbox();
		}
	}

	// The launcher badge is how a super admin learns a request arrived, and how
	// a teammate learns they were given work, without having to ask. A minute is
	// soon enough for either, and a hidden tab does not poll at all.
	$effect(() => {
		loadInbox();
		const t = setInterval(() => {
			if (document.visibilityState === 'visible') loadInbox();
		}, 60_000);
		const onVis = () => document.visibilityState === 'visible' && loadInbox();
		document.addEventListener('visibilitychange', onVis);
		return () => {
			clearInterval(t);
			document.removeEventListener('visibilitychange', onVis);
		};
	});

	async function sendDraft(turn: Turn, i: number, d: Draft) {
		turn.sendErrors = { ...(turn.sendErrors ?? {}) };
		delete turn.sendErrors[i];
		const body =
			d.kind === 'access'
				? { kind: 'access', capability: d.capability, level: d.to, note: d.note }
				: { kind: 'task', toEmail: d.toEmail, title: d.title, candidateId: d.candidateId, dueAt: d.dueAt, note: d.note };
		try {
			const res = await fetch('/admin/ai/requests', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			const out = await res.json().catch(() => null);
			if (!res.ok) turn.sendErrors[i] = (out as { message?: string } | null)?.message ?? `Could not send (${res.status}).`;
			else turn.sent = { ...(turn.sent ?? {}), [i]: out as RequestView };
		} catch {
			turn.sendErrors[i] = 'Could not send — check your connection.';
		}
		turns = [...turns];
		loadInbox();
	}

	/** A card changed state: swap the new version into wherever it is shown. */
	function cardChanged(next: RequestView) {
		for (const t of turns) {
			if (t.requests) t.requests = t.requests.map((r) => (r.id === next.id ? next : r));
			if (t.sent) for (const k in t.sent) if (t.sent[k].id === next.id) t.sent[k] = next;
		}
		turns = [...turns];
		loadInbox();
	}

	const dueDay = (iso: string | null) =>
		iso ? new Date(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : '';

	async function send(text?: string) {
		const q = (text ?? question).trim();
		if (!q || busy) return;
		question = '';
		error = null;
		turns = [...turns, { role: 'user', content: q, applied: {}, applyErrors: {} }];
		busy = true;
		await scrollDown();
		try {
			const res = await fetch('/admin/ai', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					question: q,
					// Only the prose is replayed. Tables and proposals stay on screen
					// but are not re-sent: they are large, and the model already knows
					// what it produced.
					history: turns.map((t) => ({ role: t.role, content: t.content }))
				})
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				error = body?.message ?? `The assistant failed (${res.status}).`;
				return;
			}
			const body = await res.json();
			turns = [
				...turns,
				{
					role: 'assistant',
					content: body.reply,
					report: body.report,
					proposals: body.proposals ?? [],
					drafts: body.drafts ?? [],
					requests: body.requests ?? [],
					applied: {},
					applyErrors: {}
				}
			];
			if (body.drafts?.length || body.requests?.length) loadInbox();
		} catch {
			error = 'Could not reach the assistant — check your connection.';
		} finally {
			busy = false;
			await scrollDown();
		}
	}

	async function applyProposal(turn: Turn, p: Proposal) {
		if (!confirm(`Set "${p.capabilityLabel}" to ${p.to} for ${p.email}?`)) return;
		delete turn.applyErrors[propKey(p)];
		try {
			const res = await fetch('/admin/ai/apply', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: p.email, capability: p.capability, level: p.to })
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				turn.applyErrors[propKey(p)] = body?.message ?? `Could not apply (${res.status}).`;
			} else {
				const body = await res.json();
				turn.applied[propKey(p)] = body.to;
			}
		} catch {
			turn.applyErrors[propKey(p)] = 'Could not apply — check your connection.';
		}
		turns = [...turns];
	}

	function downloadCsv(r: Report) {
		const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
		const csv = [
			r.columns.map((c) => esc(c.label)).join(','),
			...r.rows.map((row) => row.map(esc).join(','))
		].join('\n');
		// A data: URL rather than a blob so nothing has to be revoked afterwards;
		// reports are a few hundred rows at most.
		const a = document.createElement('a');
		a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
		a.download = `${r.title.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'report'}.csv`;
		a.click();
	}

	async function scrollDown() {
		await tick();
		if (scroller) scroller.scrollTop = scroller.scrollHeight;
	}

	async function toggle() {
		open = !open;
		if (open) {
			loadInbox();
			await tick();
			if (tab === 'chat') input?.focus();
		}
	}

	function onKey(e: KeyboardEvent) {
		// Enter sends, Shift+Enter is a newline — a schema gets pasted in here and
		// needs its line breaks.
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && open && (open = false)} />

{#if open}
	<div class="panel" role="dialog" aria-modal="false" aria-label="Champ assistant">
		<div class="phead">
			<span class="pmark" aria-hidden="true">✨</span>
			<div style="flex:1;min-width:0">
				<div class="ptitle">Champ</div>
				<div class="psub">Answers from your portal data · scoped to your access</div>
			</div>
			<div class="tabs" role="tablist">
				<button type="button" role="tab" aria-selected={tab === 'chat'} class:on={tab === 'chat'} onclick={() => (tab = 'chat')}>Chat</button>
				<button type="button" role="tab" aria-selected={tab === 'requests'} class:on={tab === 'requests'} onclick={openRequests}>
					Requests{#if badge}<span class="tbadge">{badge}</span>{/if}
				</button>
			</div>
			{#if tab === 'chat' && turns.length}
				<button class="plink" type="button" onclick={() => (turns = [])}>Clear</button>
			{/if}
			<button class="px" type="button" onclick={() => (open = false)} aria-label="Close">
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
			</button>
		</div>

		{#if tab === 'requests'}
			<div class="pbody">
				{#if inboxError}<p class="err">{inboxError}</p>{/if}
				{#if !inbox}
					<p class="empty">Loading…</p>
				{:else}
					<div class="sec">
						<span>Waiting on you</span>
						<button class="plink" type="button" onclick={loadInbox}>Refresh</button>
					</div>
					{#each inbox.waiting as r (r.id)}
						<RequestCard {r} onchange={cardChanged} />
					{:else}
						<p class="empty">
							{isSuperAdmin
								? 'Nothing waiting. Access requests from the team and tasks given to you land here.'
								: 'Nothing waiting. Work a super admin gives you lands here.'}
						</p>
					{/each}

					{#if inbox.recent.length}
						<div class="sec"><span>Settled recently</span></div>
						{#each inbox.recent as r (r.id)}
							<RequestCard {r} onchange={cardChanged} />
						{/each}
					{/if}

					<div class="sec"><span>Raised by you</span></div>
					{#each inbox.mine as r (r.id)}
						<RequestCard {r} onchange={cardChanged} />
					{:else}
						<p class="empty">
							{isSuperAdmin
								? 'Nothing yet. Ask in the chat, e.g. “ask Riya to send the offer letter to Priya”.'
								: 'Nothing yet. Ask in the chat, e.g. “I need access to email offer letters”.'}
						</p>
					{/each}
				{/if}
			</div>
		{:else}
		<div class="pbody" bind:this={scroller}>
			{#if !turns.length}
				<p class="empty">
					Ask about candidates, offers, exits or the audit trail. Paste a set of column headings
					and I will build the report from your data.
				</p>
				<div class="suggest">
					{#each SUGGESTIONS as s (s)}
						<button type="button" onclick={() => send(s)}>{s}</button>
					{/each}
				</div>
			{/if}

			{#each turns as t, i (i)}
				<div class="turn {t.role}">
					<div class="bubble">
						{#each blocks(t.content) as b, bi (bi)}
							{#if b.kind === 'p'}
								<p>{#each b.parts as x, xi (xi)}{#if x.t === 'b'}<b>{x.v}</b>{:else if x.t === 'code'}<code>{x.v}</code>{:else}{x.v}{/if}{/each}</p>
							{:else}
								<div class="li">
									<span class="mk">{b.kind === 'oli' ? b.marker : '·'}</span>
									<span>{#each b.parts as x, xi (xi)}{#if x.t === 'b'}<b>{x.v}</b>{:else if x.t === 'code'}<code>{x.v}</code>{:else}{x.v}{/if}{/each}</span>
								</div>
							{/if}
						{/each}
					</div>

					{#if t.report}
						<div class="report">
							<div class="rhead">
								<span class="rtitle">{t.report.title}</span>
								<span class="rcount">
									{t.report.rows.length} row{t.report.rows.length === 1 ? '' : 's'}{t.report.truncated ? ' (capped)' : ''}
								</span>
								<button type="button" class="plink" onclick={() => downloadCsv(t.report!)}>Download CSV</button>
							</div>
							<div class="rscroll">
								<table>
									<thead>
										<tr>{#each t.report.columns as c (c.key)}<th>{c.label}</th>{/each}</tr>
									</thead>
									<tbody>
										{#each t.report.rows as row, ri (ri)}
											<tr>{#each row as cell, ci (ci)}<td>{cell || '—'}</td>{/each}</tr>
										{/each}
									</tbody>
								</table>
							</div>
						</div>
					{/if}

					{#each t.proposals ?? [] as p (propKey(p))}
						{@const noop = p.from === p.to}
						<div class="proposal" class:noop>
							<div class="prop-h">{noop ? 'No change needed' : 'Proposed access change'}</div>
							<div class="prop-b">
								<b>{p.email}</b> ({p.role})<br />
								{p.capabilityLabel}
								<code>{p.capability}</code><br />
								{#if noop}
									<span class="from">already {p.to}</span>
								{:else}
									<span class="from">{p.from}</span> → <b>{p.to}</b>
								{/if}
								{#if p.reason}<div class="why">{p.reason}</div>{/if}
							</div>
							{#if noop}
								<!-- Applying would write a grant identical to what the preset
								     already gives, which is noise in the audit log for no gain. -->
								<p class="prop-note">They already have this. Nothing to apply.</p>
							{:else}
								{#if !p.implemented}
									<p class="prop-note">
										This capability has no control behind it in the app yet, so applying it records
										the intent but changes nothing today.
									</p>
								{:else}
									<p class="prop-note">
										Access is still decided by role, so this is recorded against the login and takes
										effect when the capability model is enforced.
									</p>
								{/if}
								{#if t.applied[propKey(p)]}
									<p class="prop-ok">Applied ✓ — set to {t.applied[propKey(p)]} and written to the audit log.</p>
								{:else if isSuperAdmin}
									<button type="button" class="prop-btn" onclick={() => applyProposal(t, p)}>Apply this change</button>
								{:else}
									<p class="prop-note">Only a super admin can apply this.</p>
								{/if}
							{/if}
							{#if t.applyErrors[propKey(p)]}<p class="prop-err">{t.applyErrors[propKey(p)]}</p>{/if}
						</div>
					{/each}

					{#each t.drafts ?? [] as d, di (di)}
						{#if t.sent?.[di]}
							<RequestCard r={t.sent[di]} onchange={cardChanged} />
						{:else}
							<div class="draft {d.kind}">
								<div class="prop-h">{d.kind === 'access' ? 'Access request — not sent yet' : 'Task — not assigned yet'}</div>
								<div class="prop-b">
									{#if d.kind === 'access'}
										{d.capabilityLabel} <code>{d.capability}</code><br />
										<span class="from">{d.from}</span> → <b>{d.to}</b>
									{:else}
										For <b>{d.toName || d.toEmail}</b>{#if d.toName}{' '}<span class="from">({d.toEmail})</span>{/if}
										<div class="dtitle">{d.title}</div>
										{#if d.candidateName}<div class="from">About {d.candidateName}</div>{/if}
										{#if d.dueAt}<div class="from">Due {dueDay(d.dueAt)}</div>{/if}
									{/if}
									{#if d.note}<div class="why">{d.note}</div>{/if}
								</div>
								<p class="prop-note">
									{d.kind === 'access'
										? 'Goes to the super admins. You will see here when one of them decides it.'
										: 'Shows up in their Champ panel with a badge until they mark it done.'}
								</p>
								<button type="button" class="prop-btn" onclick={() => sendDraft(t, di, d)}>
									{d.kind === 'access' ? 'Send request' : 'Assign task'}
								</button>
								{#if t.sendErrors?.[di]}<p class="prop-err">{t.sendErrors[di]}</p>{/if}
							</div>
						{/if}
					{/each}

					{#each t.requests ?? [] as r (r.id)}
						<RequestCard {r} onchange={cardChanged} />
					{/each}
				</div>
			{/each}

			{#if busy}<div class="turn assistant"><div class="bubble thinking">Looking it up…</div></div>{/if}
			{#if error}<p class="err">{error}</p>{/if}
		</div>
		{/if}

		{#if tab === 'chat'}
		<div class="pfoot">
			<textarea
				bind:this={input}
				bind:value={question}
				onkeydown={onKey}
				rows="2"
				placeholder="Ask about your data, or paste report headings…"
				disabled={busy}
			></textarea>
			<button class="send" type="button" onclick={() => send()} disabled={busy || !question.trim()} aria-label="Send">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12h15M13 6l6 6-6 6" /></svg>
			</button>
		</div>
		{/if}
	</div>
{/if}

<button class="launcher" class:on={open} type="button" onclick={toggle} aria-label={open ? 'Close Champ' : 'Ask Champ'} title="Ask Champ">
	<span aria-hidden="true">{open ? '×' : '✨'}</span>
	{#if badge && !open}<span class="lbadge" aria-label="{badge} waiting">{badge > 9 ? '9+' : badge}</span>{/if}
</button>

<style>
	.launcher {
		position: fixed;
		right: 22px;
		bottom: 22px;
		z-index: 400;
		width: 52px;
		height: 52px;
		border-radius: 50%;
		border: 1px solid var(--ae-line-strong);
		background: var(--ae-card-bg), rgba(13, 16, 26, 0.96);
		box-shadow: 0 14px 36px -12px rgba(0, 0, 0, 0.6);
		backdrop-filter: blur(14px);
		font-size: 22px;
		line-height: 1;
		cursor: pointer;
		transition: transform 0.15s ease, box-shadow 0.15s ease;
	}
	.launcher:hover {
		transform: translateY(-2px);
		box-shadow: 0 18px 44px -12px rgba(0, 0, 0, 0.7);
	}
	.lbadge {
		position: absolute;
		top: -3px;
		right: -3px;
		min-width: 19px;
		height: 19px;
		padding: 0 5px;
		box-sizing: border-box;
		border-radius: 999px;
		background: var(--ae-ember);
		color: #fff;
		font-family: var(--ae-font-mono);
		font-size: 10.5px;
		font-weight: 600;
		line-height: 19px;
		text-align: center;
	}
	.launcher.on {
		font-size: 26px;
		color: var(--ae-muted);
	}

	.panel {
		position: fixed;
		right: 22px;
		bottom: 86px;
		z-index: 400;
		width: min(560px, calc(100vw - 44px));
		height: min(660px, calc(100vh - 130px));
		display: flex;
		flex-direction: column;
		border: 1px solid var(--ae-line-strong);
		border-radius: 16px;
		background: var(--ae-card-bg), var(--ae-modal-base, rgba(13, 16, 26, 0.97));
		box-shadow: 0 28px 70px -20px rgba(0, 0, 0, 0.7);
		backdrop-filter: blur(18px) saturate(160%);
		overflow: hidden;
	}
	:global(.aegis[data-theme='light']) .panel {
		--ae-modal-base: rgba(252, 253, 255, 0.98);
	}
	.phead {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 14px;
		border-bottom: 1px solid var(--ae-line);
	}
	.pmark { font-size: 17px; }
	.ptitle { font-size: 14px; font-weight: 600; }
	.psub { font-size: 10.5px; color: var(--ae-muted); margin-top: 1px; }
	.px, .plink {
		background: none;
		border: 0;
		color: var(--ae-muted);
		cursor: pointer;
		font: inherit;
		font-size: 11px;
	}
	.plink { text-decoration: underline; text-underline-offset: 2px; }
	.px:hover, .plink:hover { color: var(--ae-text); }

	.tabs { display: flex; gap: 2px; padding: 2px; border: 1px solid var(--ae-line); border-radius: 8px; }
	.tabs button {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 4px 9px;
		border: 0;
		border-radius: 6px;
		background: none;
		color: var(--ae-muted);
		font: inherit;
		font-size: 11.5px;
		cursor: pointer;
	}
	.tabs button.on { background: var(--ae-line); color: var(--ae-text); }
	.tbadge {
		min-width: 16px;
		padding: 0 4px;
		box-sizing: border-box;
		border-radius: 999px;
		background: var(--ae-ember);
		color: #fff;
		font-family: var(--ae-font-mono);
		font-size: 9.5px;
		line-height: 16px;
		text-align: center;
	}
	.sec {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		font-family: var(--ae-font-mono);
		font-size: 9.5px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--ae-muted);
		margin-top: 4px;
	}
	.draft { border: 1px dashed var(--ae-amber); border-radius: 10px; padding: 10px 12px; }
	.draft.task { border-color: var(--ae-azure); }
	.draft.task .prop-h { color: var(--ae-azure); }
	.dtitle { margin-top: 3px; font-weight: 600; }
	.pbody { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
	.empty { margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--ae-muted); }
	.suggest { display: flex; flex-direction: column; gap: 6px; }
	.suggest button {
		text-align: left;
		padding: 8px 10px;
		border: 1px solid var(--ae-line);
		border-radius: 9px;
		background: none;
		color: var(--ae-text-2);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	.suggest button:hover { border-color: var(--ae-line-strong); color: var(--ae-text); }

	.turn { display: flex; flex-direction: column; gap: 8px; }
	.turn.user { align-items: flex-end; }
	.bubble {
		max-width: 88%;
		padding: 9px 12px;
		border-radius: 12px;
		font-size: 12.5px;
		line-height: 1.55;
		overflow-wrap: anywhere;
	}
	/* The user's own text is still shown exactly as typed — a pasted schema
	   keeps its line breaks. Only the assistant's prose goes through the parser. */
	.turn.user .bubble { white-space: pre-wrap; }
	.bubble p { margin: 0 0 6px; }
	.bubble p:last-child { margin-bottom: 0; }
	.bubble .li { display: flex; gap: 7px; margin: 0 0 3px; }
	.bubble .li:last-child { margin-bottom: 0; }
	.bubble .mk { flex: none; color: var(--ae-muted); font-variant-numeric: tabular-nums; }
	.bubble code {
		font-family: var(--ae-font-mono);
		font-size: 11px;
		padding: 1px 4px;
		border-radius: 4px;
		background: rgba(127, 127, 127, 0.18);
	}
	.proposal.noop { border-color: var(--ae-line-strong); background: transparent; opacity: 0.8; }
	.proposal.noop .prop-h { color: var(--ae-muted); }
	.turn.user .bubble { background: rgba(255, 125, 85, 0.16); border: 1px solid rgba(255, 125, 85, 0.3); }
	.turn.assistant .bubble { background: var(--ae-line); color: var(--ae-text-2); }
	.thinking { color: var(--ae-muted); font-style: italic; }
	.err { font-size: 12px; color: var(--ae-crimson); margin: 0; }

	.report { border: 1px solid var(--ae-line-strong); border-radius: 10px; overflow: hidden; }
	.rhead { display: flex; align-items: center; gap: 9px; padding: 8px 10px; border-bottom: 1px solid var(--ae-line); }
	.rtitle { flex: 1; font-size: 12px; font-weight: 600; }
	.rcount { font-family: var(--ae-font-mono); font-size: 10px; color: var(--ae-muted); }
	.rscroll { max-height: 280px; overflow: auto; }
	table { border-collapse: collapse; width: 100%; font-size: 11.5px; }
	th, td { text-align: left; padding: 6px 9px; border-bottom: 1px solid var(--ae-line); white-space: nowrap; }
	th { position: sticky; top: 0; background: var(--ae-card-bg), rgba(13, 16, 26, 0.98); font-weight: 600; font-size: 10.5px; }

	.proposal { border: 1px solid var(--ae-amber); border-radius: 10px; padding: 10px 12px; background: rgba(242, 177, 92, 0.08); }
	.prop-h { font-family: var(--ae-font-mono); font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ae-amber); margin-bottom: 7px; }
	.prop-b { font-size: 12px; line-height: 1.6; }
	.prop-b code { font-family: var(--ae-font-mono); font-size: 10.5px; color: var(--ae-muted); }
	.from { color: var(--ae-muted); }
	.why { margin-top: 5px; font-size: 11.5px; color: var(--ae-muted); }
	.prop-note { margin: 8px 0 0; font-size: 11px; line-height: 1.5; color: var(--ae-muted); }
	.prop-ok { margin: 8px 0 0; font-size: 11.5px; color: var(--ae-verdant); }
	.prop-err { margin: 6px 0 0; font-size: 11.5px; color: var(--ae-crimson); }
	.prop-btn {
		margin-top: 9px;
		padding: 6px 12px;
		border-radius: 8px;
		border: 1px solid var(--ae-amber);
		background: rgba(242, 177, 92, 0.16);
		color: var(--ae-text);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}

	.pfoot { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--ae-line); align-items: flex-end; }
	.pfoot textarea {
		flex: 1;
		resize: none;
		font: inherit;
		font-size: 12.5px;
		line-height: 1.5;
		padding: 8px 10px;
		border: 1px solid var(--ae-line-strong);
		border-radius: 9px;
		background: transparent;
		color: var(--ae-text-2);
	}
	.send {
		flex: none;
		width: 34px;
		height: 34px;
		border-radius: 9px;
		border: 1px solid var(--ae-line-strong);
		background: rgba(255, 125, 85, 0.16);
		color: var(--ae-text);
		cursor: pointer;
	}
	.send:disabled { opacity: 0.4; cursor: not-allowed; }

	@media (max-width: 620px) {
		.panel { right: 10px; left: 10px; width: auto; bottom: 80px; height: calc(100vh - 110px); }
		.launcher { right: 14px; bottom: 14px; }
	}
</style>
