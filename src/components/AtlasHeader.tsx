import { useRef } from "react";
import { ArrowUpOnSquareStackIcon, PauseIcon, PlayCircleIcon, PlayIcon, StopIcon } from "@heroicons/react/24/outline";
import logo from "../assets/logosmall.png";
import {
	ArrowUpOnSquareStackIcon as ArrowUpOnSquareStackIconSolid,
	PauseIcon as PauseIconSolid,
	PlayCircleIcon as PlayCircleIconSolid,
	PlayIcon as PlayIconSolid,
	StopIcon as StopIconSolid,
} from "@heroicons/react/24/solid";
import type { MapItem, Session } from "../types";
import { AtlasMapMenu } from "./AtlasMapMenu";
import { Tooltip } from "./ui";

type AtlasHeaderProps = {
	isMacPlatform: boolean;
	selectedMapId: string;
	selectedMapName: string;
	maps: MapItem[];
	showMapMenu: boolean;
	renameMapName: string;
	newMapName: string;
	onToggleMapMenu: () => void;
	onCloseMapMenu: () => void;
	onSelectMap: (mapId: string) => void;
	onRenameMapNameChange: (nextValue: string) => void;
	onNewMapNameChange: (nextValue: string) => void;
	onCreateMap: () => void;
	onRenameMap: () => void;
	onDeleteMap: () => void;
	canDeleteMap: boolean;
	activeSession: Session | null;
	activeElapsed: string;
	canStartRecording: boolean;
	onStartSession: () => void;
	onPauseResume: () => void;
	onStopSession: () => void;
	onOpenMiniWindow: () => void;
};

export function AtlasHeader({
	isMacPlatform,
	selectedMapId,
	selectedMapName,
	maps,
	showMapMenu,
	renameMapName,
	newMapName,
	onToggleMapMenu,
	onCloseMapMenu,
	onSelectMap,
	onRenameMapNameChange,
	onNewMapNameChange,
	onCreateMap,
	onRenameMap,
	onDeleteMap,
	canDeleteMap,
	activeSession,
	activeElapsed,
	canStartRecording,
	onStartSession,
	onPauseResume,
	onStopSession,
	onOpenMiniWindow,
}: AtlasHeaderProps) {
	const triggerRef = useRef<HTMLButtonElement | null>(null);

	return (
		<header
			className={`titlebar sticky top-0 z-40 grid h-[50px] grid-cols-[1fr_1fr] items-center border-b border-neutral-200 bg-neutral-50 px-2.5 text-neutral-700 backdrop-blur-md [-webkit-app-region:drag] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 ${
				isMacPlatform ? "pl-[84px]" : "pr-[146px]"
			}`}
		>
			<div className="titlebar-left text-hero-small text-base flex min-w-0 items-center gap-2">
				<img
					src={logo}
					alt="Atlas Logo"
					className="h-7 w-7 flex-shrink-0"
				/>
				<span>Atlas</span>
			</div>

			<div className="titlebar-center left-1/2 absolute -translate-x-1/2 w-2/5 max-w-2xl min-w-96">
				<button
					ref={triggerRef}
					type="button"
					className="atlas-map-switcher inline-flex h-6 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-neutral-300 px-2.5 py-0.5 text-body-small text-neutral-700 transition hover:border-neutral-400 dark:border-neutral-500 dark:text-neutral-50"
					onClick={onToggleMapMenu}
					onKeyDown={(event) => {
						if (event.key === "ArrowDown" && !showMapMenu) {
							event.preventDefault();
							onToggleMapMenu();
						}
					}}
					aria-haspopup="dialog"
				>
					<span className="truncate text-neutral-800 dark:text-neutral-50">{selectedMapName}</span>
				</button>
				<AtlasMapMenu
					showMapMenu={showMapMenu}
					selectedMapId={selectedMapId}
					maps={maps}
					renameMapName={renameMapName}
					newMapName={newMapName}
					canDeleteMap={canDeleteMap}
					triggerRef={triggerRef}
					onCloseMapMenu={onCloseMapMenu}
					onSelectMap={onSelectMap}
					onRenameMapNameChange={onRenameMapNameChange}
					onNewMapNameChange={onNewMapNameChange}
					onCreateMap={onCreateMap}
					onRenameMap={onRenameMap}
					onDeleteMap={onDeleteMap}
				/>
			</div>

			<div className="titlebar-right no-drag flex min-w-0 items-center justify-self-end gap-2">
				{activeSession ? (
					<div className="recording-cluster active inline-flex min-w-0 items-center gap-2 rounded-[10px] border border-neutral-200 bg-neutral-0 p-0.5 dark:border-neutral-600 dark:bg-neutral-700/70">
						<span className="recording-timer top whitespace-nowrap rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-[5px] font-data text-data-regular text-neutral-700 dark:border-neutral-600 dark:bg-neutral-700/90 dark:text-neutral-100">
							{activeElapsed}
						</span>
						<Tooltip content={activeSession.is_paused ? "Resume recording" : "Pause recording"}>
							<button
								className="group inline-flex h-[31px] w-[31px] items-center justify-center rounded-lg border border-transparent bg-transparent text-neutral-700 transition-colors hover:bg-transparent hover:text-primary-hover dark:text-neutral-100 dark:hover:bg-transparent dark:hover:text-primary-hover"
								onClick={onPauseResume}
								aria-label={activeSession.is_paused ? "Resume recording" : "Pause recording"}
							>
								<span className="relative h-4 w-4">
									{activeSession.is_paused ? (
										<>
											<PlayIcon className="absolute inset-0 h-4 w-4 transition-opacity duration-150 group-hover:opacity-0" />
											<PlayIconSolid className="absolute inset-0 h-4 w-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
										</>
									) : (
										<>
											<PauseIcon className="absolute inset-0 h-4 w-4 transition-opacity duration-150 group-hover:opacity-0" />
											<PauseIconSolid className="absolute inset-0 h-4 w-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
										</>
									)}
								</span>
							</button>
						</Tooltip>
						<Tooltip content="Stop recording">
							<button
								className="group inline-flex h-[31px] w-[31px] items-center justify-center rounded-lg border border-transparent bg-transparent text-neutral-700 transition-colors hover:bg-transparent hover:text-secondary-hover dark:text-neutral-100 dark:hover:bg-transparent dark:hover:text-secondary-hover"
								onClick={onStopSession}
								aria-label="Stop recording"
							>
								<span className="relative h-4 w-4">
									<StopIcon className="absolute inset-0 h-4 w-4 transition-opacity duration-150 group-hover:opacity-0" />
									<StopIconSolid className="absolute inset-0 h-4 w-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
								</span>
							</button>
						</Tooltip>
						<Tooltip content="Open mini player">
							<button
								className="group inline-flex h-[31px] w-[31px] items-center justify-center rounded-lg border border-transparent bg-transparent text-neutral-700 transition-colors hover:bg-transparent hover:text-primary-hover dark:text-neutral-100 dark:hover:bg-transparent dark:hover:text-primary-hover"
								onClick={onOpenMiniWindow}
								aria-label="Open mini player"
							>
								<span className="relative h-4 w-4">
									<ArrowUpOnSquareStackIcon className="absolute inset-0 h-4 w-4 transition-opacity duration-150 group-hover:opacity-0" />
									<ArrowUpOnSquareStackIconSolid className="absolute inset-0 h-4 w-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
								</span>
							</button>
						</Tooltip>
					</div>
				) : (
					<Tooltip
						content="Start recording"
						disabled={!canStartRecording}
					>
						<button
							className="recording-trigger group inline-flex h-[31px] w-[31px] items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-700 transition hover:border-primary-hover hover:bg-primary-hover hover:text-neutral-0 dark:border-neutral-600 dark:bg-neutral-700/80 dark:text-neutral-100"
							onClick={onStartSession}
							disabled={!canStartRecording}
							aria-label="Start recording"
						>
							<span className="relative h-5 w-5">
								<PlayCircleIcon className="absolute inset-0 h-5 w-5 transition-opacity duration-150 group-hover:opacity-0" />
								<PlayCircleIconSolid className="absolute inset-0 h-5 w-5 opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
							</span>
						</button>
					</Tooltip>
				)}
			</div>
		</header>
	);
}
