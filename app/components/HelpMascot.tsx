// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The help button's character. One SVG, animated in CSS (help-widget.css): it bobs while idle, blinks,
 * and its antenna pulses faster while it is thinking. The name lives here too so the chat copy always
 * matches the face.
 */

export const MASCOT_NAME = "Pip";

const T = "#65EBE0";
const TD = "#499B8F";
const DK = "#0b0c10";
const W = "#f3f4f7";
const CH = "#ed8a77";

export default function HelpMascot({ size = 40, thinking = false }: { size?: number; thinking?: boolean }) {
  return (
    <svg className={`mascot ${thinking ? "thinking" : ""}`} width={size} height={size} style={{ width: size, height: size }} viewBox="0 0 120 120" aria-hidden="true">
      <g className="mascot-bob">
        <line x1="60" y1="30" x2="60" y2="14" stroke={TD} strokeWidth="3" />
        <circle className="mascot-antenna" cx="60" cy="12" r="5" fill={T} />
        <path d="M20 78 C20 42 40 30 60 30 C80 30 100 42 100 78 C100 98 84 104 60 104 C36 104 20 98 20 78z" fill={T} />
        <g className="mascot-eyes">
          <circle cx="46" cy="66" r="8" fill={W} />
          <circle cx="74" cy="66" r="8" fill={W} />
          <circle className="mascot-pupil" cx="47.6" cy="67.2" r="4.4" fill={DK} />
          <circle className="mascot-pupil" cx="75.6" cy="67.2" r="4.4" fill={DK} />
          <circle cx="49.6" cy="63.6" r="1.6" fill={W} />
          <circle cx="77.6" cy="63.6" r="1.6" fill={W} />
        </g>
        <circle cx="36" cy="80" r="4" fill={CH} opacity=".55" />
        <circle cx="84" cy="80" r="4" fill={CH} opacity=".55" />
        <path className="mascot-mouth" d="M53 82 q7 5.6 14 0" stroke={DK} strokeWidth="3" fill="none" strokeLinecap="round" />
      </g>
    </svg>
  );
}
