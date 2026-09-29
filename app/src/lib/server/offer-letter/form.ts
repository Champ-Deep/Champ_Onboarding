// Parses the admin offer-letter form into an OfferLetterInput.
//
// Shared rather than inlined in the save action because two callers need the
// exact same reading of the same form: `?/saveOfferLetter`, which persists it,
// and the preview endpoint, which renders it to a PDF without saving. If they
// parsed the form separately, a preview could show something the letter that
// eventually goes out does not say — which is the one thing a preview must
// never do.
import {
	computeAnnexureTotals,
	isManualAdditionKind,
	MAX_MANUAL_ADDITIONS,
	MAX_MANUAL_EDITS,
	MAX_MANUAL_EDIT_CHARS,
	type AnnexureExtra,
	type ManualAddition,
	type ManualEdit,
	type OfferLetterInput
} from './fields';
import { isoToDDMMYYYY } from '$lib/shared/dates';

const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;
const SIGNATURE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export type OfferLetterFormResult =
	| { ok: true; input: OfferLetterInput }
	| { ok: false; error: string };

/** The recruiter-added annexure rows. Posted as repeated fields rather than
 *  indexed names, so getAll pairs label to amount by position and removing a
 *  row in the middle needs no renumbering. A row with no label is dropped: it
 *  is a half-typed addition, not a component. */
function extraRows(form: FormData, name: string): AnnexureExtra[] {
	const labels = form.getAll(`${name}Label`).map((v) => String(v ?? '').trim());
	const amounts = form.getAll(`${name}Pm`).map((v) => String(v ?? '').trim());
	return labels
		.map((label, i) => ({ label, pm: amounts[i] ?? '' }))
		.filter((r) => r.label)
		.slice(0, 30);
}

/** The super admin's hand-edits to the letter's wording, posted the same way
 *  the annexure's extra rows are: one repeated `manualEditKey` / `manualEditText`
 *  pair per override, paired by position.
 *
 *  Unknown keys are kept rather than validated against the current template --
 *  an override for a block this track's letter does not draw (HR switched the
 *  track, or the annexure page is toggled off) is dormant, not wrong, and
 *  silently dropping it would lose a deliberate edit the moment someone saves
 *  an unrelated field. The editor offers to clear the dormant ones instead.
 *
 *  Callers must not trust this on its own: only a super admin may hand-edit a
 *  letter, and both call sites substitute the saved list for a lesser role's
 *  post (see saveOfferLetter and the preview endpoint). */
function manualEditRows(form: FormData): ManualEdit[] {
	const keys = form.getAll('manualEditKey').map((v) => String(v ?? '').trim());
	const texts = form.getAll('manualEditText').map((v) => String(v ?? ''));
	const seen = new Set<string>();
	const rows: ManualEdit[] = [];
	for (const [i, key] of keys.entries()) {
		if (!key || seen.has(key)) continue;
		seen.add(key);
		rows.push({ key, text: (texts[i] ?? '').slice(0, MAX_MANUAL_EDIT_CHARS) });
		if (rows.length >= MAX_MANUAL_EDITS) break;
	}
	return rows;
}

/** The blocks the super admin added, posted as five repeated fields paired by
 *  position — the same shape as the annexure's extra rows and the overrides
 *  above. A row with no anchor, no id, or an unrecognised kind is dropped: it
 *  has nowhere to render, so keeping it would only be a stale row that never
 *  appears in the letter or the editor.
 *
 *  Subject to the same role rule as the overrides: only a super admin may add
 *  to a letter, and both call sites substitute the saved list for anyone
 *  else's post. */
function manualAdditionRows(form: FormData): ManualAddition[] {
	const ids = form.getAll('manualAddId').map((v) => String(v ?? '').trim());
	const afters = form.getAll('manualAddAfter').map((v) => String(v ?? '').trim());
	const kinds = form.getAll('manualAddKind').map((v) => String(v ?? '').trim());
	const markers = form.getAll('manualAddMarker').map((v) => String(v ?? '').trim());
	const texts = form.getAll('manualAddText').map((v) => String(v ?? ''));
	const seen = new Set<string>();
	const rows: ManualAddition[] = [];
	for (const [i, id] of ids.entries()) {
		const afterKey = afters[i] ?? '';
		const kind = kinds[i] ?? 'para';
		if (!id || !afterKey || seen.has(id) || !isManualAdditionKind(kind)) continue;
		seen.add(id);
		rows.push({
			id,
			afterKey,
			kind,
			marker: (markers[i] ?? '').slice(0, 12),
			text: (texts[i] ?? '').slice(0, MAX_MANUAL_EDIT_CHARS)
		});
		if (rows.length >= MAX_MANUAL_ADDITIONS) break;
	}
	return rows;
}

export async function offerLetterInputFromForm(form: FormData): Promise<OfferLetterFormResult> {
	// Signature image upload — converted to a base64 data-URI. With no new file,
	// the existing value carried by the hidden field is preserved.
	let signatoryImageBase64 = String(form.get('signatoryImageBase64Existing') ?? '');
	const sigFile = form.get('signatoryImage');
	if (sigFile instanceof File && sigFile.size > 0) {
		if (sigFile.size > MAX_SIGNATURE_BYTES) {
			return { ok: false, error: 'Signature image must be under 2 MB.' };
		}
		if (!SIGNATURE_TYPES.includes(sigFile.type)) {
			return { ok: false, error: 'Signature must be a PNG, JPG, or WebP image.' };
		}
		const bytes = await sigFile.arrayBuffer();
		signatoryImageBase64 = `data:${sigFile.type};base64,${Buffer.from(bytes).toString('base64')}`;
	}

	const text = (key: string) => String(form.get(key) ?? '').trim();

	const compensationAnnexure = {
		enabled: form.get('annexureEnabled') === 'on',
		grossPm: text('annexureGrossPm'),
		// Posted as a hidden field rather than a checkbox, so a form that never
		// rendered the row (an older tab still open) reads as "on", not "off".
		ltaEnabled: form.get('annexureLtaEnabled') !== 'off',
		basicPm: text('annexureBasicPm'),
		hraPm: text('annexureHraPm'),
		ltaPm: text('annexureLtaPm'),
		pfPm: text('annexurePfPm'),
		gratuityPm: text('annexureGratuityPm'),
		insurancePm: text('annexureInsurancePm'),
		foodPm: text('annexureFoodPm'),
		variablePayEnabled: form.get('annexureVariablePayEnabled') === 'on',
		variablePayPm: text('annexureVariablePayPm'),
		variablePayReason: text('annexureVariablePayReason').slice(0, 80),
		extraCash: extraRows(form, 'extraCash'),
		extraVariable: extraRows(form, 'extraVariable'),
		extraNonCash: extraRows(form, 'extraNonCash')
	};

	// With the annexure on, its Total Yearly Cost to Company IS the CTC — the two
	// were separate boxes and could disagree, which meant clause 1 quoting one
	// figure and the annexure on page 4 totalling to another. Derived rather than
	// typed, so they cannot drift. The annexure only exists on the appointment
	// tracks, so every other letter still uses whatever was entered.
	const ctcAmount = compensationAnnexure.enabled
		? String(computeAnnexureTotals(compensationAnnexure).grandTotalPa)
		: text('ctcAmount');

	return {
		ok: true,
		input: {
			jobTitle: text('jobTitle'),
			department: text('department'),
			reportingManager: text('reportingManager'),
			officeLocation: text('officeLocation'),
			joiningDate: isoToDDMMYYYY(text('joiningDate')),
			// Both were free text before the picker landed, so isoToDDMMYYYY does
			// double duty: it converts what the date input submits and passes an
			// older hand-typed value through untouched.
			endDate: isoToDDMMYYYY(text('endDate')),
			employmentType: text('employmentType') as OfferLetterInput['employmentType'],
			ctcAmount,
			monthlyCompensation: text('monthlyCompensation'),
			noticePeriod: text('noticePeriod'),
			confirmedNoticePeriod: text('confirmedNoticePeriod'),
			acceptanceDueDate: isoToDDMMYYYY(text('acceptanceDueDate')),
			signatoryName: text('signatoryName'),
			signatoryDesignation: text('signatoryDesignation'),
			signatoryImageBase64,
			weeklyExpectation: text('weeklyExpectation'),
			keyResponsibilities: text('keyResponsibilities'),
			internCriteria: text('internCriteria'),
			paymentClause: text('paymentClause'),
			compensationAnnexure,
			manualEdits: manualEditRows(form),
			manualAdditions: manualAdditionRows(form)
		}
	};
}
