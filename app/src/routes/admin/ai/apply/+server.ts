// Applying an access proposal.
//
// Deliberately a separate endpoint from the chat turn, with its own
// authorisation, taking its parameters from the request rather than from
// anything the model said. The model's proposal is a suggestion rendered on
// screen; this is the only thing that writes, and a human has to press it.
//
// That separation is the whole defence. Candidate-supplied text reaches the
// model, and no model reliably distinguishes data from instruction — so the
// model is never given a way to act. The worst a poisoned record can achieve
// is a card appearing that a super admin has to read and approve.
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { applyGrant, RequestError } from '$lib/server/requests';
import { CAPS, LEVELS, type Level } from '$lib/shared/access';

export const config = { runtime: 'nodejs24.x' };

export const POST: RequestHandler = async ({ request, locals, getClientAddress }) => {
	if (!locals.admin) error(401, 'Not authenticated');
	// Changing anyone's access is a super admin's call, the same rule the access
	// studio enforces. Re-checked here rather than inherited from whoever was
	// allowed to see the tool.
	if (locals.admin.role !== 'super_admin')
		error(403, 'Only a super admin can change access.');

	const body = (await request.json().catch(() => null)) as {
		email?: string;
		capability?: string;
		level?: Level;
	} | null;

	const email = String(body?.email ?? '').trim().toLowerCase();
	const capability = String(body?.capability ?? '');
	const level = String(body?.level ?? '') as Level;

	if (!CAPS[capability]) error(400, 'Unknown capability.');
	if (!LEVELS.includes(level)) error(400, 'Unknown level.');

	let applied;
	try {
		applied = await applyGrant({
			email,
			capability,
			level,
			actor: locals.admin.email,
			via: 'proposed by the assistant, applied by hand',
			ip: getClientAddress()
		});
	} catch (e) {
		if (e instanceof RequestError) error(e.status, e.message);
		throw e;
	}

	return json({
		applied: true,
		...applied,
		capabilityLabel: CAPS[capability].label,
		// Said plainly rather than left for someone to discover: the app still
		// decides access from `role`, so this is recorded intent until the
		// guards read from the capability model.
		enforced: false
	});
};
