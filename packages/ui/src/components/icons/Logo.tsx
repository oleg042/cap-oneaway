export const Logo = ({
	className,
	showVersion,
	showBeta,
	white,
	hideLogoName,
	viewBoxDimensions = "0 0 120 40",
	style,
}: {
	className?: string;
	showVersion?: boolean;
	showBeta?: boolean;
	white?: boolean;
	hideLogoName?: boolean;
	style?: React.CSSProperties;
	viewBoxDimensions?: `${string} ${string} ${string} ${string}`;
}) => {
	return (
		<div className="flex items-center">
			{/* OneAway "Tape" wordmark (was the Cap logo): orange record dot + "tape". Scales via className,
			    honors `white` (on dark grounds) and `hideLogoName`. */}
			<svg
				viewBox={viewBoxDimensions}
				xmlns="http://www.w3.org/2000/svg"
				preserveAspectRatio="xMidYMid meet"
				fill="none"
				style={style}
				aria-label="Tape Logo"
				className={className}
			>
				<circle cx="20" cy="20" r="13" fill="#FD4F03" />
				{!hideLogoName && (
					<text
						x="42"
						y="29"
						fontFamily="inherit"
						fontSize="27"
						fontWeight="600"
						letterSpacing="-1"
						fill={white ? "#ffffff" : "#12161F"}
					>
						tape
					</text>
				)}
			</svg>
			{showVersion && (
				<span
					className={`text-[10px] font-medium ${
						white ? "text-white" : "text-gray-1"
					}`}
				>
					v{process.env.appVersion}
				</span>
			)}
			{showBeta && (
				<span
					className={`text-[10px] font-medium min-w-[52px] ${
						white ? "text-white" : "text-gray-1"
					}`}
				>
					Beta v{process.env.appVersion}
				</span>
			)}
		</div>
	);
};
