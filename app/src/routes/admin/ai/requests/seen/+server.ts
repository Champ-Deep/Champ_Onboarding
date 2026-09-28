// Opening the Requests tab clears the badge for outcomes the person has now
// seen. Things still waiting on them keep counting until they are settled.
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { markSeen } from '$lib/server/requests';

export const config = { runtime: 'nodejs24.x' };

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.admin) error(401, 'Not authenticated');
	await markSeen(locals.admin);
	return json({ ok: true });
};
