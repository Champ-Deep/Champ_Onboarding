// The shapes the assistant panel draws for team requests. Shared so the server
// that builds them and the component that renders them cannot drift apart.

export type RequestAction = 'approve' | 'reject' | 'done' | 'decline' | 'cancel';

export interface RequestView {
	id: string;
	kind: 'access' | 'task';
	status: 'pending' | 'approved' | 'rejected' | 'done' | 'declined' | 'cancelled';
	fromEmail: string;
	fromName: string | null;
	toEmail: string | null;
	toName: string | null;
	capability: string | null;
	capabilityLabel: string | null;
	level: string | null;
	levelAtRequest: string | null;
	/** False when the capability has no control behind it in the app yet. */
	implemented: boolean;
	title: string | null;
	candidateId: string | null;
	candidateName: string | null;
	dueAt: string | null;
	note: string | null;
	createdAt: string;
	decidedBy: string | null;
	decidedAt: string | null;
	decisionNote: string | null;
	/** What the person looking at this card may do to it. Worked out on the
	 *  server for that viewer, and checked again when they do it. */
	can: RequestAction[];
}

export interface Inbox {
	/** Needs this person's decision or work. */
	waiting: RequestView[];
	/** Raised by this person, open or recently settled. */
	mine: RequestView[];
	/** Settled items this person was on the receiving end of: tasks given to
	 *  them (including withdrawn ones, which would otherwise light the badge
	 *  with nothing to show) and requests they decided. */
	recent: RequestView[];
	/** Launcher badge: things waiting on them, plus outcomes they have not seen. */
	badge: number;
}

/** A card the assistant drafted. Nothing exists until someone presses Send. */
export type Draft =
	| {
			kind: 'access';
			capability: string;
			capabilityLabel: string;
			from: string;
			to: string;
			note: string | null;
			implemented: boolean;
	  }
	| {
			kind: 'task';
			toEmail: string;
			toName: string | null;
			title: string;
			candidateId: string | null;
			candidateName: string | null;
			dueAt: string | null;
			note: string | null;
	  };
