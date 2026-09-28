// Settling one team request: approve or reject access, mark a task done or
// decline it, or withdraw something you raised. Who may do which is decided in
// lib/server/requests.ts for this viewer, not by which buttons they were shown.
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { actOn, RequestError } from '$lib/server/requests';
import type { RequestAction } from '$lib/shared/requests';

export const config = { runtime: 'nodejs24.x' };

export const POST: RequestHandler = async ({ request, params, locals, getClientAddress }) => {
	if (!locals.admin) error(401, 'Not authenticated');
	const body = (await request.json().catch(() => null)) as { action?: string; note?: string } | null;
	try {
		return json(await actOn(locals.admin, params.id, String(body?.action ?? '') as RequestAction, body?.note, getClientAddress()));
	} catch (e) {
		if (e instanceof RequestError) error(e.status, e.message);
		throw e;
	}
};
