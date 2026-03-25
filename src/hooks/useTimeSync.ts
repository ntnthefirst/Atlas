import { useEffect } from "react";

export const useTimeSync = ({ setNow }: { setNow: (now: number) => void }) => {
	useEffect(() => {
		let timeoutId: number | null = null;
		let intervalId: number | null = null;

		const tick = () => {
			setNow(Date.now());
		};

		const alignToSecondBoundary = () => {
			tick();
			const msUntilNextSecond = 1000 - (Date.now() % 1000);
			timeoutId = window.setTimeout(() => {
				tick();
				intervalId = window.setInterval(tick, 1000);
			}, msUntilNextSecond);
		};

		alignToSecondBoundary();

		return () => {
			if (timeoutId !== null) {
				window.clearTimeout(timeoutId);
			}
			if (intervalId !== null) {
				window.clearInterval(intervalId);
			}
		};
	}, [setNow]);
};
