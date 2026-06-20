import {
	AcademicCapIcon,
	BeakerIcon,
	BoltIcon,
	BriefcaseIcon,
	CameraIcon,
	ChartBarIcon,
	CodeBracketIcon,
	CommandLineIcon,
	FilmIcon,
	FireIcon,
	GlobeAltIcon,
	HeartIcon,
	MusicalNoteIcon,
	PaintBrushIcon,
	PencilSquareIcon,
	PuzzlePieceIcon,
	RocketLaunchIcon,
	Squares2X2Icon,
} from "@heroicons/react/24/outline";
import type { AtlasIcon } from "./components/atlas-layout.types";

// Registry mapping a stable string key (stored in the DB) to an icon component.
export const ENVIRONMENT_ICONS: Record<string, AtlasIcon> = {
	"squares-2x2": Squares2X2Icon,
	briefcase: BriefcaseIcon,
	"code-bracket": CodeBracketIcon,
	"command-line": CommandLineIcon,
	"puzzle-piece": PuzzlePieceIcon,
	film: FilmIcon,
	"academic-cap": AcademicCapIcon,
	"paint-brush": PaintBrushIcon,
	"pencil-square": PencilSquareIcon,
	"musical-note": MusicalNoteIcon,
	camera: CameraIcon,
	"rocket-launch": RocketLaunchIcon,
	beaker: BeakerIcon,
	"chart-bar": ChartBarIcon,
	bolt: BoltIcon,
	fire: FireIcon,
	heart: HeartIcon,
	"globe-alt": GlobeAltIcon,
};

export const ENVIRONMENT_ICON_KEYS = Object.keys(ENVIRONMENT_ICONS);

export const DEFAULT_ENVIRONMENT_ICON = "squares-2x2";

export const getEnvironmentIcon = (key?: string | null): AtlasIcon =>
	(key && ENVIRONMENT_ICONS[key]) || ENVIRONMENT_ICONS[DEFAULT_ENVIRONMENT_ICON];

export type EnvironmentPresetTemplate = {
	id: string;
	name: string;
	icon: string;
	accent: string;
	description: string;
};

// Starter templates the user can spawn an environment from. Each carries its own
// icon + accent so switching environments instantly changes the whole vibe.
export const ENVIRONMENT_PRESETS: EnvironmentPresetTemplate[] = [
	{ id: "work", name: "Work", icon: "briefcase", accent: "#3b82f6", description: "Focused work sessions" },
	{ id: "coding", name: "Coding", icon: "code-bracket", accent: "#7d53de", description: "Build and ship code" },
	{ id: "gaming", name: "Gaming", icon: "puzzle-piece", accent: "#f43f5e", description: "Play and unwind" },
	{ id: "montage", name: "Montage", icon: "film", accent: "#f59e0b", description: "Edit video and media" },
	{ id: "study", name: "Study", icon: "academic-cap", accent: "#10b981", description: "Learn and revise" },
	{ id: "design", name: "Design", icon: "paint-brush", accent: "#ec4899", description: "Craft and create" },
	{ id: "writing", name: "Writing", icon: "pencil-square", accent: "#0ea5e9", description: "Write and draft" },
];

export const getPresetById = (id?: string | null): EnvironmentPresetTemplate | undefined =>
	ENVIRONMENT_PRESETS.find((preset) => preset.id === id);
