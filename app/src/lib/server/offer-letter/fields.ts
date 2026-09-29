// Maps DB documents + recruiter input onto the exact `[Placeholder]` keys the
// offer letter template expects. Pure mapping — no persistence, no I/O.
import type { CandidateDoc, OfferLetterDoc } from '$lib/server/db/schema';
import { COMPENSATION_FIELD_BY_TRACK, TRACKS, type Track } from '$lib/shared/matrix';
// The annexure's shape and arithmetic live in shared/ so the admin form's live
// preview computes them the same way the PDF does. Re-exported here because
// this module has always been the offer letter's front door.
import {
	EMPTY_COMPENSATION_ANNEXURE,
	RETIRED_CASH_ROWS,
	annexureNumber,
	type AnnexureExtra,
	type CompensationAnnexure
} from '$lib/shared/annexure';

export {
	computeAnnexureTotals,
	EMPTY_COMPENSATION_ANNEXURE,
	type AnnexureExtra,
	type AnnexureLine,
	type AnnexureTotals,
	type CompensationAnnexure
} from '$lib/shared/annexure';

export const EMPLOYMENT_TYPE_LABELS = {
	full_time: 'Full-time',
	part_time: 'Part-time',
	contract: 'Contract',
	consultant: 'Consultant'
} as const;

export type EmploymentType = keyof typeof EMPLOYMENT_TYPE_LABELS;

/** What the covering email calls the attached document, per track — cosmetic
 *  only: every track attaches the same "Employment Offer Letter" .docx. */
export const LETTER_TYPE_BY_TRACK: Record<Track, string> = {
	intern: 'Internship Letter',
	fresher: 'Offer Letter',
	experienced: 'Offer Letter',
	consultant: 'Consultant Letter',
	contract: 'Contract Letter'
};

/** Compensation field label per track — same underlying `ctcAmount` DB field.
 *  Derived from the shared definition the admin form renders, so the label a
 *  recruiter reads and the one quoted elsewhere cannot drift apart. */
export const COMPENSATION_LABEL_BY_TRACK: Record<Track, string> = Object.fromEntries(
	TRACKS.map((t) => [t, COMPENSATION_FIELD_BY_TRACK[t].label])
) as Record<Track, string>;

/** One super-admin hand-edit to the letter: the text that replaces a single
 *  rendered block, addressed by the stable key that block carries in the
 *  renderer (see `editable()` in pdf.ts). An empty `text` removes the block
 *  from the letter entirely rather than drawing a blank line.
 *
 *  Stored as a list rather than a map because the keys are dotted
 *  (`app.clause.5`) and Mongo rejects dots in document field names. */
export interface ManualEdit {
	key: string;
	text: string;
}

/** A block a super admin added to the letter, anchored to the block it follows.
 *  Anchored rather than positioned by index so that inserting a clause into the
 *  template later cannot shuffle someone's addition to a different place in
 *  their letter — the same reasoning that makes overrides key-addressed. */
export interface ManualAddition {
	/** Stable per addition, so the editor can track a row it has not saved yet. */
	id: string;
	/** Key of the rendered block this one is drawn after. An addition whose
	 *  anchor this letter does not draw is dormant, and the editor surfaces it. */
	afterKey: string;
	kind: ManualAdditionKind;
	/** Clause number/letter as it should print ("11.", "n)"). Clauses only. */
	marker: string;
	text: string;
}

/** What an added block can be. Deliberately the shapes the letters already use,
 *  so an addition is indistinguishable from template wording on the page. */
export const MANUAL_ADDITION_KINDS = ['para', 'clause', 'bullet', 'subheading'] as const;
export type ManualAdditionKind = (typeof MANUAL_ADDITION_KINDS)[number];

export const MANUAL_ADDITION_KIND_LABELS: Record<ManualAdditionKind, string> = {
	para: 'Paragraph',
	clause: 'Numbered clause',
	bullet: 'Bullet',
	subheading: 'Heading'
};

export function isManualAdditionKind(v: string): v is ManualAdditionKind {
	return (MANUAL_ADDITION_KINDS as readonly string[]).includes(v);
}

/** Caps on the stored overrides. A letter has ~60 editable blocks, so 200
 *  leaves room for keys kept from other tracks' templates; the length cap is
 *  well past the longest clause any of the three letters carries. */
export const MAX_MANUAL_EDITS = 200;
export const MAX_MANUAL_EDIT_CHARS = 4000;
/** Additions are whole new clauses, so a lower cap: past a few dozen the letter
 *  is not the template with exceptions any more, and wants its own template. */
export const MAX_MANUAL_ADDITIONS = 50;

/** Overrides keyed for lookup, dropping anything blank-keyed or over-long. The
 *  renderer takes this shape; everything else stores and passes the list. */
export function manualEditMap(edits: ManualEdit[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const e of edits.slice(0, MAX_MANUAL_EDITS)) {
		const key = e.key?.trim();
		if (!key) continue;
		out[key] = String(e.text ?? '').slice(0, MAX_MANUAL_EDIT_CHARS);
	}
	return out;
}

export interface OfferLetterInput {
	jobTitle: string;
	department: string;
	reportingManager: string;
	officeLocation: string;
	joiningDate: string;
	endDate: string;
	employmentType: EmploymentType | '';
	ctcAmount: string;
	/** Offer-of-appointment only: the monthly take-home quoted alongside annual
	 *  CTC in clause 1. Not CTC/12 — the real letters quote an independent
	 *  figure — so it is entered, never derived. */
	monthlyCompensation: string;
	noticePeriod: string;
	/** Offer-of-appointment clause 5: notice owed once probation is confirmed.
	 *  Bold in the signed letters and distinct from `noticePeriod` (which applies
	 *  during probation), so it is its own field rather than a fixed string. */
	confirmedNoticePeriod: string;
	acceptanceDueDate: string;
	signatoryName: string;
	signatoryDesignation: string;
	/** PNG/JPG signature image stored as a data-URI (base64). Optional. */
	signatoryImageBase64: string;
	/** Consultant/contract: clause-3 weekly expectation line (e.g. "Minimum 04 Content per Week"). */
	weeklyExpectation: string;
	/** Consultant/contract: clause-4 key responsibilities, one bullet per line. */
	keyResponsibilities: string;
	/** Intern-only: the Intern Agreement evaluation criteria, one bullet per
	 *  line. Recruiter-editable per intern (the profile differs by team), so it
	 *  is stored rather than fixed in the template. Blank → DEFAULT_INTERN_CRITERIA. */
	internCriteria: string;
	/** Consultant/contract: the clause-5 payment sentence, editable in full because
	 *  fee structures vary per consultant. `{amount}` is substituted with the
	 *  formatted `ctcAmount`, so the fee tracks that field unless the recruiter
	 *  writes an explicit figure. Blank → DEFAULT_CONSULTANT_PAYMENT_CLAUSE. */
	paymentClause: string;
	/** Offer-of-appointment tracks only: the page-4 compensation annexure. */
	compensationAnnexure: CompensationAnnexure;
	/** Super-admin-only hand-edits to the letter's own wording, one per rendered
	 *  block. Empty for almost every letter: the fields above cover the normal
	 *  case, and this exists for the offer that has to say something the
	 *  template does not. See MANUAL EDITS in pdf.ts. */
	manualEdits: ManualEdit[];
	/** Super-admin-only blocks added to the letter, each anchored after an
	 *  existing one. Empty for almost every letter. */
	manualAdditions: ManualAddition[];
}

/** The four criteria the signed internship agreements carry. Used to pre-fill
 *  the recruiter's textarea and as the fallback when it is left blank. */
export const DEFAULT_INTERN_CRITERIA = [
	'Hands-on experience in innovative tech projects.',
	'Collaboration with a diverse and dynamic team.',
	'Learning opportunities through workshops and training sessions.',
	'Exposure to cutting-edge technologies and industry trends.'
].join('\n');

/** The clause-5 payment sentence the signed consultant agreements carry. Used to
 *  pre-fill the recruiter's textarea and as the fallback when it is left blank.
 *  `{amount}` is replaced with the formatted `ctcAmount` at render time. */
export const DEFAULT_CONSULTANT_PAYMENT_CLAUSE =
	'You shall be paid as Total sum of {amount}/- per month which is subject to standard deduction as per the State and Govt Policy and TDS certificate will be given on timely basis.';

/** Fields every letter needs, whatever the track. */
const REQUIRED_ALL_TRACKS: Array<Exclude<keyof OfferLetterInput, 'compensationAnnexure' | 'manualEdits' | 'manualAdditions'>> = [
	'jobTitle',
	'department',
	'reportingManager',
	'officeLocation',
	'joiningDate',
	'employmentType',
	'ctcAmount',
	'acceptanceDueDate',
	'signatoryName',
	'signatoryDesignation'
];

/** What each track additionally needs, mirroring the field its letter renders and
 *  the admin form shows. Required-ness must stay track-aware: a field the
 *  recruiter cannot see must never block sending, and one the letter quotes must
 *  never be silently blank. */
export function requiredOfferLetterFields(track: Track): Array<Exclude<keyof OfferLetterInput, 'compensationAnnexure' | 'manualEdits' | 'manualAdditions'>> {
	switch (track) {
		// The internship agreement quotes an end date, and terminates "without any
		// notice" — so it needs endDate and has no notice period at all.
		case 'intern':
			return [...REQUIRED_ALL_TRACKS, 'endDate'];
		// Clause 9 quotes a notice period; clauses 3 and 4 are per-person.
		case 'consultant':
		case 'contract':
			return [...REQUIRED_ALL_TRACKS, 'noticePeriod', 'weeklyExpectation', 'keyResponsibilities'];
		// Appointment letter clause 5 quotes the probation notice period.
		default:
			return [...REQUIRED_ALL_TRACKS, 'noticePeriod'];
	}
}

export const OFFER_LETTER_FIELD_LABELS: Record<keyof OfferLetterInput, string> = {
	jobTitle: 'Job title',
	department: 'Department',
	reportingManager: "Reporting manager's name/designation",
	officeLocation: 'Office location',
	joiningDate: 'Joining date',
	endDate: 'End date',
	employmentType: 'Employment type',
	ctcAmount: 'CTC amount',
	monthlyCompensation: 'Monthly compensation',
	noticePeriod: 'Notice period (during probation)',
	confirmedNoticePeriod: 'Notice period (after confirmation)',
	acceptanceDueDate: 'Acceptance due date',
	signatoryName: 'Authorized signatory name',
	signatoryDesignation: "Signatory's designation",
	signatoryImageBase64: 'Signature image',
	weeklyExpectation: 'Weekly expectation',
	keyResponsibilities: 'Key responsibilities',
	internCriteria: 'Intern evaluation criteria',
	paymentClause: 'Payment clause',
	// Never required (requiredOfferLetterFields never returns this key — the
	// annexure is opt-in), but every OfferLetterInput key needs a label entry.
	compensationAnnexure: 'Compensation annexure',
	manualEdits: 'Manual edits',
	manualAdditions: 'Added blocks'
};

export function missingOfferLetterFields(input: OfferLetterInput, track: Track): string[] {
	return requiredOfferLetterFields(track)
		.filter((key) => !input[key].trim())
		.map((key) =>
			// Name the compensation field the way this track's form labels it, so
			// "missing: CTC amount" cannot point an intern's recruiter at a field
			// their form calls "Stipend (monthly)".
			key === 'ctcAmount'
				? COMPENSATION_FIELD_BY_TRACK[track].label
				: OFFER_LETTER_FIELD_LABELS[key]
		);
}

/** Mongoose gives back subdocuments, not plain objects, so each extra row is
 *  copied down to the two fields the annexure actually uses. */
function extras(raw: unknown): AnnexureExtra[] {
	if (!Array.isArray(raw)) return [];
	return raw.map((r) => {
		const e = r as { label?: string | null; pm?: string | null };
		return { label: e.label ?? '', pm: e.pm ?? '' };
	});
}

/** Carries the three retired fixed cash rows (Performance Bonus in Advance,
 *  Shift Allowances, Special Allowances) forward as recruiter-added rows.
 *
 *  A draft saved while they were still fixed rows has its amounts in fields
 *  nothing reads any more, so dropping them outright would quietly cut those
 *  figures out of the annexure — and out of the CTC derived from it — on a
 *  letter that may already have been discussed with the candidate. Rows worth
 *  nothing are simply forgotten, which is the point of removing them. The next
 *  save replaces the whole subdocument and the legacy fields go with it, so
 *  this runs at most once per draft; the label check makes a repeat harmless
 *  either way. */
function migrateRetiredCashRows(annexure: unknown, existing: AnnexureExtra[]): AnnexureExtra[] {
	const legacy = (annexure ?? {}) as Record<string, unknown>;
	const taken = new Set(existing.map((e) => e.label.trim().toLowerCase()));
	const carried: AnnexureExtra[] = [];

	for (const row of RETIRED_CASH_ROWS) {
		const pm = String(legacy[row.amountField] ?? '').trim();
		if (!pm || annexureNumber(pm) === 0) continue;
		const label =
			(row.labelField ? String(legacy[row.labelField] ?? '').trim() : '') || row.label;
		if (taken.has(label.toLowerCase())) continue;
		taken.add(label.toLowerCase());
		carried.push({ label, pm });
	}
	return carried;
}

/** Same subdocument-to-plain-object copy as `extras`, for the stored manual
 *  edits. A row with no key is dropped: it can only be a stale write. */
function manualEdits(raw: unknown): ManualEdit[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((r) => {
			const e = r as { key?: string | null; text?: string | null };
			return { key: e.key ?? '', text: e.text ?? '' };
		})
		.filter((e) => e.key.trim());
}

/** Same subdocument copy as `manualEdits`, for the added blocks. A row with no
 *  anchor or an unknown kind is dropped: it could only be a stale write, and a
 *  block with nowhere to go would never render anyway. */
function manualAdditions(raw: unknown): ManualAddition[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((r) => {
			const a = r as Partial<Record<keyof ManualAddition, string>>;
			return {
				id: a.id ?? '',
				afterKey: a.afterKey ?? '',
				kind: (a.kind ?? 'para') as ManualAdditionKind,
				marker: a.marker ?? '',
				text: a.text ?? ''
			};
		})
		.filter((a) => a.id.trim() && a.afterKey.trim() && isManualAdditionKind(a.kind));
}

export function offerLetterInputFromDraft(draft: OfferLetterDoc | null): OfferLetterInput {
	// Migrated rows lead, so a carried-forward component keeps its old position
	// above anything HR added by hand.
	const saved = extras(draft?.compensationAnnexure?.extraCash);
	const cash = [...migrateRetiredCashRows(draft?.compensationAnnexure, saved), ...saved];

	return {
		jobTitle: draft?.jobTitle ?? '',
		department: draft?.department ?? '',
		reportingManager: draft?.reportingManager ?? '',
		officeLocation: draft?.officeLocation ?? '',
		joiningDate: draft?.joiningDate ?? '',
		endDate: draft?.endDate ?? '',
		employmentType: (draft?.employmentType as EmploymentType | null) ?? '',
		ctcAmount: draft?.ctcAmount ?? '',
		monthlyCompensation: draft?.monthlyCompensation ?? '',
		noticePeriod: draft?.noticePeriod ?? '',
		confirmedNoticePeriod: draft?.confirmedNoticePeriod ?? '',
		acceptanceDueDate: draft?.acceptanceDueDate ?? '',
		signatoryName: draft?.signatoryName ?? '',
		signatoryDesignation: draft?.signatoryDesignation ?? '',
		signatoryImageBase64: draft?.signatoryImageBase64 ?? '',
		weeklyExpectation: draft?.weeklyExpectation ?? '',
		keyResponsibilities: draft?.keyResponsibilities ?? '',
		// Pre-fill the standard four so the recruiter edits a real list rather
		// than facing an empty box and retyping the boilerplate.
		internCriteria: draft?.internCriteria ?? DEFAULT_INTERN_CRITERIA,
		paymentClause: draft?.paymentClause ?? DEFAULT_CONSULTANT_PAYMENT_CLAUSE,
		compensationAnnexure: {
			enabled: draft?.compensationAnnexure?.enabled ?? false,
			grossPm: draft?.compensationAnnexure?.grossPm ?? '',
			ltaEnabled: draft?.compensationAnnexure?.ltaEnabled ?? true,
			basicPm: draft?.compensationAnnexure?.basicPm ?? '',
			hraPm: draft?.compensationAnnexure?.hraPm ?? '',
			ltaPm: draft?.compensationAnnexure?.ltaPm ?? '',
			pfPm: draft?.compensationAnnexure?.pfPm ?? '',
			gratuityPm: draft?.compensationAnnexure?.gratuityPm ?? '',
			insurancePm: draft?.compensationAnnexure?.insurancePm ?? '',
			foodPm: draft?.compensationAnnexure?.foodPm ?? '',
			variablePayEnabled: draft?.compensationAnnexure?.variablePayEnabled ?? false,
			variablePayPm: draft?.compensationAnnexure?.variablePayPm ?? '',
			variablePayReason: draft?.compensationAnnexure?.variablePayReason ?? '',
			extraCash: cash,
			extraVariable: extras(draft?.compensationAnnexure?.extraVariable),
			extraNonCash: extras(draft?.compensationAnnexure?.extraNonCash)
		},
		manualEdits: manualEdits(draft?.manualEdits),
		manualAdditions: manualAdditions(draft?.manualAdditions)
	};
}

export function isOfferLetterComplete(input: OfferLetterInput, track: Track): boolean {
	return requiredOfferLetterFields(track).every((key) => input[key].trim().length > 0);
}

export function buildOfferLetterFields(
	candidate: Pick<CandidateDoc, 'fullName' | 'email' | 'presentAddress'>,
	companyName: string,
	offer: OfferLetterInput
): Record<string, string> {
	const today = new Date().toLocaleDateString('en-GB').replace(/\//g, '/'); // DD/MM/YYYY
	const candidateName = candidate.fullName ?? candidate.email;

	return {
		'DD/MM/YYYY': today,
		'Candidate Name': candidateName,
		'Candidate Address': candidate.presentAddress ?? '',
		'Company Name': companyName,
		'Job Title': offer.jobTitle,
		'Department Name': offer.department,
		"Manager's Name/Designation": offer.reportingManager,
		'Office Location': offer.officeLocation,
		'Joining Date': offer.joiningDate,
		'Full-time/Part-time/Contract': offer.employmentType ? EMPLOYMENT_TYPE_LABELS[offer.employmentType] : '',
		Amount: offer.ctcAmount,
		'Notice Period': offer.noticePeriod,
		'Acceptance Due Date': offer.acceptanceDueDate,
		'Authorized Signatory': offer.signatoryName,
		Designation: offer.signatoryDesignation
	};
}
