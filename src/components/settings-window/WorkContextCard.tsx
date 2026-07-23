import { useEffect, useState } from "react";
import { Select, Toggle } from "../ui";
import { describeIpcError } from "../../utils/ipcError";
import { EMPTY_CONTEXT_STATUS, describeContextStatus } from "./workContext";
import type { ContextStatus, WorkContext } from "../../types";

// ---------------------------------------------------------------------------
// WP-2.8's work-context adaptation, given the surface it never got. The
// service, the hysteresis, the IPC channels and the `context:<name>` layout
// resolution all shipped with that WP; without a control anywhere in the app
// there was no way to see what Atlas had decided, no way to pin it, and no
// hint that `context:coding` was a layout id you could configure -- so the
// feature was complete and dormant at the same time.
//
// Lives in the Smart Notch tab because that is what a context actually
// changes: context-service.cjs#resolveLayoutId maps the active context to a
// `context:<name>` row in the same `notch_layouts` table the rest of this tab
// edits.
//
// -- Why detection is off by default, and stays user-controlled -------------
// Detection polls the foreground window (context-service.cjs's own 4-second
// poll). That is a real, ongoing read of what the user is doing, so it gets an
// explicit switch rather than being quietly on: the toggle below is the
// feature, not a convenience.
// ---------------------------------------------------------------------------

export function WorkContextCard() {
	const [status, setStatus] = useState<ContextStatus>(EMPTY_CONTEXT_STATUS);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		window.atlas
			.getContextStatus()
			.then(setStatus)
			.catch((cause: unknown) => setError(describeIpcError(cause, "Couldn't read the work context.")));
	}, []);

	// Pushed from the main process, and only when the COMMITTED context
	// actually changes (or on pin/unpin) -- never on a candidate that failed to
	// hold, which is why this card needs no poll of its own.
	useEffect(() => window.atlas.onContextChanged(setStatus), []);

	const apply = (action: Promise<ContextStatus>) => {
		action.then(setStatus).catch((cause: unknown) => setError(describeIpcError(cause, "That didn't work.")));
	};

	return (
		<div className="atlas-settings-card-stack grid gap-2">
			<span className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-300">
				Work context
			</span>
			<p className="m-0 text-xs text-neutral-500 dark:text-neutral-300">
				Atlas can notice whether you&apos;re coding, in a conversation or browsing, and switch the notch to a layout
				you&apos;ve saved for that context. Save one under the layout name <code>context:coding</code>,{" "}
				<code>context:communication</code> or <code>context:browsing</code> and it will be used automatically.
				Without one, your environment&apos;s own layout keeps applying.
			</p>

			{error ? (
				<p className="m-0 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-300">{error}</p>
			) : null}

			<Toggle
				label="Notice what I'm working on"
				description="Checks which app is in front every few seconds. Off by default."
				checked={status.polling}
				onChange={(value) =>
					apply(value ? window.atlas.startContextDetection() : window.atlas.stopContextDetection())
				}
			/>

			<p className="m-0 text-xs text-neutral-500 dark:text-neutral-300">{describeContextStatus(status)}</p>

			<Select
				label="Pin to one context"
				value={status.pinnedContext ?? ""}
				onChange={(value) =>
					apply(value ? window.atlas.pinContext(value as WorkContext) : window.atlas.unpinContext())
				}
				options={[
					{ value: "", label: "Don't pin", description: "Let detection decide" },
					{ value: "coding", label: "Coding" },
					{ value: "communication", label: "Communication" },
					{ value: "browsing", label: "Browsing" },
				]}
			/>
		</div>
	);
}
