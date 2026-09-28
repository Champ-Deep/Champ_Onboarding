// Team requests from the assistant panel: GET is this person's inbox, POST
// raises a new one from a card the assistant drafted.
//
// The body is what the card showed, posted by a person pressing Send. It is
// validated from scratch here — nothing the model said is trusted on the way.
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createAccessRequest, createTask, inboxFor, RequestError } from '$lib/server/requests';

export const config = { runtime: 'nodejs24.x' };

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.admin) error(401, 'Not authenticated');
	return json(await inboxFor(locals.admin));
};

export const POST: RequestHandler = async ({ request, locals, getClientAddress }) => {
	if (!locals.admin) error(401, 'Not authenticated');
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	try {
		if (body?.kind === 'access') return json(await createAccessRequest(locals.admin, body, getClientAddress()));
		if (body?.kind === 'task') return json(await createTask(locals.admin, body, getClientAddress()));
	} catch (e) {
		if (e instanceof RequestError) error(e.status, e.message);
		throw e;
	}
	error(400, 'Unknown request kind.');
};
