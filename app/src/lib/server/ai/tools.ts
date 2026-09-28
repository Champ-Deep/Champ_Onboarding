// THE TOOL BOUNDARY — everything the assistant is allowed to see or propose.
//
// This file is the security perimeter for the whole feature, so the rules it
// keeps are worth stating plainly:
//
//  1. NOTHING HERE WRITES. The model cannot change a single record. The tools
//     that touch access or hand out work return a *draft* — a proposal, a
//     request, a task — which a human has to press a button on before anything
//     happens. That is what stops a prompt
//     injection from becoming a permission change: candidate-supplied text
//     reaches the model (names, addresses, reasons for leaving), a model cannot
//     reliably tell data from instruction, so the model is never given the
//     ability to act on either.
//
//  2. NO QUERY REACHES MONGO FROM THE MODEL. Every tool is a fixed query with
//     typed parameters. The model picks a tool and fills in blanks; it can
//     never express "find me anything", so there is no query injection and no
//     accidental collection scan.
//
//  3. PII IS ABSENT, NOT MASKED. Aadhaar, PAN, bank account, IFSC and salary
//     are not in any catalogue below. You cannot leak what was never sent, and
//     this data leaves the building for OpenRouter.
//
//  4. THE SERVER DOES THE ARITHMETIC. Counts and filters run in Mongo. The
//     model chooses which question to ask, never what the answer is.
//
//  5. EVERY TOOL IS GATED ON THE CALLER'S CAPABILITIES, resolved through the
//     same access model the studio authors. A tool the caller cannot use is
//     never offered to the model, so it cannot be talked into calling it.
import { Admin, AuditLog, Candidate, Company, Exit, OfferLetter } from '$lib/server/db/schema';
import { checkAccessRequest, checkTask, inboxFor, RequestError } from '$lib/server/requests';
import {
	CAPS,
	MODULES,
	PRESETS,
	effectiveLevel,
	levelIndex,
	type Grantee,
	type Level
} from '$lib/shared/access';
import { TRACKS } from '$lib/shared/matrix';

/** The caller, reduced to what the tools need: who they are and what they may
 *  see. Built once per request from the signed-in admin. */
export interface Caller {
	id: string;
	email: string;
	role: string;
	grantee: Grantee;
}

export function callerFrom(admin: { id: string; email: string; role: string }): Caller {
	return {
		id: admin.id,
		email: admin.email,
		role: admin.role,
		// Grants are not read here on purpose: the studio authors them but the
		// app does not enforce them yet, so the preset — which is the role, and
		// IS enforced everywhere else — is the honest source. When enforcement
		// lands this becomes a full read of the admin's grants.
		grantee: {
			preset: PRESETS[admin.role] ? admin.role : 'hr_admin',
			grants: {},
			checkers: {},
			population: 'all',
			entities: 'all',
			tracks: 'all',
			status: 'active'
		}
	};
}

export function can(caller: Caller, cap: string, min: Level = 'view'): boolean {
	return levelIndex(effectiveLevel(caller.grantee, cap)) >= levelIndex(min);
}

// ── the reportable field catalogue ───────────────────────────────────────────
// What a report may contain. Deliberately operational: no identity numbers, no
// bank details, no compensation. A report that needs those is a conversation
// about why, not a column someone adds in chat.
interface ReportField {
	key: string;
	label: string;
	/** Where it comes from. `candidate` reads the record; the rest are joined. */
	from: 'candidate' | 'company' | 'offer';
	path: string;
}

export const REPORT_FIELDS: ReportField[] = [
	{ key: 'name', label: 'Full name', from: 'candidate', path: 'fullName' },
	{ key: 'email', label: 'Email', from: 'candidate', path: 'email' },
	{ key: 'mobile', label: 'Mobile', from: 'candidate', path: 'mobile' },
	{ key: 'track', label: 'Hiring track', from: 'candidate', path: 'track' },
	{ key: 'status', label: 'Onboarding status', from: 'candidate', path: 'status' },
	{ key: 'entity', label: 'Entity / company', from: 'company', path: 'name' },
	{ key: 'employeeId', label: 'Employee code', from: 'candidate', path: 'employeeId' },
	{ key: 'department', label: 'Department', from: 'offer', path: 'department' },
	{ key: 'designation', label: 'Designation / job title', from: 'offer', path: 'jobTitle' },
	{ key: 'reportingManager', label: 'Reporting manager', from: 'offer', path: 'reportingManager' },
	{ key: 'officeLocation', label: 'Office location', from: 'offer', path: 'officeLocation' },
	{ key: 'joiningDate', label: 'Date of joining', from: 'offer', path: 'joiningDate' },
	{ key: 'offerStatus', label: 'Offer letter status', from: 'offer', path: 'status' },
	{ key: 'teamName', label: 'Team', from: 'candidate', path: 'teamName' },
	{ key: 'shiftTiming', label: 'Shift timing', from: 'candidate', path: 'shiftTiming' },
	{ key: 'workLocationMode', label: 'Work location mode', from: 'candidate', path: 'workLocationMode' },
	{ key: 'hiringDecision', label: 'Hiring decision', from: 'candidate', path: 'hiringDecision' },
	{ key: 'createdAt', label: 'Link created on', from: 'candidate', path: 'createdAt' },
	{ key: 'submittedAt', label: 'Submitted on', from: 'candidate', path: 'submittedAt' }
];
const REPORT_FIELD_BY_KEY = new Map(REPORT_FIELDS.map((f) => [f.key, f]));

const STATUSES = [
	'created', 'opened', 'in_progress', 'submitted',
	'changes_requested', 'approved', 'complete', 'revoked'
];

/** Shared filter shape across the read tools. Every value is checked against a
 *  known list before it reaches a query. */
interface Filters {
	track?: string;
	status?: string;
	entity?: string;
	createdWithinDays?: number;
}

async function whereFrom(f: Filters = {}): Promise<Record<string, unknown>> {
	const where: Record<string, unknown> = {};
	if (f.track && TRACKS.includes(f.track as never)) where.track = f.track;
	if (f.status && STATUSES.includes(f.status)) where.status = f.status;
	if (f.entity) {
		// Accepts a name or an id, because the model will have seen names.
		const co = /^[a-f\d]{24}$/i.test(f.entity)
			? await Company.findById(f.entity).select('_id').lean()
			: await Company.findOne({ name: new RegExp(escapeRx(f.entity), 'i') }).select('_id').lean();
		// An entity that matches nothing must return nothing, never everything.
		where.companyId = co?._id ?? null;
	}
	if (typeof f.createdWithinDays === 'number' && f.createdWithinDays > 0) {
		const from = new Date(Date.now() - Math.min(f.createdWithinDays, 3650) * 86400000);
		where.createdAt = { $gte: from };
	}
	return where;
}

function escapeRx(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MAX_ROWS = 200;

// ── tool definitions ─────────────────────────────────────────────────────────

export interface ToolDef {
	name: string;
	description: string;
	/** Capability the caller must hold, and at what level, to be offered it.
	 *  Absent means every signed-in admin — for tools about the caller's own
	 *  requests and work, which everyone has. */
	cap?: string;
	min?: Level;
	/** A further condition on who is offered it, for rules that are about the
	 *  caller's role rather than a capability. */
	when?: (caller: Caller) => boolean;
	parameters: Record<string, unknown>;
	run: (args: Record<string, unknown>, caller: Caller) => Promise<unknown>;
}

const filterProps = {
	track: { type: 'string', enum: TRACKS, description: 'Hiring track' },
	status: { type: 'string', enum: STATUSES, description: 'Onboarding status' },
	entity: { type: 'string', description: 'Entity/company name or id' },
	createdWithinDays: { type: 'number', description: 'Only records whose link was created in the last N days' }
};

export const TOOLS: ToolDef[] = [
	{
		name: 'pipeline_summary',
		description:
			'Counts of candidates broken down by status, track and entity. Use this for "how many", "what is the split", and any question answered by a number rather than a list.',
		cap: 'candidate.view',
		parameters: { type: 'object', properties: filterProps },
		run: async (args) => {
			const where = await whereFrom(args as Filters);
			const [total, byStatus, byTrack, byEntity] = await Promise.all([
				Candidate.countDocuments(where),
				Candidate.aggregate([{ $match: where }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
				Candidate.aggregate([{ $match: where }, { $group: { _id: '$track', n: { $sum: 1 } } }]),
				Candidate.aggregate([{ $match: where }, { $group: { _id: '$companyId', n: { $sum: 1 } } }])
			]);
			const companies = await Company.find({ _id: { $in: byEntity.map((e) => e._id) } })
				.select('name')
				.lean();
			const nameById = new Map(companies.map((c) => [String(c._id), c.name as string]));
			return {
				total,
				byStatus: Object.fromEntries(byStatus.map((r) => [r._id ?? 'unknown', r.n])),
				byTrack: Object.fromEntries(byTrack.map((r) => [r._id ?? 'unknown', r.n])),
				byEntity: Object.fromEntries(
					byEntity.map((r) => [nameById.get(String(r._id)) ?? 'unknown', r.n])
				)
			};
		}
	},
	{
		name: 'find_candidates',
		description:
			'A list of candidates matching filters, with their operational details. Use when the answer is "who", not "how many". Returns at most 200 rows and no identity, bank or salary information.',
		cap: 'candidate.view',
		parameters: {
			type: 'object',
			properties: {
				...filterProps,
				nameContains: { type: 'string', description: 'Match part of a name or employee code' },
				limit: { type: 'number', description: 'Max rows, default 50, cap 200' }
			}
		},
		run: async (args) => {
			const a = args as Filters & { nameContains?: string; limit?: number };
			const where = await whereFrom(a);
			if (a.nameContains) {
				const rx = new RegExp(escapeRx(a.nameContains), 'i');
				where.$or = [{ fullName: rx }, { employeeId: rx }];
			}
			const limit = Math.min(Math.max(Number(a.limit) || 50, 1), MAX_ROWS);
			const rows = await Candidate.find(where)
				.populate('companyId')
				.sort({ createdAt: -1 })
				.limit(limit)
				.lean();
			const offers = await OfferLetter.find({ candidateId: { $in: rows.map((r) => r._id) } })
				.select('candidateId jobTitle department joiningDate status')
				.lean();
			const offerBy = new Map(offers.map((o) => [String(o.candidateId), o]));
			return rows.map((c) => {
				const o = offerBy.get(String(c._id));
				return {
					name: c.fullName ?? c.email,
					email: c.email,
					track: c.track,
					status: c.status,
					entity: (c.companyId as unknown as { name?: string })?.name ?? '',
					employeeId: c.employeeId ?? null,
					designation: o?.jobTitle ?? null,
					department: o?.department ?? null,
					joiningDate: o?.joiningDate ?? null,
					offerStatus: o?.status ?? 'none'
				};
			});
		}
	},
	{
		name: 'report_fields',
		description:
			'The columns a report can contain. Call this FIRST when the user supplies a report schema, template or list of headings, then map each of their headings onto the closest key before calling build_report.',
		cap: 'candidate.view',
		parameters: { type: 'object', properties: {} },
		run: async () => ({
			fields: REPORT_FIELDS.map((f) => ({ key: f.key, label: f.label })),
			note: 'Identity numbers, bank details and compensation are deliberately unavailable.'
		})
	},
	{
		name: 'build_report',
		description:
			'Build a report: pick columns from report_fields and filters, and get back real rows. The rows come from the database, not from you — never invent, re-order or recompute them.',
		cap: 'candidate.view',
		parameters: {
			type: 'object',
			properties: {
				columns: {
					type: 'array',
					items: { type: 'string' },
					description: 'Field keys from report_fields, in the order the user asked for them'
				},
				title: { type: 'string', description: 'A short title for the report' },
				...filterProps,
				limit: { type: 'number', description: 'Max rows, default 200' }
			},
			required: ['columns']
		},
		run: async (args) => {
			const a = args as Filters & { columns?: string[]; title?: string; limit?: number };
			const keys = (a.columns ?? []).filter((k) => REPORT_FIELD_BY_KEY.has(k));
			if (!keys.length)
				return { error: 'None of those columns exist. Call report_fields and map onto its keys.' };

			const where = await whereFrom(a);
			const limit = Math.min(Math.max(Number(a.limit) || MAX_ROWS, 1), MAX_ROWS);
			const rows = await Candidate.find(where)
				.populate('companyId')
				.sort({ createdAt: -1 })
				.limit(limit)
				.lean();
			const offers = await OfferLetter.find({ candidateId: { $in: rows.map((r) => r._id) } }).lean();
			const offerBy = new Map(offers.map((o) => [String(o.candidateId), o]));

			const value = (c: Record<string, unknown>, key: string): string => {
				const f = REPORT_FIELD_BY_KEY.get(key)!;
				let v: unknown;
				if (f.from === 'candidate') v = c[f.path];
				else if (f.from === 'company') v = (c.companyId as { name?: string })?.name;
				else v = (offerBy.get(String(c._id)) as Record<string, unknown> | undefined)?.[f.path];
				if (v instanceof Date) return v.toLocaleDateString('en-IN');
				return v === null || v === undefined ? '' : String(v);
			};

			return {
				title: a.title ?? 'Report',
				columns: keys.map((k) => ({ key: k, label: REPORT_FIELD_BY_KEY.get(k)!.label })),
				rows: rows.map((c) => keys.map((k) => value(c as Record<string, unknown>, k))),
				rowCount: rows.length,
				truncated: rows.length === limit
			};
		}
	},
	{
		name: 'offer_letter_status',
		description: 'How many offer letters are drafted vs sent, and which candidates are still waiting.',
		cap: 'offer.preview',
		parameters: { type: 'object', properties: filterProps },
		run: async (args) => {
			const where = await whereFrom(args as Filters);
			const candidates = await Candidate.find(where).select('_id fullName email').lean();
			const ids = candidates.map((c) => c._id);
			const offers = await OfferLetter.find({ candidateId: { $in: ids } })
				.select('candidateId status sentAt')
				.lean();
			const byId = new Map(offers.map((o) => [String(o.candidateId), o]));
			let sent = 0,
				draft = 0,
				none = 0;
			const awaiting: string[] = [];
			for (const c of candidates) {
				const o = byId.get(String(c._id));
				if (!o) {
					none++;
					awaiting.push(c.fullName ?? c.email);
				} else if (o.status === 'sent') sent++;
				else {
					draft++;
					awaiting.push(c.fullName ?? c.email);
				}
			}
			return { sent, draft, noLetterYet: none, awaiting: awaiting.slice(0, 50) };
		}
	},
	{
		name: 'exit_summary',
		description: 'Offboarding: how many exits are in progress, and where each one has got to.',
		cap: 'exit.particulars',
		parameters: { type: 'object', properties: {} },
		run: async () => {
			const rows = await Exit.find({}).select('fullName employeeId status lwd').sort({ createdAt: -1 }).limit(100).lean();
			const byStatus: Record<string, number> = {};
			for (const r of rows) byStatus[String(r.status)] = (byStatus[String(r.status)] ?? 0) + 1;
			return {
				total: rows.length,
				byStatus,
				exits: rows.slice(0, 50).map((r) => ({
					name: r.fullName ?? r.employeeId ?? '',
					status: r.status,
					lastWorkingDay: r.lwd ?? null
				}))
			};
		}
	},
	{
		name: 'list_logins',
		description:
			'The portal logins: email, role and whether the login is active. Use this to find the person a question is about before proposing any access change.',
		cap: 'team.view',
		parameters: { type: 'object', properties: {} },
		run: async () => {
			const rows = await Admin.find({}).select('email role status name title accessPreset').sort({ email: 1 }).lean();
			return rows.map((a) => ({
				email: a.email,
				role: a.role,
				status: a.status,
				name: (a.name as string) ?? null,
				title: (a.title as string) ?? null,
				accessPresetInStudio: (a.accessPreset as string) ?? null
			}));
		}
	},
	{
		name: 'capability_catalogue',
		description:
			'Every capability the access model defines, grouped by module, with its key and the levels it offers. Call this before proposing an access change or drafting an access request, so it names a real capability.',
		// Open to everyone: it describes the portal's sections, not anyone's
		// data, and a teammate cannot ask for access without naming what for.
		parameters: { type: 'object', properties: {} },
		run: async () => ({
			modules: MODULES.map((m) => ({
				module: m.name,
				capabilities: m.caps.map((c) => ({
					key: c.key,
					label: c.label,
					kind: c.kind,
					implemented: c.wired !== false
				}))
			})),
			levels: { none: 'no access', view: 'can see', act: 'can do', approve: 'can sign off' }
		})
	},
	{
		name: 'search_audit',
		description:
			'The audit trail: who did what, when, and the before/after value. Use for "who changed this", "when was this sent", "what happened to this record".',
		cap: 'audit.view',
		parameters: {
			type: 'object',
			properties: {
				actor: { type: 'string', description: 'Email of the person who acted' },
				action: { type: 'string', description: 'Action name, e.g. offer_letter_sent' },
				candidateName: { type: 'string', description: 'Name of the candidate the entry is about' },
				withinDays: { type: 'number', description: 'Only entries from the last N days' },
				limit: { type: 'number', description: 'Max entries, default 50' }
			}
		},
		run: async (args) => {
			const a = args as { actor?: string; action?: string; candidateName?: string; withinDays?: number; limit?: number };
			const where: Record<string, unknown> = {};
			if (a.actor) where.actor = new RegExp(escapeRx(a.actor), 'i');
			if (a.action) where.action = new RegExp(escapeRx(a.action), 'i');
			if (a.withinDays) where.createdAt = { $gte: new Date(Date.now() - Math.min(a.withinDays, 3650) * 86400000) };
			if (a.candidateName) {
				const hits = await Candidate.find({ fullName: new RegExp(escapeRx(a.candidateName), 'i') })
					.select('_id')
					.limit(20)
					.lean();
				where.candidateId = { $in: hits.map((h) => h._id) };
			}
			const limit = Math.min(Math.max(Number(a.limit) || 50, 1), MAX_ROWS);
			const rows = await AuditLog.find(where).sort({ createdAt: -1 }).limit(limit).lean();
			return rows.map((r) => ({
				at: (r.createdAt as Date).toISOString(),
				actor: r.actor,
				action: r.action,
				field: r.field ?? null,
				from: r.oldValue ?? null,
				to: r.newValue ?? null
			}));
		}
	},
	{
		name: 'propose_access_change',
		description:
			'Propose giving or removing a capability for one login. THIS DOES NOT APPLY ANYTHING — it returns a proposal the human must approve on screen. Always call list_logins and capability_catalogue first so the email and capability key are real.',
		cap: 'team.permissions',
		min: 'approve',
		parameters: {
			type: 'object',
			properties: {
				email: { type: 'string', description: 'The login to change' },
				capability: { type: 'string', description: 'Capability key from capability_catalogue' },
				level: { type: 'string', enum: ['none', 'view', 'act', 'approve'] },
				reason: { type: 'string', description: 'Why, in one line — shown on the confirmation' }
			},
			required: ['email', 'capability', 'level']
		},
		run: async (args) => {
			const a = args as { email?: string; capability?: string; level?: Level; reason?: string };
			const target = await Admin.findOne({ email: String(a.email ?? '').toLowerCase() })
				.select('email role')
				.lean();
			if (!target) return { error: `No login found for ${a.email}.` };
			const cap = CAPS[String(a.capability)];
			if (!cap) return { error: `No capability called "${a.capability}".` };

			const current = effectiveLevel(
				{
					preset: PRESETS[target.role] ? target.role : 'hr_admin',
					grants: {},
					checkers: {},
					population: 'all',
					entities: 'all',
					tracks: 'all',
					status: 'active'
				},
				cap.key
			);
			return {
				proposal: {
					email: target.email,
					role: target.role,
					capability: cap.key,
					capabilityLabel: cap.label,
					from: current,
					to: a.level,
					reason: a.reason ?? null,
					implemented: cap.wired !== false
				},
				note: 'Nothing has changed. Present this to the user and tell them to use the Apply button on the proposal card.'
			};
		}
	},
	{
		name: 'draft_access_request',
		description:
			'Draft a request, from the person you are talking to, for a capability they do not have. THIS SENDS NOTHING — it returns a card with a Send button, and the request only reaches the super admins when they press it. Call capability_catalogue first so the key is real.',
		// A super admin already holds everything, so there is nothing to ask for.
		when: (c) => c.role !== 'super_admin',
		parameters: {
			type: 'object',
			properties: {
				capability: { type: 'string', description: 'Capability key from capability_catalogue' },
				level: { type: 'string', enum: ['view', 'act', 'approve'], description: 'The level they need. Use the lowest that does the job.' },
				reason: { type: 'string', description: 'Why they need it, in their words, one line — the super admin reads this' }
			},
			required: ['capability', 'level']
		},
		run: async (args, caller) => {
			const a = args as { capability?: string; level?: string; reason?: string };
			try {
				const { cap, level, from } = await checkAccessRequest(caller, String(a.capability ?? ''), String(a.level ?? ''));
				return {
					draft: {
						kind: 'access',
						capability: cap.key,
						capabilityLabel: cap.label,
						from,
						to: level,
						note: a.reason?.trim().slice(0, 500) || null,
						implemented: cap.wired !== false
					},
					note: 'Nothing has been sent. Tell them to press Send on the card, and that it goes to the super admins to approve.'
				};
			} catch (e) {
				if (e instanceof RequestError) return { error: e.message };
				throw e;
			}
		}
	},
	{
		name: 'draft_task',
		description:
			'Draft a piece of work for one teammate, e.g. "send the offer letter to Priya". THIS ASSIGNS NOTHING — it returns a card with an Assign button. Call list_logins first so the email is real. If the work is about a candidate, pass their name and the task links to their record.',
		cap: 'team.view',
		when: (c) => c.role === 'super_admin',
		parameters: {
			type: 'object',
			properties: {
				email: { type: 'string', description: 'The teammate doing the work, from list_logins' },
				task: { type: 'string', description: 'What needs doing, as a short instruction addressed to them' },
				candidateName: { type: 'string', description: 'The candidate it is about, if any' },
				dueInDays: { type: 'number', description: 'Due in N days, if a deadline was given. 0 is today.' },
				note: { type: 'string', description: 'Any extra context the person gave' }
			},
			required: ['email', 'task']
		},
		run: async (args, caller) => {
			const a = args as { email?: string; task?: string; candidateName?: string; dueInDays?: number; note?: string };
			const title = String(a.task ?? '').trim().slice(0, 500);
			if (!title) return { error: 'Say what the task is.' };

			let candidate: { _id: unknown; fullName?: string; email?: string } | null = null;
			if (a.candidateName?.trim()) {
				const name = a.candidateName.trim();
				const hits = (await Candidate.find({
					$or: [{ fullName: new RegExp(escapeRx(name), 'i') }, { email: new RegExp(escapeRx(name), 'i') }]
				})
					.select('fullName email status')
					.limit(8)
					.lean()) as { _id: unknown; fullName?: string; email?: string; status?: string }[];
				const exact = hits.filter((h) => (h.fullName ?? '').toLowerCase() === name.toLowerCase());
				const pick = exact.length === 1 ? exact : hits;
				if (!pick.length) return { error: `No candidate matched "${name}". Ask who they meant.` };
				// A task linked to the wrong candidate sends someone to the wrong
				// record, so more than one match is a question, not a guess.
				if (pick.length > 1)
					return {
						error: `More than one candidate matched "${name}". Ask which one — do not pick.`,
						matches: pick.map((h) => ({ name: h.fullName ?? h.email, email: h.email, status: h.status }))
					};
				candidate = pick[0];
			}

			try {
				const { assignee } = await checkTask(caller, String(a.email ?? ''), candidate ? String(candidate._id) : null);
				let dueAt: string | null = null;
				if (typeof a.dueInDays === 'number' && a.dueInDays >= 0) {
					const d = new Date();
					d.setDate(d.getDate() + Math.min(Math.round(a.dueInDays), 365));
					d.setHours(18, 0, 0, 0);
					dueAt = d.toISOString();
				}
				return {
					draft: {
						kind: 'task',
						toEmail: assignee.email,
						toName: assignee.name ?? null,
						title,
						candidateId: candidate ? String(candidate._id) : null,
						candidateName: candidate ? (candidate.fullName ?? candidate.email ?? null) : null,
						dueAt,
						note: a.note?.trim().slice(0, 500) || null
					},
					note: 'Nothing has been assigned. Tell them to press Assign on the card.'
				};
			} catch (e) {
				if (e instanceof RequestError) return { error: e.message };
				throw e;
			}
		}
	},
	{
		name: 'list_requests',
		description:
			"Access requests and tasks involving the person you are talking to: what is waiting on them (for a super admin, every pending access request; for anyone, tasks assigned to them) and what they raised. Use for \"any requests?\", \"what is pending\", \"my tasks\", \"did my access get approved\", \"approve Riya's request\". The items appear as cards with the buttons to act on them — you cannot approve, reject or complete anything yourself.",
		parameters: {
			type: 'object',
			properties: {
				which: { type: 'string', enum: ['waiting', 'mine', 'both'], description: 'Waiting on them, raised by them, or both (default)' },
				kind: { type: 'string', enum: ['access', 'task'], description: 'Only access requests, or only tasks' },
				about: { type: 'string', description: 'Only items involving this person — part of an email or name' }
			}
		},
		run: async (args, caller) => {
			const a = args as { which?: string; kind?: string; about?: string };
			const inbox = await inboxFor(caller);
			const which = a.which === 'waiting' || a.which === 'mine' ? a.which : 'both';
			let items = [
				...(which !== 'mine' ? inbox.waiting : []),
				...(which !== 'waiting' ? [...inbox.mine, ...inbox.recent] : [])
			];
			if (a.kind === 'access' || a.kind === 'task') items = items.filter((r) => r.kind === a.kind);
			if (a.about?.trim()) {
				const q = a.about.trim().toLowerCase();
				items = items.filter((r) =>
					[r.fromEmail, r.fromName, r.toEmail, r.toName, r.candidateName].some((s) => s?.toLowerCase().includes(q))
				);
			}
			// Something both waiting on them and raised by them would otherwise be
			// listed twice.
			const seen = new Set<string>();
			items = items.filter((r) => !seen.has(r.id) && !!seen.add(r.id));
			return {
				requests: items,
				note: items.length
					? 'These are shown to the user as cards with buttons. Summarise them briefly; do not claim to have acted on any.'
					: 'Nothing matched.'
			};
		}
	}
];

/** The tools this caller may use. A tool they cannot use is never shown to the
 *  model, so there is nothing to talk it into. */
export function toolsFor(caller: Caller): ToolDef[] {
	return TOOLS.filter((t) => (!t.cap || can(caller, t.cap, t.min ?? 'view')) && (!t.when || t.when(caller)));
}

/** The OpenAI-style schema the API expects. */
export function toolSchemas(caller: Caller) {
	return toolsFor(caller).map((t) => ({
		type: 'function',
		function: { name: t.name, description: t.description, parameters: t.parameters }
	}));
}

export async function runTool(
	name: string,
	args: Record<string, unknown>,
	caller: Caller
): Promise<unknown> {
	const tool = toolsFor(caller).find((t) => t.name === name);
	// Re-checked here rather than trusting the earlier filter: this is the last
	// line before a query runs, and it should not depend on what was offered.
	if (!tool) return { error: `You do not have access to ${name}.` };
	try {
		return await tool.run(args ?? {}, caller);
	} catch (e) {
		console.error(`[ai] tool ${name} failed:`, e);
		return { error: 'That lookup failed. Say so rather than guessing at the answer.' };
	}
}
