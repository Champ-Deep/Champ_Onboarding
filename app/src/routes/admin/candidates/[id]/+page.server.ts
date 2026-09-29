import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	Admin,
	AuditLog,
	Candidate,
	CandidateFile,
	Company,
	Document,
	PhysicalItem,
	LinkToken,
	Verification,
	OfferLetter
} from '$lib/server/db/schema';
import { audit } from '$lib/server/audit';
import { decrypt } from '$lib/server/crypto';
import { deleteFromGridFS } from '$lib/server/storage';
import { sendBrandedMail, brandSignoff } from '$lib/server/mailer';
import { checklistFor, missingMandatory } from '$lib/server/checklist';
import {
	maskAadhaar,
	validateMasterSheet,
	titleCase,
	isValidPan,
	isValidIfsc,
	isValidPin,
	isValidMobile
} from '$lib/shared/validation';
import {
	PHYSICAL_ITEM_TYPES,
	TRACK_LABELS,
	confirmableItemByField,
	slotByType,
	isBgvEligible,
	type Track
} from '$lib/shared/matrix';
import { brandBySlug } from '$lib/shared/brands';
import { runVerification } from '$lib/server/verify/engine';
import { VERIFY_SPECS } from '$lib/shared/match';
import {
	offerLetterInputFromDraft,
	isOfferLetterComplete,
	missingOfferLetterFields,
	type OfferLetterInput
} from '$lib/server/offer-letter/fields';
import { offerLetterInputFromForm } from '$lib/server/offer-letter/form';
import { getFixedLists } from '$lib/server/settings';
import { sendEmployeeCodeMail } from '$lib/server/employee-code-mail';
import { sendOfferLetterMail } from '$lib/server/offer-letter/send';
import { sendApprovalNotificationWA, sendOfferLetterNotificationWA } from '$lib/server/whatsapp';
import { createLinkToken, ensureLiveLinkToken } from '$lib/server/tokens';
import { isShiftTiming } from '$lib/shared/shifts';
import { RELIGIONS } from '$lib/shared/demographics';
import { sendItSetupMail } from '$lib/server/it-setup-mail';
import { env } from '$env/dynamic/private';
import { baseUrl } from '$lib/server/base-url';

async function getCandidate(id: string) {
	const candidate = await Candidate.findById(id).lean();
	if (!candidate) return null;
	const company = await Company.findById(candidate.companyId).lean();
	return { candidate, company };
}

/** Most mutations on a candidate record are super_admin-only. hr_admin keeps
 *  full read access to this page but cannot change these fields, regardless
 *  of the candidate's status. Approving, sending the offer letter, marking
 *  physical items received, and assigning the employee code are carved out
 *  via requireApprover below; the OCR cross-check is ungated entirely
 *  (requireAnyAdmin). */
function requireSuperAdmin(locals: App.Locals) {
	if (locals.admin?.role !== 'super_admin') return fail(403, { message: 'Only a super admin can edit candidate records.' });
	return null;
}

/** Approving a candidate, sending their offer letter, logging physical
 *  handover items (photos, signed offer letter, NDA) on joining day, and
 *  assigning the employee code are HR/recruiter's core job, not an
 *  admin-only escalation — both hr_admin and super_admin can perform these.
 *  Every other mutation on this page stays super_admin-only. */
function requireApprover(locals: App.Locals) {
	if (locals.admin?.role !== 'super_admin' && locals.admin?.role !== 'hr_admin')
		return fail(403, { message: 'Only HR or a super admin can do this.' });
	return null;
}

/** Signed in, whatever the role. Only the OCR cross-check uses this: see the
 *  note on that action for why it is ungated. hooks.server.ts already redirects
 *  any /admin request without a session, so this is a backstop against a
 *  direct POST rather than the primary guard. */
function requireAnyAdmin(locals: App.Locals) {
	if (!locals.admin) return fail(401, { message: 'Not authenticated.' });
	return null;
}

function reviewFlags(candidate: Record<string, unknown>, aadhaarPlain: string | null, requirePrevEmployment: boolean) {
	const fields: Record<string, string> = {};
	for (const [k, v] of Object.entries(candidate)) {
		if (typeof v === 'string') fields[k] = v;
	}
	fields.aadhaarNo = aadhaarPlain ?? '';
	return validateMasterSheet(fields, requirePrevEmployment).map((e) => e.message);
}

// Every candidate-submitted profile field HR can correct after the fact.
// Deliberately excludes Aadhaar (its own encrypted write-once flow — an admin
// typo-fix there needs its own reveal-then-edit path, not bundled in here) and
// email/track (identity keys other records — offer letters, verifications —
// are already keyed against, so changing them here would silently orphan
// those instead of updating them).
const PROFILE_FIELDS = [
	'fullName', 'dob', 'gender', 'mobile',
	'fatherName', 'fatherMobile', 'fatherDob', 'motherName', 'motherMobile', 'motherDob',
	'religion', 'motherTongue',
	'maritalStatus', 'spouseName', 'spouseContact', 'spouseDob',
	'emergencyContactName', 'emergencyContactMobile', 'emergencyContactRelation',
	'presentAddress', 'presentPin', 'presentHouseNo',
	'permanentAddress', 'permanentPin', 'permanentHouseNo',
	'panNo', 'dlNo', 'passportNo', 'linkedinId',
	'bankAccountName', 'bankName', 'accountNo', 'ifsc', 'branch',
	'prevCompanyName', 'prevEmployeeId', 'prevDoj', 'prevDol', 'prevDesignation',
	'prevRemuneration', 'prevSupervisor', 'prevReasonLeaving', 'prevHrEmail'
] as const;

const PROFILE_TITLE_CASE_FIELDS = new Set([
	'fullName', 'fatherName', 'motherName', 'spouseName', 'emergencyContactName',
	'bankAccountName', 'bankName', 'branch', 'motherTongue'
]);

/** Same normalization the candidate-facing form applies (see
 *  /c/[token]/+page.server.ts formToFields) — an HR-entered correction should
 *  read the same as a candidate-entered one, not a differently-cased outlier. */
function profileFormToUpdate(form: FormData): Record<string, string> {
	const out: Record<string, string> = {};
	for (const f of PROFILE_FIELDS) {
		let v = String(form.get(f) ?? '').trim();
		if (PROFILE_TITLE_CASE_FIELDS.has(f) && v) v = titleCase(v);
		if (f === 'panNo' || f === 'ifsc') v = v.toUpperCase();
		if (f === 'prevHrEmail') v = v.toLowerCase();
		out[f] = v;
	}
	return out;
}

/** Correcting one field (e.g. just motherDob) must not be blocked by an
 *  unrelated field the candidate never filled in — so this checks format only
 *  where a value is present, not the full master-sheet completeness gate
 *  candidates face at submission. */
function validateProfileEdit(fields: Record<string, string>, original?: { religion?: string | null }): string[] {
	const errors: string[] = [];
	if (fields.panNo && !isValidPan(fields.panNo)) errors.push('PAN must match AAAAA9999A');
	if (fields.ifsc && !isValidIfsc(fields.ifsc)) errors.push('IFSC must match AAAA0XXXXXX');
	for (const [field, label] of [
		['presentPin', 'Present PIN'],
		['permanentPin', 'Permanent PIN']
	] as const) {
		if (fields[field] && !isValidPin(fields[field])) errors.push(`${label} must be 6 digits`);
	}
	for (const [field, label] of [
		['mobile', 'Mobile'],
		['fatherMobile', "Father's mobile"],
		['motherMobile', "Mother's mobile"],
		['emergencyContactMobile', 'Emergency contact mobile']
	] as const) {
		if (fields[field] && !isValidMobile(fields[field])) errors.push(`${label} must be a 10-digit number starting 6–9`);
	}
	if (fields.maritalStatus && !['single', 'married'].includes(fields.maritalStatus))
		errors.push('Marital status must be single or married');
	// Religion is mandatory everywhere it can be set, not just on the candidate's
	// own submission (validateMasterSheet). It is a Master Tracker column payroll
	// and the statutory registers read, so a blank has to be chased down by hand
	// after joining — and HR's editor was the one door left open: it validated the
	// value only when one was present, so saving the form with the dropdown on "—"
	// silently cleared it.
	//
	// This also catches legacy rows created before the Aug 2026 rule: opening one
	// in the editor now requires a religion before it will save. That is the
	// intended way those blanks get backfilled — the dropdown is right there — but
	// it does mean an unrelated edit to an old record has to fill this in first.
	if (!fields.religion?.trim()) errors.push('Religion is required');
	// Same closed-list check as marital status. A legacy value already on the row
	// (e.g. the retired "Prefer not to say") is left alone — the editor re-offers
	// it as an option, so round-tripping an unrelated edit must not fail here.
	else if (
		!RELIGIONS.includes(fields.religion as (typeof RELIGIONS)[number]) &&
		fields.religion !== original?.religion
	)
		errors.push('Religion must be one of the listed options');
	return errors;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	const row = await getCandidate(params.id);
	if (!row) error(404, 'Candidate not found');
	const { candidate, company } = row;

	const [
		checklist,
		physical,
		verificationDocs,
		offerLetter,
		activeLinkToken,
		fixedLists,
		referenceFiles
	] = await Promise.all([
		checklistFor(String(candidate._id), candidate.track as Track, company?.brandSlug),
		PhysicalItem.find({ candidateId: candidate._id }).lean(),
		Verification.find({ candidateId: candidate._id }).lean(),
		OfferLetter.findOne({ candidateId: candidate._id }).lean(),
		// Most recent non-revoked, unexpired token — the one candidateId can
		// currently open. Older tokens are left alone (never deleted) as an
		// audit trail; only this one is ever surfaced for display/testing.
		LinkToken.findOne({ candidateId: candidate._id, revoked: false, expiresAt: { $gt: new Date() } })
			.sort({ createdAt: -1 })
			.lean(),
		getFixedLists(),
		CandidateFile.find({ candidateId: candidate._id }).sort({ createdAt: -1 }).lean()
	]);

	// The decision is stored against an Admin id; the page needs the email. A
	// deleted login leaves the id dangling, so fall back rather than dropping
	// the attribution entirely — "someone decided this" still beats silence.
	const decidedBy = candidate.hiringDecisionBy
		? ((await Admin.findById(candidate.hiringDecisionBy, 'email').lean())?.email ??
			'a login since removed')
		: null;

	// Who the IT and employee code mails actually went to, and who sent them.
	// Read from the audit entry each send writes rather than from settings,
	// because the settings list can change after the mail has gone — the note
	// has to say where it went, not where it would go now.
	const lastSends = await AuditLog.find({
		candidateId: candidate._id,
		action: { $in: ['it_setup_mail_sent', 'employee_code_mail_sent'] }
	})
		.sort({ createdAt: -1 })
		.limit(20)
		.lean();
	const lastSend = (action: string) => {
		const row = lastSends.find((r) => r.action === action);
		if (!row) return null;
		// Written as "manual → a, b"; older entries used "->".
		const list = String(row.newValue ?? '').split(/→|->/)[1] ?? '';
		return {
			by: row.actor as string,
			to: list.split(',').map((e) => e.trim()).filter(Boolean)
		};
	};
	const mailSends = {
		it: lastSend('it_setup_mail_sent'),
		code: lastSend('employee_code_mail_sent')
	};

	// Candidates created before an item type existed have no row for it, and the
	// toggle needs one to write to. Backfilling on read keeps the joining-day
	// checklist complete for every record without a migration; insertMany with
	// ordered:false so a concurrent view racing us cannot fail the page.
	const missingItems = PHYSICAL_ITEM_TYPES.filter(
		(p) => !physical.some((i) => i.itemType === p.type)
	);
	if (missingItems.length) {
		try {
			const created = await PhysicalItem.insertMany(
				missingItems.map((p) => ({ candidateId: candidate._id, itemType: p.type })),
				{ ordered: false }
			);
			physical.push(...created.map((d) => d.toObject()));
		} catch {
			/* another request created them first — harmless */
		}
	}

	const aadhaarPlain = candidate.aadhaarNoEncrypted ? decrypt(candidate.aadhaarNoEncrypted) : null;

	const base = baseUrl();
	const onboardingLink =
		activeLinkToken?.tokenEncrypted != null
			? {
					url: `${base}/c/${decrypt(activeLinkToken.tokenEncrypted)}`,
					expiresAt: activeLinkToken.expiresAt.toISOString(),
					openedAt: activeLinkToken.openedAt?.toISOString() ?? null
				}
			: null;

	return {
		candidate: {
			id: String(candidate._id),
			email: candidate.email,
			fullName: candidate.fullName ?? null,
			track: candidate.track,
			status: candidate.status,
			gender: candidate.gender ?? null,
			dob: candidate.dob ?? null,
			mobile: candidate.mobile ?? null,
			fatherName: candidate.fatherName ?? null,
			fatherMobile: candidate.fatherMobile ?? null,
			fatherDob: candidate.fatherDob ?? null,
			motherName: candidate.motherName ?? null,
			motherMobile: candidate.motherMobile ?? null,
			motherDob: candidate.motherDob ?? null,
			religion: candidate.religion ?? null,
			motherTongue: candidate.motherTongue ?? null,
			maritalStatus: candidate.maritalStatus ?? null,
			spouseName: candidate.spouseName ?? null,
			spouseContact: candidate.spouseContact ?? null,
			spouseDob: candidate.spouseDob ?? null,
			emergencyContactName: candidate.emergencyContactName ?? null,
			emergencyContactMobile: candidate.emergencyContactMobile ?? null,
			emergencyContactRelation: candidate.emergencyContactRelation ?? null,
			presentAddress: candidate.presentAddress ?? null,
			presentPin: candidate.presentPin ?? null,
			presentHouseNo: candidate.presentHouseNo ?? null,
			permanentAddress: candidate.permanentAddress ?? null,
			permanentPin: candidate.permanentPin ?? null,
			permanentHouseNo: candidate.permanentHouseNo ?? null,
			aadhaarMasked: maskAadhaar(candidate.aadhaarLast4 ?? null),
			panNo: candidate.panNo ?? null,
			uanNo: candidate.uanNo ?? null,
			dlNo: candidate.dlNo ?? null,
			passportNo: candidate.passportNo ?? null,
			linkedinId: candidate.linkedinId ?? null,
			bankAccountName: candidate.bankAccountName ?? null,
			bankName: candidate.bankName ?? null,
			accountNo: candidate.accountNo ?? null,
			ifsc: candidate.ifsc ?? null,
			branch: candidate.branch ?? null,
			employeeId: candidate.employeeId ?? null,
			bgvEligible: isBgvEligible(candidate.track, row.company?.brandSlug),
			prevCompanyName: candidate.prevCompanyName ?? null,
			prevEmployeeId: candidate.prevEmployeeId ?? null,
			prevDoj: candidate.prevDoj ?? null,
			prevDol: candidate.prevDol ?? null,
			prevDesignation: candidate.prevDesignation ?? null,
			prevRemuneration: candidate.prevRemuneration ?? null,
			prevSupervisor: candidate.prevSupervisor ?? null,
			prevReasonLeaving: candidate.prevReasonLeaving ?? null,
			prevHrEmail: candidate.prevHrEmail ?? null,
			consentAt: candidate.consentAt?.toISOString() ?? null,
			createdAt: (candidate as unknown as { createdAt: Date }).createdAt.toISOString(),
			submittedAt: candidate.submittedAt?.toISOString() ?? null,
			reviewedAt: candidate.reviewedAt?.toISOString() ?? null,
			hiringDecision: candidate.hiringDecision ?? null,
			hiringDecisionAt: candidate.hiringDecisionAt?.toISOString() ?? null,
			// Who made the call. Recorded on every decision since the field was
			// added, but never surfaced until now — so a decision one person took
			// looked anonymous to the next person opening the record, and there
			// was no way to tell a considered Accept from a mis-click.
			hiringDecisionBy: decidedBy,
			shiftTiming: candidate.shiftTiming ?? null,
			teamName: candidate.teamName ?? null,
			itRequestId: candidate.itRequestId ?? null,
			employeeCodeMailSentAt: candidate.employeeCodeMailSentAt?.toISOString() ?? null,
			payrollEntity: candidate.payrollEntity ?? null,
			workLocationMode: candidate.workLocationMode ?? null,
			joiningMode: candidate.joiningMode ?? null,
			itSetupMailSentAt: candidate.itSetupMailSentAt?.toISOString() ?? null
		},
		mailSends,
		companyName: company?.name ?? '',
		brand: brandBySlug(company?.brandSlug ?? undefined),
		checklist: checklist.map((s) => ({
			...s,
			docs: s.docs.map((d) => ({
				id: d.id,
				mime: d.mime,
				sizeBytes: 0,
				ocrStatus: d.ocrStatus,
				reviewStatus: d.reviewStatus,
				reviewNote: d.reviewNote,
				reuploadCount: d.reuploadCount,
				reuploadRequestedAt: d.reuploadRequestedAt,
				ocrTranscript: null,
				uploadedAt: new Date().toISOString(),
				// Per-document standard-conformance check (e.g. "is this actually a
				// passport photo") is not implemented yet — always null until that
				// verification step exists; the UI already no-ops safely on null.
				standardStatus: null as string | null,
				standardReasons: null as string[] | null
			}))
		})),
		physical: PHYSICAL_ITEM_TYPES.map((p) => {
			const item = physical.find((i) => i.itemType === p.type);
			// Confirmation items carry the field they read back, its current value,
			// whether HR has an outstanding request with the candidate, and whether
			// the candidate has answered it — everything the row needs to render
			// without the page re-deriving it from three separate lists.
			const confirms = 'confirms' in p ? (p.confirms as string) : null;
			const request = confirms
				? (candidate.requestedConfirmations ?? []).find(
						(r: { field: string }) => r.field === confirms
					)
				: null;
			return {
				id: item ? String(item._id) : null,
				type: p.type,
				label: p.label,
				received: item?.received ?? false,
				receivedAt: item?.receivedAt?.toISOString() ?? null,
				confirms,
				confirmLabel: 'confirmLabel' in p ? (p.confirmLabel as string) : null,
				currentValue: confirms ? ((candidate as Record<string, any>)[confirms] ?? null) : null,
				requestedAt: request?.requestedAt?.toISOString() ?? null,
				requestNote: request?.note ?? null,
				// Entries written before the counter existed have asked once.
				requestCount: request ? (request.count ?? 1) : 0,
				candidateConfirmedAt: item?.candidateConfirmedAt?.toISOString() ?? null,
				candidateConfirmedValue: item?.candidateConfirmedValue ?? null
			};
		}),
		flags:
			candidate.status === 'submitted'
				? reviewFlags(
						candidate as unknown as Record<string, unknown>,
						aadhaarPlain,
						isBgvEligible(candidate.track, row.company?.brandSlug)
					)
				: [],
		verifications: verificationDocs.map((v) => {
			const spec = VERIFY_SPECS[v.docKind];
			return {
				label: spec?.label ?? v.docKind,
				source: v.source,
				status: v.status as string,
				score: v.score,
				note: v.note ?? null,
				fieldResults: (v.fieldResults as Array<{ label: string; expected: string; found: string; verdict: string }>) ?? []
			};
		}),
		offerLetter: {
			...offerLetterInputFromDraft(offerLetter),
			status: offerLetter?.status ?? 'draft',
			sentAt: offerLetter?.sentAt?.toISOString() ?? null,
			/** The directly-uploaded letter, when there is one — it replaces the
			 *  generated letter everywhere, so the card leads with it. */
			uploaded: offerLetter?.uploadedLetter?.fileId
				? {
						filename: offerLetter.uploadedLetter.filename ?? 'offer-letter.pdf',
						sizeBytes: offerLetter.uploadedLetter.sizeBytes ?? 0,
						pages: offerLetter.uploadedLetter.pages ?? 1,
						uploadedBy: offerLetter.uploadedLetter.uploadedBy ?? '',
						uploadedAt: offerLetter.uploadedLetter.uploadedAt?.toISOString() ?? null,
						signature: {
							page: offerLetter.uploadedLetter.signature?.page ?? 1,
							x: offerLetter.uploadedLetter.signature?.x ?? 56,
							y: offerLetter.uploadedLetter.signature?.y ?? 140,
							width: offerLetter.uploadedLetter.signature?.width ?? 130,
							detected: offerLetter.uploadedLetter.signature?.detected ?? false,
							anchorText: offerLetter.uploadedLetter.signature?.anchorText ?? '',
							enabled: offerLetter.uploadedLetter.signature?.enabled ?? true
						}
					}
				: null
		},
		onboardingLink,
		/** HR's own reference uploads — optional, and separate from the candidate's
		 *  documents, which are matrix slots with OCR and a review verdict. */
		referenceFiles: referenceFiles.map((f) => ({
			id: String(f._id),
			label: f.label,
			note: f.note ?? null,
			mime: f.mime,
			sizeBytes: f.sizeBytes,
			uploadedAt: (f as unknown as { createdAt: Date }).createdAt.toISOString()
		})),
		/** Admin-editable option lists (settings → Dropdown options). */
		officeLocations: fixedLists.officeLocations ?? [],
		noticePeriods: fixedLists.noticePeriods ?? [],
		isSuperAdmin: locals.admin?.role === 'super_admin',
		isApprover: locals.admin?.role === 'super_admin' || locals.admin?.role === 'hr_admin'
	};
};

export const actions: Actions = {
	approve: async ({ params, locals, getClientAddress }) => {
		const forbidden = requireApprover(locals);
		if (forbidden) return forbidden;
		const row = await getCandidate(params.id);
		if (!row) return fail(404);
		const { candidate } = row;
		const brand = brandBySlug(row.company?.brandSlug ?? undefined);
		// Approval is HR's call and nothing else's. It used to require status
		// 'submitted' AND a complete mandatory-document checklist, which meant
		// asking one candidate for one re-upload took approval away twice over:
		// requestReupload flips the status to 'changes_requested', and the
		// re-requested document stops counting as usable in checklistFor(). HR
		// routinely approves someone whose paperwork is still being chased, so the
		// button stays live and the checklist is advisory (it is still shown on the
		// page, and the approval mail below names anything outstanding).
		//
		// Only genuinely contradictory states are refused: an already-decided
		// record, and a revoked link (whose candidate can no longer be onboarded
		// at all — un-revoke by regenerating the link first).
		if (['approved', 'complete'].includes(candidate.status))
			return fail(409, { message: 'This candidate has already been approved.' });
		if (candidate.status === 'revoked')
			return fail(409, {
				message: 'This onboarding link is revoked — regenerate it before approving.'
			});

		const checklist = await checklistFor(
			String(candidate._id),
			candidate.track as Track,
			row.company?.brandSlug
		);
		const stillMissing = missingMandatory(checklist);

		const physical = await PhysicalItem.find({ candidateId: candidate._id }).lean();
		const allPhysical =
			physical.filter((p) => p.received).length === PHYSICAL_ITEM_TYPES.length;

		await Candidate.findByIdAndUpdate(candidate._id, {
			status: allPhysical ? 'complete' : 'approved',
			reviewedAt: new Date(),
			reviewedBy: locals.admin!.id
		});
		await audit({
			candidateId: params.id,
			actor: locals.admin!.email,
			action: 'approved',
			ip: getClientAddress()
		});
		// Approval can now happen with paperwork still outstanding, so the mail says
		// so rather than implying the file is closed — otherwise a candidate reads
		// "approved" and stops uploading. The pending list is the same one the
		// checklist shows HR.
		const pendingNote = stillMissing.length
			? `\nStill pending from your side — please open your onboarding link and upload:\n` +
				stillMissing
					.map((s) =>
						s.alternatives?.length
							? `  • ${s.label} (or ${s.alternatives.join(' or ')})`
							: `  • ${s.label}`
					)
					.join('\n') +
				`\n`
			: '';
		await sendBrandedMail(
			candidate.email,
			'Your onboarding is approved',
			`Hello,\n\nYour onboarding submission has been reviewed and approved by HR.\n` +
				pendingNote +
				`Reminder for your joining day: bring 4 passport-size photos and the signed hard copy of your offer letter.\n\n${brandSignoff(brand)}`,
			brand,
			undefined,
			'onboarding',
			params.id
		);

		// WhatsApp approval notification (best-effort — a WhatsApp failure must
		// never block approval, which has already been committed to the DB above).
		if (candidate.mobile) {
			await sendApprovalNotificationWA({
				mobile: candidate.mobile,
				candidateName: candidate.fullName || '',
				companyName: row.company?.name ?? brand.name
			}).catch((err) => console.error('[wa] approval notification failed:', err));
		}

		// Alert onboarding concern person to create employee code
		const onboardingEmail = env.ONBOARDING_CONCERN_EMAIL;
		if (onboardingEmail) {
			const base = baseUrl();
			const reviewUrl = `${base}/admin/candidates/${params.id}`;
			await sendBrandedMail(
				onboardingEmail,
				`✅ Create employee code: ${candidate.fullName || candidate.email}`,
				`Hello,\n\n` +
				`${candidate.fullName || candidate.email} has been approved by HR and is ready for employee code creation.\n\n` +
				`Track: ${TRACK_LABELS[candidate.track as Track]}\n` +
				`Company: ${row.company?.name ?? brand.name}\n` +
				`Job title: ${(await OfferLetter.findOne({ candidateId: params.id }).lean())?.jobTitle ?? '—'}\n` +
				`Email: ${candidate.email}\n` +
				`Mobile: ${candidate.mobile ?? '—'}\n\n` +
				(stillMissing.length
					? `Note: approved with ${stillMissing.length} mandatory document(s) still outstanding — ` +
						`${stillMissing.map((s) => s.label).join(', ')}.\n\n`
					: '') +
				`Please create their employee code and update the system:\n${reviewUrl}\n\n` +
				`${brandSignoff(brand)}`,
				brand
			).catch((err) => console.error('[approve-alert] onboarding concern email failed:', err));
		}

		return { ok: true };
	},

	// A manual HR hiring call, independent of document-review status above —
	// settable at any stage and reversible (see hiringDecision on the schema).
	setHiringDecision: async ({ params, request, locals, getClientAddress }) => {
		const forbidden = requireApprover(locals);
		if (forbidden) return forbidden;
		const row = await getCandidate(params.id);
		if (!row) return fail(404);

		const form = await request.formData();
		const decision = String(form.get('decision') ?? '');
		if (decision !== 'accepted' && decision !== 'rejected' && decision !== 'clear')
			return fail(400, { message: 'Invalid decision.' });

		const next = decision === 'clear' ? null : decision;
		await Candidate.findByIdAndUpdate(params.id, {
			hiringDecision: next,
			hiringDecisionAt: next ? new Date() : null,
			hiringDecisionBy: next ? locals.admin!.id : null
		});
		await audit({
			candidateId: params.id,
			actor: locals.admin!.email,
			action: 'hiring_decision_set',
			field: 'hiringDecision',
			oldValue: row.candidate.hiringDecision ?? null,
			newValue: next,
			ip: getClientAddress()
		});

		return { ok: true };
	},

	// The four remaining IT/VPN mail columns HR fills by hand. Team Name and
	// Payroll Entity are overrides — blanking them restores the derived value
	// (offer department / company name) rather than emptying the column, which
	// is why empty string is stored as null.
	setItMailFields: async ({ params, request, locals, getClientAddress }) => {
		const forbidden = requireApprover(locals);
		if (forbidden) return forbidden;
		const row = await getCandidate(params.id);
		if (!row) return fail(404);
		const form = await request.formData();
		const clean = (k: string) => String(form.get(k) ?? '').trim().slice(0, 120) || null;
		const patch = {
			teamName: clean('teamName'),
			payrollEntity: clean('payrollEntity'),
			workLocationMode: clean('workLocationMode'),
			joiningMode: clean('joiningMode'),
			itRequestId: clean('itRequestId')
		};
		await Candidate.findByIdAndUpdate(params.id, patch);

		// The other half of the Department/Team Name mapping (see saveOfferLetter).
		// Fills the offer letter's department when it is still blank, so HR types
		// the team once and the letter carries it.
		if (patch.teamName) {
			const draft = await OfferLetter.findOne({ candidateId: params.id }).lean();
			if (!draft?.department) {
				await OfferLetter.findOneAndUpdate(
					{ candidateId: params.id },
					{ $set: { department: patch.teamName } },
					{ upsert: true }
				);
				await audit({
					candidateId: params.id,
					actor: locals.admin!.email,
					action: 'offer_letter_field_set',
					field: 'department',
					oldValue: null,
					newValue: patch.teamName,
					ip: getClientAddress()
				});
			}
		}

		for (const [field, newValue] of Object.entries(patch)) {
			const oldValue = (row.candidate as unknown as Record<string, string | null>)[field] ?? null;
			if (oldValue === newValue) continue;
			await audit({
				candidateId: params.id,
				actor: locals.admin!.email,
				action: 'it_mail_field_set',
				field,
				oldValue,
				newValue,
				ip: getClientAddress()
			});
		}
		return { itMailFieldsSaved: true, ...patch };
	},

	// One of the three roster shifts (Flexible / General / Night Shift). Feeds
	// the Master Tracker export and the IT setup mail's Shift Timing column.
	setShiftTiming: async ({ params, request, locals, getClientAddress }) => {
		const forbidden = requireApprover(locals);
		if (forbidden) return forbidden;
		const row = await getCandidate(params.id);
		if (!row) return fail(404);
		const form = await request.formData();
		const raw = String(form.get('shiftTiming') ?? '').trim();
		// Empty clears the field; anything else must be one of the three, so a
		// stale form or a hand-rolled POST can't put arbitrary text in IT's mail.
		if (raw && !isShiftTiming(raw)) return fail(400, { message: 'Unknown shift timing.' });
		const shiftTiming = raw || null;
		await Candidate.findByIdAndUpdate(params.id, { shiftTiming });
		await audit({
			candidateId: params.id,
			actor: locals.admin!.email,
			action: 'shift_timing_set',
			field: 'shiftTiming',
			oldValue: row.candidate.shiftTiming ?? null,
			newValue: shiftTiming,
			ip: getClientAddress()
		});
		return { shiftTimingSaved: true, shiftTiming: shiftTiming ?? '' };
	},

	// Manual (re)send of the IT/VPN setup mail — the usual case is HR filling in
	// shift timing or the offer letter after having already accepted.
	/** The new-joinee employee code mail to the IT helpdesk. Manual only — it
	 *  announces a code, so it should never fire before HR has looked at the
	 *  code it is announcing. */
	sendEmployeeCodeMail: async ({ params, locals, getClientAddress }) => {
		const forbidden = requireApprover(locals);
		if (forbidden) return forbidden;
		const row = await getCandidate(params.id);
		if (!row) return fail(404);
		if (!row.candidate.employeeId)
			return fail(409, { message: 'Assign the employee code before announcing it.' });
		try {
			const { to, cc } = await sendEmployeeCodeMail(params.id);
			await audit({
				candidateId: params.id,
				actor: locals.admin!.email,
				action: 'employee_code_mail_sent',
				newValue: `manual -> ${[...to, ...cc].join(', ')}`,
				ip: getClientAddress()
			});
			return { employeeCodeMailSent: true };
		} catch (e) {
			console.error(`[employee-code-mail] send failed for candidate=${params.id}:`, e);
			return fail(502, { message: 'Could not send the employee code mail. Please try again.' });
		}
	},

	sendItSetupMail: async ({ params, locals, getClientAddress }) => {
		const forbidden = requireApprover(locals);
		if (forbidden) return forbidden;
		const row = await getCandidate(params.id);
		if (!row) return fail(404);
		try {
			const { to, cc } = await sendItSetupMail(params.id);
			await audit({
				candidateId: params.id,
				actor: locals.admin!.email,
				action: 'it_setup_mail_sent',
				newValue: `manual → ${[...to, ...cc].join(', ')}`,
				ip: getClientAddress()
			});
			return { itSetupMailSent: true };
		} catch (e) {
			console.error(`[it-setup-mail] manual send failed for candidate=${params.id}:`, e);
			return fail(502, { message: 'Could not send the IT setup mail. Please try again.' });
		}
	},

	requestReupload: async ({ params, request, locals, getClientAddress }) => {
		const forbidden = requireApprover(locals);
		if (forbidden) return forbidden;
		const row = await getCandidate(params.id);
		if (!row) return fail(404);
		const form = await request.formData();
		const docId = String(form.get('docId') ?? '');
		const note = String(form.get('note') ?? '').trim();

		const doc = await Document.findOne({ _id: docId, candidateId: params.id }).lean();
		if (!doc) return fail(404);

		// Deliberately repeatable: a candidate who sends back the same unreadable
		// scan needs asking again, and the second ask is the one that works. Each
		// call re-sends the mail, bumps the counter and re-stamps the date, so the
		// page can show how many times this has been chased.
		const attempt = (doc.reuploadCount ?? 0) + 1;
		await Document.findByIdAndUpdate(doc._id, {
			$set: {
				reviewStatus: 'reupload_requested',
				reviewNote: note || null,
				reuploadRequestedAt: new Date()
			},
			$inc: { reuploadCount: 1 }
		});
		await Candidate.findByIdAndUpdate(params.id, { status: 'changes_requested' });
		await audit({
			candidateId: params.id,
			actor: locals.admin!.email,
			action: 'reupload_requested',
			field: doc.docType,
			newValue: attempt > 1 ? `${note} (ask #${attempt})` : note,
			ip: getClientAddress()
		});
		const reuploadBrand = brandBySlug(row.company?.brandSlug ?? undefined);
		await sendBrandedMail(
			row.candidate.email,
			attempt > 1
				? 'Reminder: your onboarding documents still need attention'
				: 'Action needed on your onboarding documents',
			`Hello,\n\n` +
				(attempt > 1
					? `We are still waiting on a replacement for one of your documents (${doc.docType.replace(/_/g, ' ')})`
					: `HR has requested a re-upload of one of your documents (${doc.docType.replace(/_/g, ' ')})`) +
				(note ? `:\n"${note}"` : '.') +
				`\n\nPlease open your onboarding link again, replace the document, and resubmit.\n\n${brandSignoff(reuploadBrand)}`,
			reuploadBrand,
			undefined,
			'onboarding',
			params.id
		);
		return { ok: true };
	},

	// Mirrors requestReupload, but for a slot nothing has ever been uploaded to
	// (typically an optional document, e.g. degree certificate) — there is no
	// Document row to key off, so the request is recorded on the candidate and
	// picked up by checklistFor() until a matching file actually lands.
	/** Drops one of HR's reference documents. The GridFS object goes with it —
	 *  an orphaned blob is invisible and never gets cleaned up otherwise. */
	removeReferenceFile: async ({ params, request, locals, getClientAddress }) => {
		const forbidden = requireApprover(locals);
		if (forbidden) return forbidden;
		const fileId = String((await request.formData()).get('fileId') ?? '');
		const doc = await CandidateFile.findOne({ _id: fileId, candidateId: params.id }).lean();
		if (!doc) return fail(404, { message: 'That document is no longer there.' });

		const { deleteFromGridFS } = await import('$lib/server/storage');
		await deleteFromGridFS(doc.gridfsId as never).catch(() => {});
		await CandidateFile.deleteOne({ _id: fileId });

		await audit({
			candidateId: params.id,
			actor: locals.admin!.email,
			action: 'reference_file_removed',
			field: doc.label,
			ip: getClientAddress()
		});
		return { referenceFileRemoved: true };
	},

	requestUpload: async ({ params, request, locals, getClientAddress }) => {
		const forbidden = requireApprover(locals);
		if (forbidden) return forbidden;
		const row = await getCandidate(params.id);
		if (!row) return fail(404);
		const form = await request.formData();
		const docType = String(form.get('docType') ?? '');
		const note = String(form.get('note') ?? '').trim();

		const slot = slotByType(docType);
		if (!slot) return fail(404);

		// Repeatable, like requestReupload: one entry per docType, updated in
		// place so a third ask does not leave three rows behind. Update-then-push
		// rather than pull-then-push, because pulling first would throw away the
		// count we are trying to carry forward.
		const now = new Date();
		const bumped = await Candidate.updateOne(
			{ _id: params.id, 'requestedDocTypes.docType': docType },
			{
				$set: {
					'requestedDocTypes.$.note': note || null,
					'requestedDocTypes.$.requestedAt': now
				},
				$inc: { 'requestedDocTypes.$.count': 1 }
			}
		);
		if (!bumped.matchedCount) {
			await Candidate.findByIdAndUpdate(params.id, {
				$push: { requestedDocTypes: { docType, note: note || null, count: 1, requestedAt: now } }
			});
		}
		if (row.candidate.status === 'submitted') {
			await Candidate.findByIdAndUpdate(params.id, { status: 'changes_requested' });
		}

		const asked = await Candidate.findById(params.id, 'requestedDocTypes').lean();
		const attempt =
			(asked?.requestedDocTypes ?? []).find(
				(r: { docType: string; count?: number }) => r.docType === docType
			)?.count ?? 1;

		await audit({
			candidateId: params.id,
			actor: locals.admin!.email,
			action: 'upload_requested',
			field: docType,
			newValue: attempt > 1 ? `${note} (ask #${attempt})` : note,
			ip: getClientAddress()
		});
		const requestBrand = brandBySlug(row.company?.brandSlug ?? undefined);
		const slotLabel = slot.label.replace(/\s*\(optional\)/i, '');
		await sendBrandedMail(
			row.candidate.email,
			attempt > 1
				? 'Reminder: your onboarding documents still need attention'
				: 'Action needed on your onboarding documents',
			`Hello,\n\n` +
				(attempt > 1
					? `We are still waiting on your ${slotLabel}`
					: `HR has requested that you upload your ${slotLabel}`) +
				(note ? `:\n"${note}"` : '.') +
				`\n\nPlease open your onboarding link again and upload it.\n\n${brandSignoff(requestBrand)}`,
			requestBrand,
			undefined,
			'onboarding',
			params.id
		);
		return { uploadRequested: true };
	},

	/** Ask the candidate to re-confirm a joining-day detail (present address,
	 *  LinkedIn ID) from their own onboarding link.
	 *
	 *  Deliberately independent of the approval flow: it works at any status, and
	 *  unlike ?/requestUpload it does NOT push a submitted record back to
	 *  changes_requested. HR checking an address on joining day should not undo an
	 *  approval, and should not have to wait for one either.
	 *
	 *  The link is extended rather than reissued (ensureLiveLinkToken) — joining
	 *  day is routinely past the 7-day link window, so without this the candidate
	 *  would be mailed a URL that no longer opens. */
	requestConfirmation: async ({ params, request, locals, getClientAddress }) => {
		const forbidden = requireApprover(locals);
		if (forbidden) return forbidden;
		const row = await getCandidate(params.id);
		if (!row) return fail(404);
		const form = await request.formData();
		const field = String(form.get('field') ?? '');
		const note = String(form.get('note') ?? '').trim();

		const item = confirmableItemByField(field);
		if (!item) return fail(400, { message: 'That is not a confirmable detail.' });

		const token = await ensureLiveLinkToken(params.id);
		if (!token)
			return fail(409, {
				message: 'This record is revoked — restore it before asking the candidate to confirm.'
			});

		// Repeatable, and counted — same treatment as a document re-request. One
		// entry per field, updated in place, so a fourth ask does not leave four
		// rows behind but does show as the fourth.
		const askedAt = new Date();
		const bumped = await Candidate.updateOne(
			{ _id: params.id, 'requestedConfirmations.field': field },
			{
				$set: {
					'requestedConfirmations.$.note': note || null,
					'requestedConfirmations.$.requestedAt': askedAt
				},
				$inc: { 'requestedConfirmations.$.count': 1 }
			}
		);
		if (!bumped.matchedCount) {
			await Candidate.findByIdAndUpdate(params.id, {
				$push: { requestedConfirmations: { field, note: note || null, count: 1, requestedAt: askedAt } }
			});
		}

		const askedRow = await Candidate.findById(params.id, 'requestedConfirmations').lean();
		const attempt =
			(askedRow?.requestedConfirmations ?? []).find(
				(r: { field: string; count?: number }) => r.field === field
			)?.count ?? 1;

		await audit({
			candidateId: params.id,
			actor: locals.admin!.email,
			action: 'confirmation_requested',
			field,
			newValue: attempt > 1 ? `${note || ''} (ask #${attempt})`.trim() : note || null,
			ip: getClientAddress()
		});

		const brand = brandBySlug(row.company?.brandSlug ?? undefined);
		await sendBrandedMail(
			row.candidate.email,
			attempt > 1
				? `Reminder: please confirm your ${item.confirmLabel}`
				: `Please confirm your ${item.confirmLabel}`,
			`Hello,

` +
				(attempt > 1
					? `We are still waiting for you to confirm your ${item.confirmLabel} on record`
					: `Before your joining day we need you to confirm your ${item.confirmLabel} on record`) +
				(note ? `:
"${note}"` : '.') +
				`

Open your onboarding link and confirm it there — you can correct it if it has changed:
` +
				`${baseUrl()}/c/${token}

${brandSignoff(brand)}`,
			brand,
			undefined,
			'onboarding',
			params.id
		);

		return { confirmationRequested: item.confirmLabel };
	},

	physical: async ({ params, request, locals, getClientAddress }) => {
		const forbidden = requireApprover(locals);
		if (forbidden) return forbidden;
		const row = await getCandidate(params.id);
		if (!row) return fail(404);
		const form = await request.formData();
		const itemId = String(form.get('itemId') ?? '');
		const received = form.get('received') === 'true';

		await PhysicalItem.findOneAndUpdate(
			{ _id: itemId, candidateId: params.id },
			{
				received,
				receivedAt: received ? new Date() : null,
				receivedBy: received ? locals.admin!.id : null
			}
		);
		await audit({
			candidateId: params.id,
			actor: locals.admin!.email,
			action: received ? 'physical_item_received' : 'physical_item_unset',
			field: itemId,
			ip: getClientAddress()
		});

		// Counted against PHYSICAL_ITEM_TYPES, not just the rows present: a record
		// that predates an item type would otherwise reach `complete` by having no
		// row for it at all.
		const physical = await PhysicalItem.find({ candidateId: params.id }).lean();
		const allReceived =
			physical.filter((p) => p.received).length === PHYSICAL_ITEM_TYPES.length;
		if (row.candidate.status === 'approved' && allReceived) {
			await Candidate.findByIdAndUpdate(params.id, { status: 'complete' });
		} else if (row.candidate.status === 'complete' && !allReceived) {
			await Candidate.findByIdAndUpdate(params.id, { status: 'approved' });
		}
		return { ok: true };
	},

	reveal: async ({ params, locals, getClientAddress }) => {
		const row = await getCandidate(params.id);
		if (!row) return fail(404);
		if (!row.candidate.aadhaarNoEncrypted)
			return fail(404, { message: 'No Aadhaar on record.' });
		await audit({
			candidateId: params.id,
			actor: locals.admin!.email,
			action: 'aadhaar_revealed',
			ip: getClientAddress()
		});
		return { aadhaar: decrypt(row.candidate.aadhaarNoEncrypted) };
	},

	revoke: async ({ params, locals, getClientAddress }) => {
		const forbidden = requireSuperAdmin(locals);
		if (forbidden) return forbidden;
		const row = await getCandidate(params.id);
		if (!row) return fail(404);
		await LinkToken.updateMany({ candidateId: params.id }, { revoked: true });
		await Candidate.findByIdAndUpdate(params.id, { status: 'revoked' });
		await audit({
			candidateId: params.id,
			actor: locals.admin!.email,
			action: 'link_revoked',
			ip: getClientAddress()
		});
		return { ok: true };
	},

	// HR/admin-facing "does this candidate's link actually work" check: retires
	// whatever link is currently active and issues a fresh one, so the old link
	// (any copy of it sitting in an old email/chat) stops working the moment a
	// new one is handed out. Unlike `revoke`, this does not touch candidate.status
	// — the candidate is still expected to complete onboarding, just via a new URL.
	regenerateLink: async ({ params, locals, getClientAddress }) => {
		const forbidden = requireSuperAdmin(locals);
		if (forbidden) return forbidden;
		const row = await getCandidate(params.id);
		if (!row) return fail(404);
		if (['revoked', 'complete'].includes(row.candidate.status))
			return fail(409, { message: `Cannot regenerate a link for a ${row.candidate.status} candidate.` });

		await LinkToken.updateMany({ candidateId: params.id, revoked: false }, { revoked: true });
		const token = await createLinkToken(params.id);
		const base = baseUrl();

		await audit({
			candidateId: params.id,
			actor: locals.admin!.email,
			action: 'link_regenerated',
			ip: getClientAddress()
		});
		return { linkRegenerated: true, newLink: `${base}/c/${token}` };
	},

	deleteCandidate: async ({ params, locals, getClientAddress }) => {
		if (locals.admin?.role !== 'super_admin') return fail(403, { message: 'Forbidden.' });
		const row = await getCandidate(params.id);
		if (!row) return fail(404);
		const { candidate } = row;

		const docs = await Document.find({ candidateId: params.id }).lean();
		for (const doc of docs) {
			await deleteFromGridFS(doc.gridfsId as import('mongodb').ObjectId).catch((e) =>
				console.error(`[delete-candidate] failed to remove GridFS blob ${doc.gridfsId}:`, e)
			);
		}

		await Promise.all([
			Document.deleteMany({ candidateId: params.id }),
			LinkToken.deleteMany({ candidateId: params.id }),
			PhysicalItem.deleteMany({ candidateId: params.id }),
			Verification.deleteMany({ candidateId: params.id }),
			OfferLetter.deleteMany({ candidateId: params.id })
		]);

		await audit({
			candidateId: params.id,
			actor: locals.admin!.email,
			action: 'candidate_deleted',
			newValue: candidate.fullName ?? candidate.email,
			ip: getClientAddress()
		});

		await Candidate.findByIdAndDelete(params.id);

		redirect(303, '/admin/candidates');
	},

	setUan: async ({ params, request, locals, getClientAddress }) => {
		const forbidden = requireSuperAdmin(locals);
		if (forbidden) return forbidden;
		const row = await getCandidate(params.id);
		if (!row) return fail(404);
		if (['intern', 'fresher'].includes(row.candidate.track) === false)
			return fail(400, { message: 'UAN is set by the candidate for experienced track.' });
		const form = await request.formData();
		const uanNo = String(form.get('uanNo') ?? '').trim() || null;
		await Candidate.findByIdAndUpdate(params.id, { uanNo });
		await audit({
			candidateId: params.id,
			actor: locals.admin!.email,
			action: 'uan_set',
			newValue: uanNo ?? '',
			ip: getClientAddress()
		});
		return { uanSaved: true, uanNo: uanNo ?? '' };
	},

	/** Runs the OCR cross-check over every parsed document on this candidate.
	 *  Deliberately ungated — every signed-in role can run it, finance team
	 *  included. It reads only what OCR already extracted when the candidate
	 *  uploaded, records the comparison, and audits who ran it: it edits no
	 *  candidate field, sends the candidate nothing, and calls no external
	 *  service. Every role already has full read access to the documents and
	 *  verifications on this page, so this grants no visibility they did not
	 *  have — only the ability to refresh it — and anyone reviewing a document
	 *  against the typed master sheet should not need someone else to press the
	 *  button for them. */
	crosscheck: async ({ params, locals, getClientAddress }) => {
		const forbidden = requireAnyAdmin(locals);
		if (forbidden) return forbidden;
		const row = await getCandidate(params.id);
		if (!row) return fail(404);
		const { candidate } = row;

		const docs = await Document.find({
			candidateId: params.id,
			ocrStatus: { $in: ['parsed', 'pending'] }
		}).lean();

		// VERIFY_SPECS has one combined 'aadhaar' entry (front supplies
		// name/dob/gender, back supplies the PIN) but front/back are separate
		// Document rows — merge their ocrJson before verifying so neither side's
		// fields get reported as spuriously "missing" against the other's OCR.
		const docKindOf = (docType: string) => (docType.startsWith('aadhaar_') ? 'aadhaar' : docType);

		const foundByKind = new Map<string, Record<string, string>>();
		for (const doc of docs) {
			if (!doc.ocrJson) continue;
			const kind = docKindOf(doc.docType);
			const existing = foundByKind.get(kind) ?? {};
			foundByKind.set(kind, { ...existing, ...(doc.ocrJson as Record<string, string>) });
		}
		// aadhaar_front's OCR yields the full number as aadhaarNo, but the spec
		// (like the candidate's own stored field) compares only the last 4.
		for (const found of foundByKind.values()) {
			if (found.aadhaarNo && !found.aadhaarLast4) found.aadhaarLast4 = found.aadhaarNo.slice(-4);
		}

		let crosschecked = 0;
		for (const [kind, found] of foundByKind) {
			try {
				await runVerification(
					candidate as unknown as Record<string, unknown>,
					'ocr_crosscheck',
					kind,
					found,
					locals.admin!.email
				);
				crosschecked++;
			} catch (e) {
				console.error('[crosscheck]', kind, e);
			}
		}

		await audit({
			candidateId: params.id,
			actor: locals.admin!.email,
			action: 'ocr_crosscheck_run',
			newValue: String(crosschecked),
			ip: getClientAddress()
		});

		return { crosschecked };
	},

	saveOfferLetter: async ({ params, request, locals, getClientAddress }) => {
		const forbidden = requireApprover(locals);
		if (forbidden) return forbidden;
		const row = await getCandidate(params.id);
		if (!row) return fail(404);
		const form = await request.formData();

		// Same parse the preview endpoint runs, so what HR previews and what gets
		// saved can never diverge.
		const parsed = await offerLetterInputFromForm(form);
		if (!parsed.ok) return fail(400, { message: parsed.error });
		const input: OfferLetterInput = parsed.input;

		// Hand-edited wording is super-admin-only. An hr_admin's form carries no
		// manual-edit fields, so taking the parse at face value would quietly
		// erase a super admin's edits the next time anyone saved an unrelated
		// field — the saved list is carried forward instead.
		const existing = await OfferLetter.findOne({ candidateId: params.id }).lean();
		const saved = offerLetterInputFromDraft(existing);
		const isSuperAdmin = locals.admin?.role === 'super_admin';
		if (!isSuperAdmin) {
			input.manualEdits = saved.manualEdits;
			input.manualAdditions = saved.manualAdditions;
		}

		// Signed by whoever last changed the wording, so a letter that no longer
		// matches the template can be traced to a person without reading the
		// audit log. Only stamped when the wording actually changed.
		const editsChanged =
			JSON.stringify(saved.manualEdits) !== JSON.stringify(input.manualEdits) ||
			JSON.stringify(saved.manualAdditions) !== JSON.stringify(input.manualAdditions);
		const stamp = editsChanged
			? { manualEditsBy: locals.admin!.email, manualEditsAt: new Date() }
			: {};

		await OfferLetter.findOneAndUpdate(
			{ candidateId: params.id },
			{
				$set: {
					...input,
					// The schema's enum has no empty member, and $set does not run
					// validators, so a blank employment type used to be written as ''
					// and only blew up later, when something validated the whole
					// document. Blank means "not chosen", which is null.
					employmentType: input.employmentType || null,
					...stamp
				}
			},
			{ upsert: true }
		);

		if (editsChanged) {
			await audit({
				candidateId: params.id,
				actor: locals.admin!.email,
				action: 'offer_letter_manually_edited',
				oldValue: `${saved.manualEdits.length} edited, ${saved.manualAdditions.length} added`,
				newValue: `${input.manualEdits.length} edited, ${input.manualAdditions.length} added`,
				ip: getClientAddress()
			});
		}

		// Department and the IT mail's Team Name are the same fact typed into two
		// forms, so filling either one fills the other. Only when the target is
		// still blank: once HR has deliberately made them differ — the IT mail's
		// team is sometimes narrower than the letter's department — that stands.
		if (input.department && !row.candidate.teamName) {
			await Candidate.findByIdAndUpdate(params.id, { teamName: input.department });
			await audit({
				candidateId: params.id,
				actor: locals.admin!.email,
				action: 'it_mail_field_set',
				field: 'teamName',
				oldValue: null,
				newValue: input.department,
				ip: getClientAddress()
			});
		}

		await audit({
			candidateId: params.id,
			actor: locals.admin!.email,
			action: 'offer_letter_saved',
			ip: getClientAddress()
		});

		return { offerLetterSaved: true };
	},

	// HR/admin correcting a candidate-submitted profile field after the fact
	// (e.g. mother's DOB entered wrong) — the candidate themself can only edit
	// while their status is opened/in_progress/changes_requested, so once
	// they've submitted (or been approved), this is the only way to fix a typo
	// without asking them to redo the whole form.
	editProfile: async ({ params, request, locals, getClientAddress }) => {
		const forbidden = requireSuperAdmin(locals);
		if (forbidden) return forbidden;
		const row = await getCandidate(params.id);
		if (!row) return fail(404);

		const form = await request.formData();
		const fields = profileFormToUpdate(form);
		const errors = validateProfileEdit(fields, row.candidate);
		if (errors.length) return fail(400, { message: errors.join('; '), profileEditError: true });

		await Candidate.findByIdAndUpdate(params.id, fields);
		await audit({
			candidateId: params.id,
			actor: locals.admin!.email,
			action: 'profile_edited_by_admin',
			ip: getClientAddress()
		});
		return { profileSaved: true };
	},

	setEmployeeId: async ({ params, request, locals, getClientAddress }) => {
		const forbidden = requireApprover(locals);
		if (forbidden) return forbidden;
		const row = await getCandidate(params.id);
		if (!row) return fail(404);
		const form = await request.formData();
		const employeeId = String(form.get('employeeId') ?? '').trim() || null;
		await Candidate.findByIdAndUpdate(params.id, { employeeId });
		await audit({
			candidateId: params.id,
			actor: locals.admin!.email,
			action: 'employee_id_set',
			newValue: employeeId ?? '',
			ip: getClientAddress()
		});
		return { employeeIdSaved: true, employeeId: employeeId ?? '' };
	},

	/** Record a letter as already sent, without sending anything.
	 *
	 *  For the letter that reached the candidate but did not get recorded: the
	 *  send 500'd after the mail went out, a letter was sent by hand from
	 *  somebody's mailbox, or the record was migrated in. Until now the only way
	 *  to correct the status was to press Send — which emails the candidate a
	 *  duplicate to fix a bookkeeping error — or to edit the database by hand.
	 *
	 *  Super-admin only, and deliberately loud: the audit entry says the status
	 *  was set by hand and by whom, because "sent" now means two different
	 *  things and the log should be able to tell them apart. */
	markOfferLetterSent: async ({ params, request, locals, getClientAddress }) => {
		if (locals.admin?.role !== 'super_admin')
			return fail(403, { offerLetterError: true, message: 'Only a super admin can record a letter as sent.' });
		const row = await getCandidate(params.id);
		if (!row) return fail(404);

		const draft = await OfferLetter.findOne({ candidateId: params.id });
		if (!draft)
			return fail(400, { offerLetterError: true, message: 'There is no offer letter draft on this candidate yet.' });
		if (draft.status === 'sent')
			return fail(409, { offerLetterError: true, message: 'This letter is already recorded as sent.' });

		// The date it actually went out, when it is known — the point of this is
		// to make the record true, and stamping it with today's date would only
		// swap one wrong fact for another. Blank means now.
		const typed = String((await request.formData()).get('sentAt') ?? '').trim();
		const when = typed ? new Date(typed) : new Date();
		if (isNaN(when.getTime()))
			return fail(400, { offerLetterError: true, message: 'That date could not be read.' });
		if (when.getTime() > Date.now() + 60_000)
			return fail(400, { offerLetterError: true, message: 'That date is in the future.' });

		// A targeted update for the same reason the send path uses one: this must
		// not fail on the validity of an unrelated legacy field.
		await OfferLetter.updateOne(
			{ _id: draft._id },
			{ $set: { status: 'sent', sentAt: when, sentBy: locals.admin!.id } }
		);

		await audit({
			candidateId: params.id,
			actor: locals.admin!.email,
			action: 'offer_letter_marked_sent_manually',
			field: 'status',
			oldValue: 'draft',
			newValue: `sent (recorded by hand, dated ${when.toISOString()})`,
			ip: getClientAddress()
		});

		return { offerLetterMarkedSent: true };
	},

	sendOfferLetterEmail: async ({ params, locals, getClientAddress }) => {
		const forbidden = requireApprover(locals);
		if (forbidden) return forbidden;
		const row = await getCandidate(params.id);
		if (!row) return fail(404);
		const { candidate, company } = row;

		const draft = await OfferLetter.findOne({ candidateId: params.id });
		const draftInput = offerLetterInputFromDraft(draft);
		const track = candidate.track as Track;
		// A directly-uploaded letter is already written, so the form's required
		// fields do not gate sending it: they describe a letter this candidate is
		// not getting. What must exist is the upload.
		const hasUpload = !!draft?.uploadedLetter?.fileId;
		if (!draft || (!hasUpload && !isOfferLetterComplete(draftInput, track))) {
			return fail(400, {
				offerLetterError: true,
				message: `Fill in all offer letter fields before sending (missing: ${missingOfferLetterFields(draftInput, track).join(', ')}).`
			});
		}

		const brand = brandBySlug(company?.brandSlug ?? undefined);
		try {
			await sendOfferLetterMail(candidate, company?.name ?? '', draft, brand);
		} catch (e) {
			console.error(`[offer-letter] send failed for candidate=${params.id}:`, e);
			await audit({
				candidateId: params.id,
				actor: locals.admin!.email,
				action: 'offer_letter_send_failed',
				newValue: candidate.email,
				ip: getClientAddress()
			});
			return fail(502, {
				offerLetterError: true,
				message: 'Could not send the offer letter email — the draft was not marked as sent. Check the mail provider and try again.'
			});
		}

		// A targeted update, not draft.save(). save() validates the whole document,
		// so one unrelated legacy field — a draft carrying employmentType '' from
		// before blanks were stored as null — threw here, AFTER the candidate had
		// already received the letter. The draft then stayed 'draft', so the next
		// attempt emailed them again and failed again the same way.
		//
		// Recording what already happened must not be able to fail on the validity
		// of something else. Anything genuinely wrong with the draft has to stop
		// the send before the mail goes, not after.
		await OfferLetter.updateOne(
			{ _id: draft._id },
			{ $set: { status: 'sent', sentAt: new Date(), sentBy: locals.admin!.id } }
		);

		await audit({
			candidateId: params.id,
			actor: locals.admin!.email,
			action: 'offer_letter_sent',
			newValue: candidate.email,
			ip: getClientAddress()
		});

		// WhatsApp notification that the offer letter has been emailed —
		// best-effort, must never block the send that already succeeded above.
		if (candidate.mobile) {
			await sendOfferLetterNotificationWA({
				mobile: candidate.mobile,
				candidateName: candidate.fullName || '',
				companyName: company?.name ?? brand.name,
				candidateEmail: candidate.email
			}).catch((err) => console.error('[wa] offer letter notification failed:', err));
		}

		return { offerLetterSent: true };
	}
};
