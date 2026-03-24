import {
	cloneElement,
	isValidElement,
	useId,
	useState,
	type HTMLAttributes,
	type FocusEvent,
	type MouseEvent,
	type ReactElement,
} from "react";
import { createPortal } from "react-dom";

type TooltipProps = {
	content: string;
	children: ReactElement;
	disabled?: boolean;
	side?: "top" | "right";
};

type TooltipAnchor = {
	x: number;
	y: number;
};

type TooltipChildProps = HTMLAttributes<HTMLElement> & {
	className?: string;
	"aria-describedby"?: string;
};

const getAnchorFromTarget = (target: EventTarget | null, side: "top" | "right"): TooltipAnchor | null => {
	if (!(target instanceof HTMLElement)) {
		return null;
	}
	const rect = target.getBoundingClientRect();
	if (side === "right") {
		return {
			x: rect.right,
			y: rect.top + rect.height / 2,
		};
	}
	return {
		x: rect.left + rect.width / 2,
		y: rect.top,
	};
};

export function Tooltip({ content, children, disabled = false, side = "top" }: TooltipProps) {
	const tooltipId = useId();
	const [isOpen, setIsOpen] = useState(false);
	const [anchor, setAnchor] = useState<TooltipAnchor | null>(null);

	if (disabled || !content.trim()) {
		return children;
	}

	if (!isValidElement<TooltipChildProps>(children)) {
		return children;
	}

	const child = children as ReactElement<TooltipChildProps>;

	const onMouseEnter = (event: MouseEvent<HTMLElement>) => {
		child.props.onMouseEnter?.(event);
		const nextAnchor = getAnchorFromTarget(event.currentTarget, side);
		if (!nextAnchor) {
			return;
		}
		setAnchor(nextAnchor);
		setIsOpen(true);
	};

	const onMouseMove = (event: MouseEvent<HTMLElement>) => {
		child.props.onMouseMove?.(event);
		const nextAnchor = getAnchorFromTarget(event.currentTarget, side);
		if (nextAnchor) {
			setAnchor(nextAnchor);
		}
	};

	const onMouseLeave = (event: MouseEvent<HTMLElement>) => {
		child.props.onMouseLeave?.(event);
		setIsOpen(false);
	};

	const onFocus = (event: FocusEvent<HTMLElement>) => {
		child.props.onFocus?.(event);
		const nextAnchor = getAnchorFromTarget(event.currentTarget, side);
		if (!nextAnchor) {
			return;
		}
		setAnchor(nextAnchor);
		setIsOpen(true);
	};

	const onBlur = (event: FocusEvent<HTMLElement>) => {
		child.props.onBlur?.(event);
		setIsOpen(false);
	};

	const target = cloneElement(child, {
		onMouseEnter,
		onMouseMove,
		onMouseLeave,
		onFocus,
		onBlur,
		"aria-describedby": isOpen ? tooltipId : child.props["aria-describedby"],
	});

	const tooltip =
		isOpen && anchor && typeof document !== "undefined"
			? createPortal(
					<div
						id={tooltipId}
						role="tooltip"
						className="atlas-tooltip-bubble"
						data-side={side}
						style={{
							left: `${anchor.x}px`,
							top: `${anchor.y}px`,
						}}
					>
						{content}
					</div>,
					document.body,
				)
			: null;

	return (
		<>
			{target}
			{tooltip}
		</>
	);
}
