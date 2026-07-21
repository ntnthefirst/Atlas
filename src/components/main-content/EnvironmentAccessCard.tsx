import type { Environment, IsolationAllowlistEntry, IsolationMode } from "../../types";
import { Select } from "../ui";
import { ENCLOSED_STAYS_ISOLATED_ITEMS, buildConnectedSharedItems } from "../../utils/isolationMode";

type EnvironmentAccessCardProps = {
	environment: Environment | null;
	allowlist: IsolationAllowlistEntry[];
	onChangeMode: (mode: IsolationMode) => void;
};

// WP-1.2 (isolation enforcement UI) -- lives in the main Settings view rather
// than the quick environment-switcher popover (AtlasEnvironmentMenu.tsx):
// this is the one screen in the app whose whole job is to be read carefully
// and trusted, not glanced at inside a popover that closes the moment you
// click elsewhere. It always describes the CURRENTLY SELECTED environment
// (App.tsx keeps this in sync with the environment switcher elsewhere in the
// header), matching WP-1.1's framing of isolation mode as something each
// environment owns.
//
// The "what's shared right now" list below is built from `allowlist` --
// never a hand-written array in this file. `allowlist` comes straight off
// `isolation:getAllowlist`, which is itself a verbatim forward of
// electron/data/isolation.cjs's CROSS_ENVIRONMENT_ALLOWLIST + labels (see
// that module and src/utils/isolationMode.ts for the full chain). Widening
// the allowlist there is the only change ever needed to keep this list
// truthful.
export function EnvironmentAccessCard({ environment, allowlist, onChangeMode }: EnvironmentAccessCardProps) {
	if (!environment) {
		return (
			<section className="atlas-card grid gap-4">
				<header className="card-head">
					<h3 className="text-subtitle-small">Environment access</h3>
				</header>
				<p className="text-[13px] text-neutral-500 dark:text-neutral-300">
					Choose an environment to see and control what it can reach.
				</p>
			</section>
		);
	}

	const mode = environment.isolation_mode;
	const sharedItems = buildConnectedSharedItems(allowlist);

	return (
		<section className="atlas-card grid gap-4">
			<header className="card-head">
				<h3 className="text-subtitle-small">Environment access</h3>
				<p className="text-[11px] uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-300">
					{environment.name}
				</p>
			</header>

			<div className="grid gap-3">
				<Select
					label="Isolation mode"
					value={mode}
					onChange={(nextValue) => onChangeMode(nextValue as IsolationMode)}
					options={[
						{
							value: "connected",
							label: "Connected",
							description: "Has its own context, but learns from your other connected environments' aggregate signals.",
						},
						{
							value: "enclosed",
							label: "Enclosed",
							description: "Fully separated. Nothing about it crosses in or out, in either direction.",
						},
					]}
				/>

				{mode === "connected" ? (
					<div className="grid gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-600 dark:bg-neutral-700">
						<p className="text-[11px] uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-300">
							Shared right now, with your other connected environments
						</p>
						{sharedItems.length > 0 ? (
							<ul className="grid gap-1.5">
								{sharedItems.map((item, index) => (
									<li
										key={allowlist[index]?.signal ?? item}
										className="flex items-start gap-2 text-[13px] text-neutral-700 dark:text-neutral-100"
									>
										<span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
										<span>{item}</span>
									</li>
								))}
							</ul>
						) : (
							<p className="text-[13px] text-neutral-700 dark:text-neutral-100">Nothing, currently.</p>
						)}
						<p className="text-[11px] text-neutral-500 dark:text-neutral-300">
							Nothing else ever crosses -- no task, note, file, or activity content, only what's listed above.
						</p>
					</div>
				) : (
					<div className="grid gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-600 dark:bg-neutral-700">
						<p className="text-[11px] uppercase tracking-[0.14em] text-neutral-500 dark:text-neutral-300">
							Stays fully isolated
						</p>
						<ul className="grid grid-cols-2 gap-1.5">
							{ENCLOSED_STAYS_ISOLATED_ITEMS.map((item) => (
								<li key={item} className="flex items-start gap-2 text-[13px] text-neutral-700 dark:text-neutral-100">
									<span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
									<span>{item}</span>
								</li>
							))}
						</ul>
						<p className="text-[11px] text-neutral-500 dark:text-neutral-300">
							This environment sees nothing global, and nothing global sees it.
						</p>
					</div>
				)}
			</div>
		</section>
	);
}
