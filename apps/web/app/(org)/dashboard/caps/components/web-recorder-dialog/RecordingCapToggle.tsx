"use client";

import clsx from "clsx";
import { TimerIcon } from "lucide-react";

interface RecordingCapToggleProps {
	// true → the default 20-min cap is lifted (record up to the 45-min hard max).
	overridden: boolean;
	disabled?: boolean;
	onToggle: (overridden: boolean) => void;
}

// Duration guardrail for the recorder. Recordings auto-stop at 20 min by default so a session someone
// launches and forgets (the recorder tab is hidden the whole time you're recording, so nothing on screen
// reminds you) can't run forever. Flipping this on lets a deliberate long walkthrough run up to the 45-min
// hard ceiling — which nothing can cross. Purely a launch-time choice; locked once recording starts.
export const RecordingCapToggle = ({
	overridden,
	disabled = false,
	onToggle,
}: RecordingCapToggleProps) => {
	return (
		<div className="flex flex-col gap-[0.25rem] items-stretch text-gray-12">
			<button
				type="button"
				disabled={disabled}
				onClick={() => onToggle(!overridden)}
				className={clsx(
					"relative flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border border-gray-3 rounded-lg w-full transition-colors overflow-hidden font-normal text-[0.875rem] text-gray-12 disabled:text-gray-11",
					disabled ? "cursor-default" : "cursor-pointer hover:bg-gray-3/50",
				)}
			>
				<TimerIcon className="size-4 text-gray-11 shrink-0" />
				<span className="flex-1 text-left truncate">Record past 20 min</span>
				<span
					className={clsx(
						"px-[0.375rem] h-[1.25rem] min-w-[2.5rem] rounded-full text-[0.75rem] leading-[1.25rem] flex items-center justify-center font-normal transition-colors duration-200",
						overridden
							? "bg-[var(--blue-3)] text-[var(--blue-11)] dark:bg-[var(--blue-4)] dark:text-[var(--blue-12)]"
							: "bg-gray-4 text-gray-11",
					)}
				>
					{overridden ? "On" : "Off"}
				</span>
			</button>
			<p className="text-[0.6875rem] leading-snug text-gray-10 px-[0.375rem]">
				{overridden
					? "Auto-stops at the 45-min maximum."
					: "Auto-stops at 20 min so a forgotten recording can't run forever."}
			</p>
		</div>
	);
};
