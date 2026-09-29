// The compensation annexure's shape and its arithmetic.
//
// Lives in shared/ rather than server/offer-letter/ because two callers need
// the same answer: the admin form's live preview in the browser and the PDF
// renderer on the server. It used to be server-only, so the form re-implemented
// the sums by hand — which is exactly how clause 1 and page 4 end up
// disagreeing. Both now call computeAnnexureTotals.

/** A recruiter-added row. The fixed rows below match the signed reference and
 *  are not stored; these are the ones HR adds per offer, so each carries its
 *  own label alongside its amount. */
export interface AnnexureExtra {
	label: string;
	pm: string;
}

/** Every fixed row is "P.M. figure, P.A. is derived" — the label is boilerplate
 *  matching the signed reference and is not stored. Components only some offers
 *  carry (a shift allowance, a special allowance, an advance performance bonus)
 *  used to be fixed rows too, and printed as 0.00 on every offer that did not
 *  use them; they are added per offer as `extraCash` rows instead. */
export interface CompensationAnnexure {
	enabled: boolean;
	/** The monthly gross HR starts from. Typing it fills every row below from
	 *  GROSS_RULES; the rows stay editable afterwards. Optional so annexures
	 *  saved before it existed — and every caller that builds one — still fit. */
	grossPm?: string;
	/** LTA is on every offer unless HR removes it. Undefined is "on", so a
	 *  draft saved before the row could be removed keeps its LTA. */
	ltaEnabled?: boolean;
	basicPm: string;
	hraPm: string;
	ltaPm: string;
	pfPm: string;
	gratuityPm: string;
	insurancePm: string;
	foodPm: string;
	/** Variable Pay is not every offer's structure, so it carries its own
	 *  enable flag independent of the annexure's overall `enabled` — HR adds
	 *  or removes it per offer without affecting the rest of the table. When
	 *  on, it renders both as its own cash-component row and as an extra
	 *  "Total Cash Compensation with VP" row (Total Cash Before PF + VP)
	 *  directly below the existing before-PF subtotal. */
	variablePayEnabled: boolean;
	variablePayPm: string;
	/** What the variable pay is for, typed by HR. Printed in brackets after the
	 *  row's name — "Variable Pay (Quarterly sales target)". Optional so older
	 *  annexures, which have none, still print plain "Variable Pay". */
	variablePayReason?: string;
	/** Rows HR adds beyond the fixed ones, per section. Every pay structure the
	 *  reference covers fits the fixed rows; these exist for the ones it does
	 *  not (a retention bonus, a second insurance, a car allowance) without
	 *  needing a schema change or a deploy each time. */
	extraCash: AnnexureExtra[];
	extraVariable: AnnexureExtra[];
	extraNonCash: AnnexureExtra[];
}

/** The three rows that used to be fixed cash components. Retained only so a
 *  draft saved before they were removed carries its amounts forward as
 *  `extraCash` rows, under the names HR already saw — see
 *  offerLetterInputFromDraft. Nothing writes these fields any more. */
export const RETIRED_CASH_ROWS = [
	{ amountField: 'bonusPm', labelField: 'bonusLabel', label: 'Performance Bonus in Advance' },
	{ amountField: 'shiftPm', labelField: 'shiftLabel', label: 'Shift Allowances' },
	{ amountField: 'specialPm', labelField: null, label: 'Special Allowances' }
] as const;

export const EMPTY_COMPENSATION_ANNEXURE: CompensationAnnexure = {
	enabled: false,
	grossPm: '',
	ltaEnabled: true,
	basicPm: '',
	hraPm: '',
	ltaPm: '',
	pfPm: '',
	gratuityPm: '',
	insurancePm: '',
	foodPm: '',
	variablePayEnabled: false,
	variablePayPm: '',
	variablePayReason: '',
	extraCash: [],
	extraVariable: [],
	extraNonCash: []
};

/** A single computed annexure line: label, P.M. as typed, P.A. derived as
 *  P.M. x 12. Amounts that don't parse as a number are treated as 0 so a
 *  half-filled draft still renders a table instead of throwing. */
export interface AnnexureLine {
	label: string;
	pm: number;
	pa: number;
}

export function annexureNumber(raw: string): number {
	const n = parseFloat((raw ?? '').replace(/[^0-9.]/g, ''));
	return isNaN(n) ? 0 : n;
}

export interface AnnexureTotals {
	cash: AnnexureLine[];
	cashTotalPm: number;
	cashTotalPa: number;
	/** The Variable Pay rows — the fixed one plus anything HR added. Empty when
	 *  Variable Pay is off. Kept out of `cash` so "Total Cash Compensation
	 *  (Before PF)" stays VP-exclusive as its name promises, and "...with VP" is
	 *  a genuinely additional row rather than restating the same subtotal. */
	variablePay: AnnexureLine[];
	/** cashTotal + every variable-pay row — null when Variable Pay is off. */
	cashWithVpTotalPm: number | null;
	cashWithVpTotalPa: number | null;
	nonCash: AnnexureLine[];
	nonCashTotalPm: number;
	nonCashTotalPa: number;
	grandTotalPm: number;
	grandTotalPa: number;
}

/** Only rows with a label are counted. A half-typed extra — an amount with no
 *  name yet — would otherwise print as a nameless row on the certificate and
 *  silently move the totals. */
function extraLines(extras: AnnexureExtra[] | undefined, line: (l: string, p: string) => AnnexureLine) {
	return (extras ?? []).filter((e) => e.label?.trim()).map((e) => line(e.label.trim(), e.pm));
}

/** "Variable Pay", with HR's reason in brackets when they gave one. */
export function variablePayLabel(a: Pick<CompensationAnnexure, 'variablePayReason'>): string {
	const reason = (a.variablePayReason ?? '').trim();
	return reason ? `Variable Pay (${reason})` : 'Variable Pay';
}

/** Derives every P.A. figure and both subtotal/grand-total rows from the P.M.
 *  values HR entered — pure, so the admin form and the PDF renderer compute
 *  from one source of truth and can never disagree. */
export function computeAnnexureTotals(a: CompensationAnnexure): AnnexureTotals {
	const line = (label: string, pmRaw: string): AnnexureLine => {
		const pm = annexureNumber(pmRaw);
		return { label, pm, pa: pm * 12 };
	};

	const cash: AnnexureLine[] = [
		line('Basic Salary', a.basicPm),
		line('House Rent Allowance', a.hraPm),
		...(a.ltaEnabled === false ? [] : [line('LTA', a.ltaPm)]),
		...extraLines(a.extraCash, line)
	];
	const nonCash: AnnexureLine[] = [
		line('PF- Employer Contribution', a.pfPm),
		line('Gratuity', a.gratuityPm),
		line('Insurance', a.insurancePm),
		line('Food, Recreation & Longevity Membership', a.foodPm),
		...extraLines(a.extraNonCash, line)
	];

	const sum = (lines: AnnexureLine[], key: 'pm' | 'pa') => lines.reduce((s, l) => s + l[key], 0);
	const cashTotalPm = sum(cash, 'pm');
	const cashTotalPa = sum(cash, 'pa');
	const nonCashTotalPm = sum(nonCash, 'pm');
	const nonCashTotalPa = sum(nonCash, 'pa');

	// The extra variable rows ride on the same enable flag as the fixed one:
	// Variable Pay is one section, and showing HR's additions while the section
	// is switched off would be a table that contradicts its own heading.
	const variablePay: AnnexureLine[] = a.variablePayEnabled
		? [line(variablePayLabel(a), a.variablePayPm), ...extraLines(a.extraVariable, line)]
		: [];
	const vpPm = sum(variablePay, 'pm');
	const vpPa = sum(variablePay, 'pa');

	return {
		cash,
		cashTotalPm,
		cashTotalPa,
		variablePay,
		cashWithVpTotalPm: variablePay.length ? cashTotalPm + vpPm : null,
		cashWithVpTotalPa: variablePay.length ? cashTotalPa + vpPa : null,
		nonCash,
		nonCashTotalPm,
		nonCashTotalPa,
		grandTotalPm: cashTotalPm + nonCashTotalPm + vpPm,
		grandTotalPa: cashTotalPa + nonCashTotalPa + vpPa
	};
}

// ── filling the annexure from the gross ─────────────────────────────────────
//
// HR's salary rules, in one place so the numbers can be read and changed
// without touching the form. Every amount is per month, like the P.M. column.
export const GROSS_RULES = {
	/** Basic is half the gross, and never below the floor. */
	basicShareOfGross: 0.5,
	basicMinPm: 15000,
	/** HRA is half of Basic, and never below the floor. */
	hraShareOfBasic: 0.5,
	hraMinPm: 7500,
	/** On every offer unless HR removes the row. */
	ltaPm: 1250,
	/** Employer PF: the higher figure once Basic reaches the threshold. */
	pfBasicThresholdPm: 25000,
	pfHighPm: 3000,
	pfLowPm: 1800,
	/** round(gross x 40% / 26 x 15 x 0.0833) */
	gratuityShareOfGross: 0.4,
	insurancePm: 1950,
	/** Food, Recreation & Longevity Membership, per month. */
	longevityPm: 19500
} as const;

/** An amount as the form holds it: whole rupees print without decimals. */
function amount(v: number): string {
	const r = Math.round(v * 100) / 100;
	return Number.isInteger(r) ? String(r) : r.toFixed(2);
}

/** Fills the fixed rows from the annexure's `grossPm`. Special Allowances is
 *  deliberately not one of them: HR adds it by hand to bring the cash total up
 *  to the gross, so it is theirs to set. Everything else HR entered — added
 *  rows, Variable Pay, whether LTA is on — is left as it was. A gross that is
 *  blank or zero changes nothing. */
export function structureFromGross(a: CompensationAnnexure): CompensationAnnexure {
	const gross = annexureNumber(a.grossPm ?? '');
	if (gross <= 0) return a;
	const R = GROSS_RULES;

	const basic = Math.max(gross * R.basicShareOfGross, R.basicMinPm);
	const hra = Math.max(basic * R.hraShareOfBasic, R.hraMinPm);
	const pf = basic >= R.pfBasicThresholdPm ? R.pfHighPm : R.pfLowPm;
	const gratuity = Math.round(((gross * R.gratuityShareOfGross) / 26) * 15 * 0.0833);

	return {
		...a,
		basicPm: amount(basic),
		hraPm: amount(hra),
		ltaPm: a.ltaEnabled === false ? a.ltaPm : amount(R.ltaPm),
		pfPm: amount(pf),
		gratuityPm: amount(gratuity),
		insurancePm: amount(R.insurancePm),
		foodPm: amount(R.longevityPm)
	};
}
