"use client";

import clsx from "clsx";
import { HistoryIcon } from "lucide-react";

interface RememberDevicesToggleProps {
	enabled: boolean;
	disabled?: boolean;
	onToggle: (enabled: boolean) => void;
}

// Inline launcher toggle (moved out of the settings cog): auto-restore the camera + mic you used last time.
// Matches SystemAudioToggle's compact row + On/Off pill so it sits naturally among the other launcher controls.
export const RememberDevicesToggle = ({
	enabled,
	disabled = false,
	onToggle,
}: RememberDevicesToggleProps) => {
	return (
		<div className="flex flex-col gap-[0.25rem] items-stretch text-gray-12">
			<button
				type="button"
				disabled={disabled}
				onClick={() => onToggle(!enabled)}
				className={clsx(
					"relative flex flex-row items-center h-[2rem] px-[0.375rem] gap-[0.375rem] border border-gray-3 rounded-lg w-full transition-colors overflow-hidden font-normal text-[0.875rem] text-gray-12 disabled:text-gray-11",
					disabled ? "cursor-default" : "cursor-pointer hover:bg-gray-3/50",
				)}
			>
				<HistoryIcon className="size-4 text-gray-11 shrink-0" />
				<span className="flex-1 text-left truncate">Remember my devices</span>
				<span
					className={clsx(
						"px-[0.375rem] h-[1.25rem] min-w-[2.5rem] rounded-full text-[0.75rem] leading-[1.25rem] flex items-center justify-center font-normal transition-colors duration-200",
						enabled
							? "bg-[var(--blue-3)] text-[var(--blue-11)] dark:bg-[var(--blue-4)] dark:text-[var(--blue-12)]"
							: "bg-[var(--red-3)] text-[var(--red-11)] dark:bg-[var(--red-4)] dark:text-[var(--red-12)]",
					)}
				>
					{enabled ? "On" : "Off"}
				</span>
			</button>
			<p className="text-[0.6875rem] leading-snug text-gray-10 px-[0.375rem]">
				Auto-select the camera and mic you used last time.
			</p>
		</div>
	);
};
