// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The help button's character: Scout the axolotl. One SVG, animated in CSS (help-widget.css): it bobs
 * while idle, blinks, and its gill frills sway, faster while it is thinking. The name lives here too so the chat copy always
 * matches the face.
 */

export const MASCOT_NAME = "Scout";

const T = "#65EBE0";
const TD = "#499B8F";
const DK = "#0b0c10";
const W = "#f3f4f7";
const CH = "#ed8a77";

const FRILLS: Array<[number, number, number]> = [
  [16, 52, -30], [13, 66, 0], [16, 80, 30],
  [104, 52, 30], [107, 66, 0], [104, 80, -30],
];

export default function HelpMascot({ size = 40, thinking = false }: { size?: number; thinking?: boolean }) {
  return (
    <svg className={`mascot ${thinking ? "thinking" : ""}`} width={size} height={size} style={{ width: size, height: size }} viewBox="0 0 120 120" aria-hidden="true">
      <g className="mascot-bob">
        <g className="mascot-frills">
          {FRILLS.map(([cx, cy, angle]) => (
            <ellipse key={`${cx}-${cy}`} cx={cx} cy={cy} rx="12" ry="4.6" fill={TD} transform={`rotate(${angle} ${cx} ${cy})`} />
          ))}
        </g>
        <path d="M20 78 C20 42 40 30 60 30 C80 30 100 42 100 78 C100 98 84 104 60 104 C36 104 20 98 20 78z" fill={T} />
        <g className="mascot-eyes">
          <circle cx="44" cy="64" r="8" fill={W} />
          <circle cx="76" cy="64" r="8" fill={W} />
          <circle className="mascot-pupil" cx="45.6" cy="65.2" r="4.4" fill={DK} />
          <circle className="mascot-pupil" cx="77.6" cy="65.2" r="4.4" fill={DK} />
          <circle cx="47.6" cy="61.6" r="1.6" fill={W} />
          <circle cx="79.6" cy="61.6" r="1.6" fill={W} />
        </g>
        <circle cx="36" cy="78" r="4" fill={CH} opacity=".55" />
        <circle cx="84" cy="78" r="4" fill={CH} opacity=".55" />
        <path className="mascot-mouth" d="M46 80 q14 10 28 0" stroke={DK} strokeWidth="3" fill="none" strokeLinecap="round" />
      </g>
    </svg>
  );
}
