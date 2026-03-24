import type { AtlasView } from "../types";
import type { AtlasNavItem } from "./atlas-layout.types";
import { Tooltip } from "./ui";

type AtlasSidebarProps = {
	primaryViews: AtlasNavItem[];
	settingsView?: AtlasNavItem;
	activeView: AtlasView;
	onChangeView: (view: AtlasView) => void;
};

export function AtlasSidebar({ primaryViews, settingsView, activeView, onChangeView }: AtlasSidebarProps) {
	return (
		<nav className="flex h-full w-full flex-col items-center justify-between gap-3 border-r border-neutral-200 bg-neutral-50 py-2 dark:border-neutral-700 dark:bg-neutral-800">
			<div className="grid w-14 justify-items-stretch gap-1.5">
				{primaryViews.map((item) => {
					const isActive = activeView === item.id;
					const Icon = isActive ? item.solidIcon : item.outlineIcon;
					return (
						<Tooltip
							key={item.id}
							content={item.label}
							side="right"
						>
							<button
								onClick={() => onChangeView(item.id)}
								className={`inline-flex aspect-square w-full items-center justify-center border border-transparent transition-all ${
									isActive ? "text-primary" : "text-neutral-300 hover:text-primary"
								}`}
								aria-label={item.label}
							>
								<Icon className="h-6 w-6" />
							</button>
						</Tooltip>
					);
				})}
			</div>
			{settingsView && (
				<div className="grid w-14 justify-items-stretch gap-1.5">
					{(() => {
						const isSettingsActive = activeView === settingsView.id;
						const SettingsIcon = isSettingsActive ? settingsView.solidIcon : settingsView.outlineIcon;
						return (
							<Tooltip
								content={settingsView.label}
								side="right"
							>
								<button
									onClick={() => onChangeView(settingsView.id)}
									className={`inline-flex aspect-square w-full items-center justify-center transition-all ${
										isSettingsActive ? "text-primary" : "text-neutral-300 hover:text-primary"
									}`}
									aria-label={settingsView.label}
								>
									<SettingsIcon className="h-6 w-6" />
								</button>
							</Tooltip>
						);
					})()}
				</div>
			)}
		</nav>
	);
}
