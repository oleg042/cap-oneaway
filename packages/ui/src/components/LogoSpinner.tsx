// Tape loading indicator: a pulsing orange dot (a solid core with a radiating ring), replacing
// Cap's rotating logo. Callers pass a width + `animate-spin` + margins; we keep the sizing and
// margins, drop the spin (we pulse, not rotate), and force a square box so `h-auto` widths still
// render a visible dot. Used across the editor, player, and every loading state.
export const LogoSpinner = ({ className }: { className: string }) => {
	const sizing = (className || "")
		.replace(/\banimate-spin\b/g, "")
		.replace(/\bh-auto\b/g, "")
		.trim();
	return (
		<span
			className={`relative inline-flex aspect-square items-center justify-center ${sizing}`}
			role="status"
			aria-label="Loading"
		>
			<span
				className="absolute h-3/5 w-3/5 animate-ping rounded-full opacity-60"
				style={{ background: "#FD4F03" }}
				aria-hidden
			/>
			<span
				className="relative h-3/5 w-3/5 rounded-full"
				style={{ background: "#FD4F03" }}
				aria-hidden
			/>
		</span>
	);
};
