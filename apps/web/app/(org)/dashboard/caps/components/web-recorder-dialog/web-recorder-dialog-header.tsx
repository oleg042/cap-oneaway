"use client";

import clsx from "clsx";

interface WebRecorderDialogHeaderProps {
	isBusy: boolean;
	onClose: () => void;
}

export const WebRecorderDialogHeader = ({
	isBusy,
	onClose,
}: WebRecorderDialogHeaderProps) => {
	return (
		<>
			<div className="absolute left-3 top-3 flex gap-1.5 items-center">
				<button
					type="button"
					onClick={onClose}
					disabled={isBusy}
					className={clsx(
						"size-3 rounded-full bg-[#FF5F57] border-none p-0",
						isBusy
							? "opacity-50 cursor-not-allowed"
							: "cursor-pointer hover:opacity-80 transition-opacity",
					)}
					aria-label="Close dialog"
				/>
				<div className="size-3 rounded-full bg-gray-8 opacity-50"></div>
				<div className="size-3 rounded-full bg-gray-8 opacity-50"></div>
			</div>
			<div className="flex items-center justify-between pb-[0.25rem]">
				<div className="flex items-center space-x-1">
					{/* OneAway Tape mark (was the Cap logo) — renders in both light + dark. */}
					<span className="inline-flex items-center gap-1.5">
						<span
							className="inline-block w-3.5 h-3.5 rounded-full"
							style={{ background: "#FD4F03" }}
							aria-hidden="true"
						/>
						<span className="text-[15px] font-semibold lowercase tracking-tight text-gray-12">
							tape
						</span>
						<span className="text-[11px] text-gray-9">by OneAway</span>
					</span>
				</div>
			</div>
		</>
	);
};
