import type { AtlasView } from "../types";
import type { ComponentType, SVGProps } from "react";

export type AtlasIcon = ComponentType<SVGProps<SVGSVGElement>>;

export type AtlasNavItem = {
	id: AtlasView;
	label: string;
	outlineIcon: AtlasIcon;
	solidIcon: AtlasIcon;
};
