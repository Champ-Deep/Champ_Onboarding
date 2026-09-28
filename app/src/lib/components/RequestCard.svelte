<script lang="ts">
	// One access request or task, with whatever buttons this viewer may use on it.
	//
	// The buttons come from `r.can`, which the server worked out for this viewer,
	// and pressing one posts to the request's own endpoint — which checks again.
	// So the card is the same whether it arrived in a chat reply or in the
	// Requests tab, and neither path can offer an action the server would allow
	// but the person should not have.
	import type { RequestAction, RequestView } from '$lib/shared/requests';

	let { r, onchange }: { r: RequestView; onchange: (next: RequestView) => void } = $props();

	let busy = $state(false);
	let err: string | null = $state(null);
	/** Reject and decline ask for a reason inline rather than in a browser
	 *  prompt, because the reason is what the other person reads. */
	let asking: 'reject' | 'decline' | null = $state(null);
	let reason = $state('');

	const STATUS: Record<RequestView['status'], string> = {
		pending: 'Waiting',
		approved: 'Approved',
		rejected: 'Rejected',
		done: 'Done',
		declined: 'Declined',
		cancelled: 'Withdrawn'
	};
	const BUTTON: Record<RequestAction, string> = {
		approve: 'Approve',
		reject: 'Reject',
		done: 'Mark done',
		decline: 'Can’t do this',
		cancel: 'Withdraw'
	};

	const who = (name: string | null, email: string | null) => name || email || 'someone';
	const when = (iso: string | null) =>
		iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
	const day = (iso: string | null) =>
		iso ? new Date(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
	const overdue = $derived(r.status === 'pending' && !!r.dueAt && new Date(r.dueAt).getTime() < Date.now());

	async function act(action: RequestAction, note?: string) {
		if (action === 'approve' && !confirm(`Give ${who(r.fromName, r.fromEmail)} "${r.capabilityLabel}" at ${r.level}?`)) return;
		if (action === 'cancel' && !confirm(r.kind === 'task' ? 'Withdraw this task?' : 'Withdraw this request?')) return;
		busy = true;
		err = null;
		try {
			const res = await fetch(`/admin/ai/requests/${r.id}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action, note })
			});
			const body = await res.json().catch(() => null);
			if (!res.ok) {
				err = (body as { message?: string } | null)?.message ?? `That did not go through (${res.status}).`;
				return;
			}
			asking = null;
			reason = '';
			onchange(body as RequestView);
		} catch {
			err = 'Could not reach the portal — check your connection.';
		} finally {
			busy = false;
		}
	}

	function press(action: RequestAction) {
		if (action === 'reject' || action === 'decline') {
			asking = action;
			return;
		}
		act(action);
	}
</script>

<div class="rq {r.kind}" class:settled={r.status !== 'pending'}>
	<div class="rq-h">
		<span>{r.kind === 'access' ? 'Access request' : 'Task'}</span>
		<span class="pill {r.status}">{STATUS[r.status]}</span>
	</div>

	<div class="rq-b">
		{#if r.kind === 'access'}
			<b>{who(r.fromName, r.fromEmail)}</b>
			{#if r.fromName}<span class="dim">({r.fromEmail})</span>{/if}
			asks for<br />
			{r.capabilityLabel} <code>{r.capability}</code><br />
			<span class="dim">{r.levelAtRequest}</span> → <b>{r.level}</b>
		{:else}
			<span class="dim">{who(r.fromName, r.fromEmail)}{' → '}</span><b>{who(r.toName, r.toEmail)}</b>
			<div class="title">{r.title}</div>
			{#if r.candidateId}
				<a class="cand" href="/admin/candidates/{r.candidateId}">Open {r.candidateName ?? 'the candidate'}’s record →</a>
			{/if}
			{#if r.dueAt}<div class="due" class:overdue>Due {day(r.dueAt)}{overdue ? ' — overdue' : ''}</div>{/if}
		{/if}
		{#if r.note}<div class="why">“{r.note}”</div>{/if}
		<div class="meta">Raised {when(r.createdAt)}</div>
		{#if r.status !== 'pending' && r.decidedBy}
			<div class="outcome">
				{STATUS[r.status]} by {r.decidedBy}, {when(r.decidedAt)}{#if r.decisionNote}: “{r.decisionNote}”{/if}
			</div>
		{/if}
	</div>

	{#if r.kind === 'access' && r.can.includes('approve')}
		<p class="rq-note">
			{#if !r.implemented}
				This capability has no control behind it in the app yet, so approving records the intent but
				changes nothing today.
			{:else}
				Approving records this against their login. Access is still decided by role, so it takes effect
				when the capability model is enforced.
			{/if}
		</p>
	{/if}

	{#if asking}
		<textarea
			bind:value={reason}
			rows="2"
			maxlength="500"
			placeholder={asking === 'reject' ? 'Why not? They will see this.' : 'What is stopping it? They will see this.'}
		></textarea>
		<div class="rq-btns">
			<button type="button" class="rq-btn warn" disabled={busy} onclick={() => act(asking!, reason)}>
				{asking === 'reject' ? 'Reject request' : 'Send back'}
			</button>
			<button type="button" class="rq-btn ghost" disabled={busy} onclick={() => (asking = null)}>Back</button>
		</div>
	{:else if r.can.length}
		<div class="rq-btns">
			{#each r.can as a (a)}
				<button
					type="button"
					class="rq-btn"
					class:go={a === 'approve' || a === 'done'}
					class:ghost={a === 'cancel'}
					class:warn={a === 'reject' || a === 'decline'}
					disabled={busy}
					onclick={() => press(a)}>{BUTTON[a]}</button
				>
			{/each}
		</div>
	{/if}
	{#if err}<p class="rq-err">{err}</p>{/if}
</div>

<style>
	.rq { border: 1px solid var(--ae-azure, #7ba7f0); border-radius: 10px; padding: 10px 12px; background: rgba(123, 167, 240, 0.07); }
	.rq.access { border-color: var(--ae-amber); background: rgba(242, 177, 92, 0.08); }
	.rq.settled { border-color: var(--ae-line-strong); background: transparent; }
	.rq-h {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-family: var(--ae-font-mono);
		font-size: 9.5px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--ae-muted);
		margin-bottom: 7px;
	}
	.pill { padding: 1px 7px; border-radius: 999px; border: 1px solid var(--ae-line-strong); letter-spacing: 0.06em; }
	.pill.pending { color: var(--ae-amber); border-color: var(--ae-amber); }
	.pill.approved, .pill.done { color: var(--ae-verdant); border-color: var(--ae-verdant); }
	.pill.rejected, .pill.declined { color: var(--ae-crimson); border-color: var(--ae-crimson); }
	.rq-b { font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
	.rq-b code { font-family: var(--ae-font-mono); font-size: 10.5px; color: var(--ae-muted); }
	.dim { color: var(--ae-muted); }
	.title { margin-top: 3px; font-size: 12.5px; font-weight: 600; color: var(--ae-text); }
	.cand { display: inline-block; margin-top: 3px; font-size: 11.5px; color: var(--ae-text-2); }
	.due { margin-top: 3px; font-size: 11px; color: var(--ae-muted); }
	.due.overdue { color: var(--ae-crimson); }
	.why { margin-top: 5px; font-size: 11.5px; color: var(--ae-muted); }
	.meta { margin-top: 5px; font-size: 10.5px; color: var(--ae-muted); }
	.outcome { margin-top: 4px; font-size: 11.5px; color: var(--ae-text-2); }
	.rq-note { margin: 8px 0 0; font-size: 11px; line-height: 1.5; color: var(--ae-muted); }
	.rq-err { margin: 6px 0 0; font-size: 11.5px; color: var(--ae-crimson); }
	.rq-btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
	textarea {
		width: 100%;
		box-sizing: border-box;
		margin-top: 9px;
		resize: vertical;
		font: inherit;
		font-size: 12px;
		padding: 6px 8px;
		border: 1px solid var(--ae-line-strong);
		border-radius: 8px;
		background: transparent;
		color: var(--ae-text-2);
	}
	.rq-btn {
		padding: 6px 12px;
		border-radius: 8px;
		border: 1px solid var(--ae-line-strong);
		background: none;
		color: var(--ae-text);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	.rq-btn:disabled { opacity: 0.5; cursor: wait; }
	.rq-btn.go { border-color: var(--ae-verdant); background: rgba(62, 207, 154, 0.14); }
	.rq-btn.warn { border-color: var(--ae-crimson); color: var(--ae-crimson); }
	.rq-btn.ghost { color: var(--ae-muted); }
</style>
