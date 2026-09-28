// Team requests: access asked for by a teammate, and work handed to a teammate
// by a super admin. Both are raised and settled from the assistant panel.
//
// Every write here takes its parameters from the request a person sent by
// pressing a button, never from the model's output — the assistant drafts a
// card, and the card's button posts what the card shows. Authorisation is
// decided here per action and per viewer, not by whoever was shown the card.
import { Types } from 'mongoose';
import { Admin, Candidate, TeamRequest } from '$lib/server/db/schema';
import { audit } from '$lib/server/audit';
import { CAPS, PRESETS, capLevels, effectiveLevel, levelIndex, type Level } from '$lib/shared/access';
import type { Inbox, RequestAction, RequestView } from '$lib/shared/requests';

export interface Viewer {
	email: string;
	role: string;
}

/** A failure the person should read, with the status to send it under. */
export class RequestError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}

const MAX_TEXT = 500;
/** Settled items stay in "yours" for this long, so a requester sees the outcome
 *  without the list growing forever. */
const SETTLED_WINDOW_DAYS = 14;

const isSuper = (v: Viewer) => v.role === 'super_admin';
const clean = (s: unknown, max = MAX_TEXT) => {
	const t = String(s ?? '').trim().slice(0, max);
	return t || null;
};

/** The level a login has today. Read from the role, not from recorded grants,
 *  for the same reason callerFrom does: the role is what the guards enforce, so
 *  it is the honest answer to "what can they do right now". */
export function currentLevel(role: string, cap: string): Level {
	return effectiveLevel(
		{
			preset: PRESETS[role] ? role : 'hr_admin',
			grants: {},
			checkers: {},
			population: 'all',
			entities: 'all',
			tracks: 'all',
			status: 'active'
		},
		cap
	);
}

/** Write one capability override onto a login, exactly as the access studio
 *  writes it — a list rather than a map because capability keys carry dots,
 *  which Mongo treats as paths in a field name. Shared by the assistant's
 *  Apply button and by approving an access request. */
export async function applyGrant(opts: {
	email: string;
	capability: string;
	level: Level;
	actor: string;
	via: string;
	ip?: string;
}) {
	const target = await Admin.findOne({ email: opts.email.trim().toLowerCase() });
	if (!target) throw new RequestError(404, 'No login with that email.');
	const before = currentLevel(target.role, opts.capability);
	const existing = (Array.isArray(target.grants) ? target.grants : []) as { cap?: string; level?: string }[];
	const grants = [...existing.filter((g) => g.cap !== opts.capability), { cap: opts.capability, level: opts.level }];
	await Admin.findByIdAndUpdate(target._id, { $set: { grants } });
	await audit({
		actor: opts.actor,
		action: 'access_updated',
		field: `${target.email} · ${opts.capability}`,
		oldValue: before,
		newValue: `${opts.level} (${opts.via})`,
		ip: opts.ip
	});
	return { email: target.email as string, capability: opts.capability, from: before, to: opts.level };
}

// ── reading ──────────────────────────────────────────────────────────────────

type Doc = Record<string, any>;

function allowed(doc: Doc, v: Viewer): RequestAction[] {
	if (doc.status !== 'pending') return [];
	const out: RequestAction[] = [];
	if (doc.kind === 'access') {
		// Nobody decides their own request, including a super admin who raised
		// one before being promoted.
		if (isSuper(v) && v.email !== doc.fromEmail) out.push('approve', 'reject');
		if (v.email === doc.fromEmail) out.push('cancel');
	} else {
		if (v.email === doc.toEmail) out.push('done', 'decline');
		if (v.email === doc.fromEmail) out.push('cancel');
	}
	return out;
}

/** Names are resolved in two queries for the whole list rather than per card. */
async function toViews(docs: Doc[], v: Viewer): Promise<RequestView[]> {
	const emails = [...new Set(docs.flatMap((d) => [d.fromEmail, d.toEmail]).filter(Boolean))];
	const candIds = [...new Set(docs.map((d) => d.candidateId).filter(Boolean).map(String))];
	const [admins, cands] = await Promise.all([
		emails.length ? Admin.find({ email: { $in: emails } }).select('email name').lean() : [],
		candIds.length ? Candidate.find({ _id: { $in: candIds } }).select('fullName email').lean() : []
	]);
	const nameOf = new Map((admins as Doc[]).map((a) => [a.email, (a.name as string) ?? null]));
	const candName = new Map((cands as Doc[]).map((c) => [String(c._id), (c.fullName ?? c.email) as string]));
	const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : null);

	return docs.map((d) => ({
		id: String(d._id),
		kind: d.kind,
		status: d.status,
		fromEmail: d.fromEmail,
		fromName: nameOf.get(d.fromEmail) ?? null,
		toEmail: d.toEmail ?? null,
		toName: d.toEmail ? (nameOf.get(d.toEmail) ?? null) : null,
		capability: d.capability ?? null,
		capabilityLabel: d.capability ? (CAPS[d.capability]?.label ?? d.capability) : null,
		level: d.level ?? null,
		levelAtRequest: d.levelAtRequest ?? null,
		implemented: d.capability ? CAPS[d.capability]?.wired !== false : true,
		title: d.title ?? null,
		candidateId: d.candidateId ? String(d.candidateId) : null,
		candidateName: d.candidateId ? (candName.get(String(d.candidateId)) ?? null) : null,
		dueAt: iso(d.dueAt),
		note: d.note ?? null,
		createdAt: iso(d.createdAt) ?? new Date().toISOString(),
		decidedBy: d.decidedBy ?? null,
		decidedAt: iso(d.decidedAt),
		decisionNote: d.decisionNote ?? null,
		can: allowed(d, v)
	}));
}

export async function inboxFor(v: Viewer): Promise<Inbox> {
	const waitingWhere = isSuper(v)
		? {
				status: 'pending',
				$or: [
					{ kind: 'access', fromEmail: { $ne: v.email } },
					{ kind: 'task', toEmail: v.email }
				]
			}
		: { status: 'pending', kind: 'task', toEmail: v.email };
	const since = new Date(Date.now() - SETTLED_WINDOW_DAYS * 86400000);

	const [waiting, mine, recent, unseen] = await Promise.all([
		TeamRequest.find(waitingWhere).sort({ createdAt: 1 }).limit(100).lean(),
		TeamRequest.find({
			fromEmail: v.email,
			$or: [{ status: 'pending' }, { updatedAt: { $gte: since } }]
		})
			.sort({ updatedAt: -1 })
			.limit(40)
			.lean(),
		// Settled things they were on the receiving end of: tasks given to them,
		// and requests they decided — so a super admin who presses Approve sees
		// the card turn green rather than vanish from "waiting".
		TeamRequest.find({
			status: { $ne: 'pending' },
			updatedAt: { $gte: since },
			fromEmail: { $ne: v.email },
			$or: [{ kind: 'task', toEmail: v.email }, { decidedBy: v.email }]
		})
			.sort({ updatedAt: -1 })
			.limit(20)
			.lean(),
		TeamRequest.find({ notify: v.email }).select('_id').lean()
	]);

	// Something both waiting on them and flagged for them is one thing, not two.
	const ids = new Set([...(waiting as Doc[]), ...(unseen as Doc[])].map((d) => String(d._id)));
	const [w, m, r] = await Promise.all([
		toViews(waiting as Doc[], v),
		toViews(mine as Doc[], v),
		toViews(recent as Doc[], v)
	]);
	return { waiting: w, mine: m, recent: r, badge: ids.size };
}

export async function viewOf(id: string, v: Viewer): Promise<RequestView | null> {
	if (!Types.ObjectId.isValid(id)) return null;
	const doc = await TeamRequest.findById(id).lean();
	return doc ? (await toViews([doc as Doc], v))[0] : null;
}

/** Clear the badge for outcomes this person has now seen. */
export async function markSeen(v: Viewer) {
	await TeamRequest.updateMany({ notify: v.email }, { $set: { notify: null } });
}

// ── raising ──────────────────────────────────────────────────────────────────

/** Checks shared by the assistant's draft and the Send button, so a card can
 *  never show a request the server would then refuse. */
export async function checkAccessRequest(v: Viewer, capability: string, level: string) {
	if (isSuper(v)) throw new RequestError(400, 'A super admin already has every capability — there is nothing to request.');
	const cap = CAPS[capability];
	if (!cap) throw new RequestError(400, `No capability called "${capability}".`);
	const lv = level as Level;
	if (!capLevels(cap.key).includes(lv) || lv === 'none')
		throw new RequestError(400, `"${cap.label}" can be requested at: ${capLevels(cap.key).filter((l) => l !== 'none').join(', ')}.`);
	const from = currentLevel(v.role, cap.key);
	if (levelIndex(from) >= levelIndex(lv))
		throw new RequestError(409, `You already have "${cap.label}" at ${from}.`);
	const open = await TeamRequest.findOne({ kind: 'access', status: 'pending', fromEmail: v.email, capability: cap.key })
		.select('_id')
		.lean();
	if (open) throw new RequestError(409, `You already have a request for "${cap.label}" waiting on a super admin.`);
	return { cap, level: lv, from };
}

export async function createAccessRequest(
	v: Viewer,
	body: { capability?: unknown; level?: unknown; note?: unknown },
	ip?: string
) {
	const { cap, level, from } = await checkAccessRequest(v, String(body.capability ?? ''), String(body.level ?? ''));
	const note = clean(body.note);
	const doc = await TeamRequest.create({
		kind: 'access',
		fromEmail: v.email,
		capability: cap.key,
		level,
		levelAtRequest: from,
		note
	});
	await audit({
		actor: v.email,
		action: 'access_requested',
		field: cap.key,
		oldValue: from,
		newValue: note ? `${level} — ${note}` : level,
		ip
	});
	return (await viewOf(String(doc._id), v))!;
}

export async function checkTask(v: Viewer, toEmail: string, candidateId: string | null) {
	if (!isSuper(v)) throw new RequestError(403, 'Only a super admin can assign work.');
	const email = toEmail.trim().toLowerCase();
	if (email === v.email) throw new RequestError(400, 'That is your own login — a task is for someone else.');
	const assignee = await Admin.findOne({ email }).select('email name status').lean();
	if (!assignee) throw new RequestError(404, `No login found for ${toEmail}.`);
	if ((assignee as Doc).status !== 'active') throw new RequestError(400, `${email} is disabled, so they would never see it.`);
	let candidate: Doc | null = null;
	if (candidateId) {
		if (!Types.ObjectId.isValid(candidateId)) throw new RequestError(400, 'That candidate does not exist.');
		candidate = (await Candidate.findById(candidateId).select('fullName email').lean()) as Doc | null;
		if (!candidate) throw new RequestError(404, 'That candidate does not exist.');
	}
	return { assignee: assignee as Doc, candidate };
}

export async function createTask(
	v: Viewer,
	body: { toEmail?: unknown; title?: unknown; candidateId?: unknown; dueAt?: unknown; note?: unknown },
	ip?: string
) {
	const title = clean(body.title);
	if (!title) throw new RequestError(400, 'Say what needs doing.');
	const candidateId = body.candidateId ? String(body.candidateId) : null;
	const { assignee, candidate } = await checkTask(v, String(body.toEmail ?? ''), candidateId);

	let dueAt: Date | null = null;
	if (body.dueAt) {
		dueAt = new Date(String(body.dueAt));
		if (isNaN(dueAt.getTime())) throw new RequestError(400, 'That due date is not a date.');
	}

	const doc = await TeamRequest.create({
		kind: 'task',
		fromEmail: v.email,
		toEmail: assignee.email,
		title,
		candidateId: candidate?._id ?? null,
		dueAt,
		note: clean(body.note),
		notify: assignee.email
	});
	await audit({
		candidateId: candidate ? String(candidate._id) : null,
		actor: v.email,
		action: 'task_assigned',
		field: assignee.email,
		newValue: title,
		ip
	});
	return (await viewOf(String(doc._id), v))!;
}

// ── settling ─────────────────────────────────────────────────────────────────

const OUTCOME: Record<RequestAction, RequestView['status']> = {
	approve: 'approved',
	reject: 'rejected',
	done: 'done',
	decline: 'declined',
	cancel: 'cancelled'
};

export async function actOn(v: Viewer, id: string, action: RequestAction, noteIn: unknown, ip?: string) {
	if (!OUTCOME[action]) throw new RequestError(400, 'Unknown action.');
	if (!Types.ObjectId.isValid(id)) throw new RequestError(404, 'No such request.');
	const doc = (await TeamRequest.findById(id).lean()) as Doc | null;
	if (!doc) throw new RequestError(404, 'No such request.');
	if (doc.status !== 'pending') throw new RequestError(409, `This was already ${doc.status}.`);
	if (!allowed(doc, v).includes(action)) throw new RequestError(403, 'You cannot do that to this request.');

	const note = clean(noteIn);
	// Whoever is on the other side of the request hears about the outcome. A
	// requester withdrawing their own access request tells nobody: it only ever
	// sat in a shared queue.
	// Otherwise it is whoever raised it: the requester on approve/reject, the
	// assigner on done/decline.
	const notify = action === 'cancel' ? (doc.kind === 'task' ? doc.toEmail : null) : doc.fromEmail;

	// Claimed atomically before anything is applied, so two super admins pressing
	// Approve at once cannot both act on it — the second finds it settled.
	const claimed = await TeamRequest.findOneAndUpdate(
		{ _id: doc._id, status: 'pending' },
		{ $set: { status: OUTCOME[action], decidedBy: v.email, decidedAt: new Date(), decisionNote: note, notify } },
		{ new: true }
	).lean();
	if (!claimed) throw new RequestError(409, 'Someone else settled this a moment ago.');

	if (action === 'approve') {
		try {
			// Re-read at approval rather than trusting what the card said when it
			// was raised: the login may have been deleted or disabled since.
			const target = (await Admin.findOne({ email: doc.fromEmail }).select('status').lean()) as Doc | null;
			if (!target) throw new RequestError(404, `${doc.fromEmail} no longer has a login.`);
			if (target.status !== 'active') throw new RequestError(400, `${doc.fromEmail} is disabled.`);
			await applyGrant({
				email: doc.fromEmail,
				capability: doc.capability,
				level: doc.level,
				actor: v.email,
				via: `requested by ${doc.fromEmail}, approved in the assistant`,
				ip
			});
		} catch (e) {
			// Put it back so it is not recorded as approved when nothing was written.
			await TeamRequest.updateOne(
				{ _id: doc._id },
				{ $set: { status: 'pending', decidedBy: null, decidedAt: null, decisionNote: null, notify: null } }
			);
			throw e;
		}
	}

	const ACTION_LOG: Record<string, string> = {
		'access:approve': 'access_request_approved',
		'access:reject': 'access_request_rejected',
		'access:cancel': 'access_request_cancelled',
		'task:done': 'task_done',
		'task:decline': 'task_declined',
		'task:cancel': 'task_cancelled'
	};
	await audit({
		candidateId: doc.candidateId ? String(doc.candidateId) : null,
		actor: v.email,
		action: ACTION_LOG[`${doc.kind}:${action}`],
		field: doc.kind === 'access' ? `${doc.fromEmail} · ${doc.capability}` : `${doc.toEmail} · ${doc.title}`.slice(0, 300),
		oldValue: 'pending',
		newValue: note ? `${OUTCOME[action]} — ${note}` : OUTCOME[action],
		ip
	});
	return (await viewOf(id, v))!;
}
