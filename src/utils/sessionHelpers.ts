import type { Session } from "../types";

export const sessionElapsedMs = (session: Session, now: number) => {
	const started = new Date(session.started_at).getTime();
	const ended = session.ended_at ? new Date(session.ended_at).getTime() : now;
	let paused = session.paused_duration;
	if (session.is_active && session.is_paused && session.pause_started_at) {
		paused += Math.max(0, now - new Date(session.pause_started_at).getTime());
	}
	return Math.max(0, ended - started - paused);
};
